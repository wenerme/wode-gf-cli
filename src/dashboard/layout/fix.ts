import type { JsonObject } from "../../core/json";
import { asObject, asString, getObjectField } from "../../lib/json-narrow";
import { isDashboardResourceV2 } from "../model";
import { checkLayout } from "./check";
import { GridColumnCount, type LayoutGraph } from "./graph";

/**
 * Persist the geometry Grafana actually renders.
 *
 * Grafana (Scenes SceneGridLayout) renders every grid through react-grid-layout 1.5.3 with
 * `compactType: "vertical"`: correctBounds, then sort by (y, x) and compact. Panels therefore
 * never overlap on screen; this module writes those rendered coordinates back so the source
 * stops lying. Membership (which row/tab a panel belongs to) is never changed.
 */
type Cell = { key: string; x: number; y: number; w: number; h: number };

function collides(a: Cell, b: Cell): boolean {
  if (a.key === b.key) return false;
  return !(a.x + a.w <= b.x || a.x >= b.x + b.w || a.y + a.h <= b.y || a.y >= b.y + b.h);
}

function firstCollision(list: Cell[], item: Cell): Cell | undefined {
  return list.find((other) => collides(other, item));
}

// Port of react-grid-layout resolveCompactionCollision (axis "y").
function resolveCollision(sorted: Cell[], item: Cell, moveTo: number) {
  item.y += 1;
  const index = sorted.findIndex((other) => other.key === item.key);
  for (let i = index + 1; i < sorted.length; i += 1) {
    const other = sorted[i] as Cell;
    if (other.y > item.y + item.h) break;
    if (collides(item, other)) resolveCollision(sorted, other, moveTo + item.h);
  }
  item.y = moveTo;
}

/**
 * Rendered layout: Scenes writes RGL's compacted layout back via onLayoutChange and RGL compacts again,
 * so repeat one pass until it stops changing (e.g. two negative-y items both clamp to 0 on pass one).
 */
export function compactVertical(input: Cell[]): Map<string, Cell> {
  let current = input;
  for (let pass = 0; pass < 32; pass += 1) {
    const next = compactOnce(current);
    const stable = current.every((cell) => {
      const out = next.get(cell.key) as Cell;
      return out.x === cell.x && out.y === cell.y && out.w === cell.w && out.h === cell.h;
    });
    if (stable) return next;
    current = current.map((cell) => next.get(cell.key) as Cell);
  }
  throw new Error("grid compaction did not converge");
}

/** One pass of react-grid-layout 1.5.3 correctBounds + compact(vertical). Returns key -> cell. */
function compactOnce(input: Cell[]): Map<string, Cell> {
  const cells = input.map((cell) => ({ ...cell }));
  for (const cell of cells) {
    if (cell.x + cell.w > GridColumnCount) cell.x = GridColumnCount - cell.w;
    if (cell.x < 0) {
      cell.x = 0;
      cell.w = GridColumnCount;
    }
  }
  const sorted = [...cells].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
  const placed: Cell[] = [];
  let bottom = 0;
  for (const source of sorted) {
    const cell = { ...source };
    cell.y = Math.min(bottom, cell.y);
    while (cell.y > 0 && !firstCollision(placed, cell)) cell.y -= 1;
    let hit = firstCollision(placed, cell);
    while (hit) {
      resolveCollision(sorted, cell, hit.y + hit.h);
      hit = firstCollision(placed, cell);
    }
    cell.y = Math.max(cell.y, 0);
    cell.x = Math.max(cell.x, 0);
    bottom = Math.max(bottom, cell.y + cell.h);
    placed.push(cell);
  }
  return new Map(placed.map((cell) => [cell.key, cell]));
}

export type LayoutFixResult = { changed: boolean; skipped?: string };

function cellOf(key: string, x: unknown, y: unknown, w: unknown, h: unknown): Cell | undefined {
  const values = [x, y, w, h];
  if (!values.every((value) => typeof value === "number" && Number.isInteger(value))) return undefined;
  if ((w as number) <= 0 || (h as number) <= 0) return undefined;
  return { key, x: x as number, y: y as number, w: w as number, h: h as number };
}

function geometryBroken(cells: Cell[], above?: Cell, below?: Cell): boolean {
  for (const [i, c] of cells.entries()) {
    if (c.x < 0 || c.y < 0 || c.x + c.w > GridColumnCount) return true;
    if (above && c.y < above.y + above.h) return true;
    if (below && c.y + c.h > below.y) return true;
    if (cells.some((o, j) => j > i && collides(c, o))) return true;
  }
  return false;
}

type ClassicEntry = { panel: JsonObject; index: number; cell: Cell };

