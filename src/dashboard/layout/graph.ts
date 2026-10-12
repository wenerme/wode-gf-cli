import type { JsonObject } from "../../core/json";
import { asObject, asString, getObjectField } from "../../lib/json-narrow";
import { isDashboardResourceV2 } from "../model";

/** Grafana grid column count (public/app/core/constants.ts GRID_COLUMN_COUNT). */
export const GridColumnCount = 24;

export type LayoutRect = { x: number; y: number; w: number; h: number };

export type LayoutItem = {
  /** Stable identity: classic `panel:<id>`, v2 `element:<name>`. */
  key: string;
  panelId?: number;
  elementName?: string;
  title?: string;
  type?: string;
  /** Undefined for auto-placed items (v2 AutoGridLayout). Missing fields are NaN. */
  rect?: LayoutRect;
  /** Grid scope that coordinates are relative to. */
  scope: string;
  /** Container path as Grafana renders it, e.g. `tab:Overview/row:Traffic`. */
  container: string;
  /** JSON path of the item in the source document. */
  path: string;
  isRow?: boolean;
  /** Layout-relevant extras (repeat, conditional rendering) as stable JSON. */
  extra?: string;
};

export type LayoutContainer = {
  kind: string;
  title?: string;
  path: string;
  container: string;
  collapsed?: boolean;
  /** Layout-relevant container props (repeat, hideHeader, AutoGrid sizing...) as stable JSON. */
  props?: string;
};

export type LayoutNote = {
  code: "row-order-mismatch" | "ignored-row-panels";
  key?: string;
  path: string;
  message: string;
};

export type LayoutGraph = {
  format: "classic" | "v2";
  title: string;
  uid?: string;
  items: LayoutItem[];
  containers: LayoutContainer[];
  /** v2 only: names in spec.elements. */
  elementNames: string[];
  /** v2 only: element name -> spec.id. */
  elementPanelIds: Map<string, number | undefined>;
  /** v2 layout slots that are absent or not an object (always an error, unlike unknown kinds). */
  missingLayouts: string[];
  /** Layout nodes this CLI does not understand; `signature` keeps them comparable for diff. */
  unknownKinds: Array<{ kind: string; path: string; signature?: string }>;
  legacyRows: boolean;
  notes: LayoutNote[];
};

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rectOf(x: unknown, y: unknown, w: unknown, h: unknown): LayoutRect {
  return {
    x: num(x) ?? Number.NaN,
    y: num(y) ?? Number.NaN,
    w: num(w) ?? Number.NaN,
    h: num(h) ?? Number.NaN,
  };
}

function stable(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    const obj = asObject(input);
    if (!obj) return input;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((key) => [key, sort(obj[key])]),
    );
  };
  return JSON.stringify(sort(value));
}

function pick(obj: JsonObject, omit: string[]): string | undefined {
  const rest = Object.fromEntries(Object.entries(obj).filter(([key]) => !omit.includes(key)));
  return Object.keys(rest).length > 0 ? stable(rest) : undefined;
}

function objectEntries(value: unknown): Array<[number, JsonObject]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index): Array<[number, JsonObject]> => {
    const obj = asObject(item);
    return obj ? [[index, obj]] : [];
  });
}

function emptyGraph(format: "classic" | "v2", title: string, uid: string | undefined): LayoutGraph {
  return {
    format,
    title,
    uid,
    items: [],
    containers: [],
    elementNames: [],
    elementPanelIds: new Map(),
    unknownKinds: [],
    missingLayouts: [],
    legacyRows: false,
    notes: [],
  };
}

function uniqueContainer(graph: LayoutGraph, wanted: string): string {
  if (!graph.containers.some((container) => container.container === wanted)) return wanted;
  let index = 2;
  while (graph.containers.some((container) => container.container === `${wanted}#${index}`)) index += 1;
  return `${wanted}#${index}`;
}

function classicGraph(entry: JsonObject, dashboard: JsonObject, rootPath: string): LayoutGraph {
  const graph = emptyGraph(
    "classic",
    asString(entry.title) || asString(dashboard.title) || "(untitled dashboard)",
    asString(entry.uid) || asString(dashboard.uid),
  );
  graph.legacyRows = Array.isArray(dashboard.rows) && !Array.isArray(dashboard.panels);

  const toItem = (panel: JsonObject, scope: string, container: string, path: string): LayoutItem => {
    const gridPos = asObject(panel.gridPos);
    const id = num(panel.id);
    return {
      key: id === undefined ? `path:${path}` : `panel:${id}`,
      panelId: id,
      title: asString(panel.title),
      type: asString(panel.type),
      rect: gridPos ? rectOf(gridPos.x, gridPos.y, gridPos.w, gridPos.h) : undefined,
      scope,
      container,
      path,
      isRow: asString(panel.type) === "row",
      extra: stable(
        panel.repeat === undefined
          ? undefined
          : { repeat: panel.repeat, dir: panel.repeatDirection, max: panel.maxPerRow },
      ),
    };
  };

  // Grafana (DashboardModel.sortPanelsByGridPos) sorts top-level panels by y then x (stable)
  // BEFORE assigning panels to expanded rows, so membership follows coordinates, not array order.
  const top = objectEntries(dashboard.panels).map(([index, panel]) => ({
    index,
    panel,
    path: `${rootPath}.panels[${index}]`,
    y: num(asObject(panel.gridPos)?.y) ?? 0,
    x: num(asObject(panel.gridPos)?.x) ?? 0,
  }));
  const sorted = [...top].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  const membership = (list: typeof top) => {
    const owner = new Map<number, string>();
    let current = "";
    for (const entry of list) {
      if (asString(entry.panel.type) === "row") {
        current = entry.panel.collapsed === true ? "" : `row@${entry.index}`;
        continue;
      }
      owner.set(entry.index, current);
    }
    return owner;
  };
  const byArray = membership(top);
  const byGrid = membership(sorted);

  const rowLabel = new Map<string, string>();
  for (const entry of sorted) {
    if (asString(entry.panel.type) !== "row") continue;
    const title = asString(entry.panel.title) ?? String(num(entry.panel.id) ?? entry.index);
    const label = uniqueContainer(graph, `row:${title}`);
    rowLabel.set(`row@${entry.index}`, label);
    const collapsed = entry.panel.collapsed === true;
    graph.containers.push({
      kind: "row",
      title: asString(entry.panel.title),
      path: entry.path,
      container: label,
      collapsed,
      props: pick(entry.panel, [
        "id",
        "type",
        "title",
        "gridPos",
        "panels",
        "collapsed",
        "datasource",
        "targets",
      ]),
    });
    graph.items.push(toItem(entry.panel, "top", "", entry.path));
    const children = objectEntries(entry.panel.panels);
    if (collapsed) {
      for (const [childIndex, child] of children) {
        graph.items.push(
          toItem(child, `collapsed:${entry.path}`, label, `${entry.path}.panels[${childIndex}]`),
        );
      }
    } else if (children.length > 0) {
      graph.notes.push({
        code: "ignored-row-panels",
        key: `panel:${num(entry.panel.id)}`,
        path: `${entry.path}.panels`,
        message: `expanded row "${title}" carries ${children.length} nested panels; Grafana ignores row.panels unless the row is collapsed`,
      });
    }
  }

  for (const entry of sorted) {
    if (asString(entry.panel.type) === "row") continue;
    const gridOwner = byGrid.get(entry.index) || "";
    const item = toItem(entry.panel, "top", rowLabel.get(gridOwner) || "", entry.path);
    graph.items.push(item);
    const arrayOwner = byArray.get(entry.index) || "";
    if (arrayOwner !== gridOwner) {
      graph.notes.push({
        code: "row-order-mismatch",
        key: item.key,
        path: entry.path,
        message: `panel ${item.panelId ?? entry.index}${item.title ? ` "${item.title}"` : ""} is listed under ${rowLabel.get(arrayOwner) || "(no row)"} in panels[] but its y places it in ${rowLabel.get(gridOwner) || "(no row)"}; Grafana uses the y position`,
      });
    }
  }
  return graph;
}