/** Row membership as Grafana assigns it when walking `list` (expanded rows own following panels). */
function membershipOf(list: ClassicEntry[]): Map<number, number> {
  const owner = new Map<number, number>();
  let current = -1;
  for (const entry of list) {
    if (asString(entry.panel.type) === "row") current = entry.panel.collapsed === true ? -1 : entry.index;
    else owner.set(entry.index, current);
  }
  return owner;
}

function fixClassic(dashboard: JsonObject): LayoutFixResult {
  if (!Array.isArray(dashboard.panels)) return { changed: false, skipped: "no panels[]" };
  const panels = dashboard.panels.map((value) => asObject(value)).filter((p): p is JsonObject => Boolean(p));
  // Reordering rewrites panels[]; never drop entries we do not understand.
  if (panels.length !== dashboard.panels.length)
    return { changed: false, skipped: "panels[] has non-object entries" };
  const cellFor = (panel: JsonObject, key: string) => {
    const g = asObject(panel.gridPos);
    return g ? cellOf(key, g.x, g.y, g.w, g.h) : undefined;
  };
  const top: ClassicEntry[] = [];
  for (const [index, panel] of panels.entries()) {
    const cell = cellFor(panel, `p${index}`);
    if (!cell) {
      return { changed: false, skipped: "a panel has missing, non-integer or empty gridPos" };
    }
    top.push({ panel, index, cell });
  }
  // DashboardModel.sortPanelsByGridPos: stable sort by y then x decides row membership.
  const sorted = [...top].sort((a, b) => (a.cell.y === b.cell.y ? a.cell.x - b.cell.x : a.cell.y - b.cell.y));
  const arrayOwner = membershipOf(top);
  const gridOwner = membershipOf(sorted);
  const mismatch = [...gridOwner].some(([index, owner]) => arrayOwner.get(index) !== owner);

  type Group = { row?: ClassicEntry; members: ClassicEntry[] };
  const groups: Group[] = [{ members: [] }];
  for (const entry of sorted) {
    if (asString(entry.panel.type) === "row") {
      if (
        entry.panel.collapsed !== true &&
        Array.isArray(entry.panel.panels) &&
        entry.panel.panels.length > 0
      ) {
        return { changed: false, skipped: "an expanded row carries nested panels (renderers disagree)" };
      }
      groups.push({ row: entry, members: [] });
      continue;
    }
    const current = groups.at(-1) as Group;
    if (current.row?.panel.collapsed === true) {
      return { changed: false, skipped: "a top-level panel follows a collapsed row (renderers disagree)" };
    }
    current.members.push(entry);
  }

  let changed = false;
  const setY = (panel: JsonObject, next: Cell) => {
    const g = asObject(panel.gridPos) as JsonObject;
    for (const [field, value] of [
      ["x", next.x],
      ["y", next.y],
      ["w", next.w],
      ["h", next.h],
    ] as const) {
      if (g[field] !== value) {
        g[field] = value;
        changed = true;
      }
    }
  };
  // Only groups with real defects are compacted; everything below shifts uniformly, so gaps
  // elsewhere (which Grafana closes on render anyway) stay untouched and the diff stays small.
  let shift = 0;
  for (const [gi, group] of groups.entries()) {
    const header = group.row?.cell;
    const headerY = header ? header.y + shift : 0;
    if (group.row && header) setY(group.row.panel, { ...header, y: headerY });
    const base = header ? headerY + header.h : 0;
    const nextHeader = groups[gi + 1]?.row?.cell;
    const cells = group.members.map((entry) => entry.cell);
    let bottom = base;
    if (geometryBroken(cells, header, nextHeader)) {
      const compacted = compactVertical(cells);
      for (const entry of group.members) {
        const next = compacted.get(entry.cell.key) as Cell;
        setY(entry.panel, { ...next, y: base + next.y });
        bottom = Math.max(bottom, base + next.y + next.h);
      }
    } else {
      for (const entry of group.members) {
        setY(entry.panel, { ...entry.cell, y: entry.cell.y + shift });
        bottom = Math.max(bottom, entry.cell.y + shift + entry.cell.h);
      }
    }
    if (group.row?.panel.collapsed === true) {
      // Collapsed children are stored, not rendered: only repair real defects inside them.
      const children = (Array.isArray(group.row.panel.panels) ? group.row.panel.panels : [])
        .map((value) => asObject(value))
        .filter((p): p is JsonObject => Boolean(p));
      const childCells = children.map((child, i) => cellFor(child, `c${i}`));
      if (childCells.some((c) => !c))
        return { changed: false, skipped: "a collapsed row child has invalid gridPos" };
      if (geometryBroken(childCells as Cell[])) {
        const offset = Math.max(Math.min(...(childCells as Cell[]).map((c) => c.y)), 0);
        const compacted = compactVertical(childCells as Cell[]);
        children.forEach((child, i) => {
          const next = compacted.get(`c${i}`) as Cell;
          setY(child, { ...next, y: next.y + offset });
        });
      }
    }
    if (nextHeader) shift = Math.max(shift, bottom - nextHeader.y);
  }
  if (!changed && !mismatch) return { changed: false };
  const order = [...top]
    .sort((a, b) => {
      const ga = asObject(a.panel.gridPos) as JsonObject;
      const gb = asObject(b.panel.gridPos) as JsonObject;
      return (ga.y as number) === (gb.y as number)
        ? (ga.x as number) - (gb.x as number)
        : (ga.y as number) - (gb.y as number);
    })
    .map((entry) => entry.panel);
  const reordered = order.some((panel, index) => panels[index] !== panel);
  if (reordered) dashboard.panels = order;
  return { changed: changed || reordered };
}