function v2Graph(entry: JsonObject, rootPath: string): LayoutGraph {
  const spec = getObjectField(entry, "spec") || {};
  const elements = getObjectField(spec, "elements") || {};
  const metadataName = asString(getObjectField(entry, "metadata")?.name);
  const graph = emptyGraph(
    "v2",
    asString(spec.title) || metadataName || "(untitled dashboard)",
    metadataName || asString(spec.uid),
  );
  graph.elementNames = Object.keys(elements);
  for (const [name, value] of Object.entries(elements)) {
    graph.elementPanelIds.set(name, num(getObjectField(value, "spec")?.id));
  }

  const pushElement = (
    item: JsonObject,
    rect: LayoutRect | undefined,
    scope: string,
    container: string,
    path: string,
  ) => {
    const itemSpec = getObjectField(item, "spec") || {};
    const name = asString(getObjectField(itemSpec, "element")?.name);
    const elementSpec = getObjectField(name ? elements[name] : undefined, "spec");
    const vizConfig = getObjectField(elementSpec, "vizConfig");
    graph.items.push({
      key: name ? `element:${name}` : `path:${path}`,
      elementName: name,
      panelId: num(elementSpec?.id),
      title: asString(elementSpec?.title),
      type: asString(vizConfig?.group) || asString(vizConfig?.kind),
      rect,
      scope,
      container,
      path,
      extra: pick(itemSpec, ["x", "y", "width", "height", "element"]),
    });
  };

  const visit = (layout: unknown, path: string, container: string) => {
    const node = asObject(layout);
    if (!node) {
      graph.missingLayouts.push(path);
      return;
    }
    const kind = asString(node.kind);
    if (!kind) {
      graph.missingLayouts.push(path);
      return;
    }
    const nodeSpec = getObjectField(node, "spec") || {};
    if (kind === "GridLayout" || kind === "AutoGridLayout") {
      if (kind === "AutoGridLayout") {
        graph.containers.push({
          kind: "autogrid",
          path,
          container: uniqueContainer(graph, `${container}#autogrid`),
          props: pick(nodeSpec, ["items"]),
        });
      }
      for (const [index, item] of objectEntries(nodeSpec.items)) {
        const s = getObjectField(item, "spec") || {};
        const rect = kind === "GridLayout" ? rectOf(s.x, s.y, s.width, s.height) : undefined;
        pushElement(item, rect, path, container, `${path}.spec.items[${index}]`);
      }
      return;
    }
    const childKey = kind === "TabsLayout" ? "tabs" : kind === "RowsLayout" ? "rows" : undefined;
    if (!childKey) {
      graph.unknownKinds.push({ kind, path, signature: stable(node) });
      return;
    }
    const label = childKey === "tabs" ? "tab" : "row";
    for (const [index, child] of objectEntries(nodeSpec[childKey])) {
      const childSpec = getObjectField(child, "spec") || {};
      const title = asString(childSpec.title);
      const childPath = `${path}.spec.${childKey}[${index}]`;
      const childContainer = uniqueContainer(
        graph,
        `${container ? `${container}/` : ""}${label}:${title ?? index}`,
      );
      graph.containers.push({
        kind: label,
        title,
        path: childPath,
        container: childContainer,
        collapsed: childSpec.collapse === true,
        props: pick(childSpec, ["title", "layout", "variables", "collapse"]),
      });
      visit(childSpec.layout, `${childPath}.spec.layout`, childContainer);
    }
  };

  visit(spec.layout, `${rootPath}.spec.layout`, "");
  return graph;
}

/** Build a normalized layout graph from a classic dashboard, classic wrapper or v2 resource. */
export function buildLayoutGraph(input: unknown): LayoutGraph | undefined {
  const entry = asObject(input);
  if (!entry) return undefined;
  if (isDashboardResourceV2(entry)) return v2Graph(entry, "$");
  const wrapped = getObjectField(entry, "dashboard");
  if (wrapped && isDashboardResourceV2(wrapped)) return v2Graph(wrapped, "$.dashboard");
  const dashboard = wrapped || entry;
  if (!Array.isArray(dashboard.panels) && !Array.isArray(dashboard.rows)) return undefined;
  return classicGraph(entry, dashboard, wrapped ? "$.dashboard" : "$");
}