function fixV2(spec: JsonObject): LayoutFixResult {
  let changed = false;
  let skipped: string | undefined;
  const visit = (layout: unknown) => {
    const node = asObject(layout);
    const nodeSpec = getObjectField(node, "spec");
    if (!node || !nodeSpec) return;
    if (asString(node.kind) === "GridLayout" && Array.isArray(nodeSpec.items)) {
      const items = nodeSpec.items.map((value) => asObject(value));
      const cells = items.map((item, i) => {
        const s = getObjectField(item, "spec");
        return s ? cellOf(`i${i}`, s.x, s.y, s.width, s.height) : undefined;
      });
      if (cells.some((c) => !c)) {
        skipped ??= "a grid item has missing, non-integer or empty coordinates";
        return;
      }
      if (!geometryBroken(cells as Cell[])) return;
      const compacted = compactVertical(cells as Cell[]);
      items.forEach((item, i) => {
        const s = getObjectField(item, "spec") as JsonObject;
        const next = compacted.get(`i${i}`) as Cell;
        for (const [field, value] of [
          ["x", next.x],
          ["y", next.y],
          ["width", next.w],
          ["height", next.h],
        ] as const) {
          if (s[field] !== value) {
            s[field] = value;
            changed = true;
          }
        }
      });
      const order = items
        .map((item, i) => ({ item, cell: compacted.get(`i${i}`) as Cell }))
        .sort((a, b) => (a.cell.y === b.cell.y ? a.cell.x - b.cell.x : a.cell.y - b.cell.y))
        .map((entry) => entry.item);
      if (order.some((item, i) => item !== items[i])) {
        nodeSpec.items = order;
        changed = true;
      }
      return;
    }
    for (const key of ["tabs", "rows"]) {
      if (!Array.isArray(nodeSpec[key])) continue;
      for (const child of nodeSpec[key] as unknown[]) visit(getObjectField(child, "spec")?.layout);
    }
  };
  visit(spec.layout);
  return { changed, skipped };
}

/** Mutates the document in place. Supports classic, classic wrapper, v2 and wrapped v2. */
export function fixLayout(document: unknown): LayoutFixResult {
  const entry = asObject(document);
  if (!entry) return { changed: false, skipped: "not a JSON object" };
  if (isDashboardResourceV2(entry)) return fixV2(getObjectField(entry, "spec") as JsonObject);
  const wrapped = getObjectField(entry, "dashboard");
  if (wrapped && isDashboardResourceV2(wrapped)) return fixV2(getObjectField(wrapped, "spec") as JsonObject);
  return fixClassic(wrapped || entry);
}

/** Geometry-only safety net for `layout fix`: returns a reason to refuse writing, if any. */
export function unsafeFix(before: LayoutGraph, after: LayoutGraph): string | undefined {
  // Membership by panel identity: path-keyed items (no id) legitimately change path when reordered.
  const owners = (graph: LayoutGraph) =>
    graph.items
      .filter((item) => !item.key.startsWith("path:"))
      .map((item) => `${item.key}@${item.container}`)
      .sort()
      .join("|");
  // Id-less items: compare what each container holds by title/type, so a swap between rows is caught.
  const sizes = (graph: LayoutGraph) =>
    graph.items
      .map((item) =>
        item.key.startsWith("path:") ? `${item.container}#${item.type}:${item.title}` : item.container,
      )
      .sort()
      .join("|");
  if (owners(before) !== owners(after) || sizes(before) !== sizes(after)) {
    return "would change panel membership; not written";
  }
  const geometry = new Set(["overlap", "out-of-bounds", "invalid-rect", "row-order-mismatch"]);
  const count = (graph: LayoutGraph) =>
    checkLayout(graph).issues.filter((issue) => geometry.has(issue.code)).length;
  if (count(after) > 0) return `fix left ${count(after)} geometry issue(s); not written`;
  return undefined;
}

export function detectIndent(text: string): number | string {
  const match = text.match(/^[{[]\r?\n([ \t]+)\S/);
  if (!match) return text.includes("\n") ? 2 : 0;
  return match[1]?.startsWith("\t") ? "\t" : (match[1]?.length ?? 2);
}
