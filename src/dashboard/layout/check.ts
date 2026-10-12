import { GridColumnCount, type LayoutGraph, type LayoutItem, type LayoutRect } from "./graph";

export type LayoutIssueCode =
  | "invalid-rect"
  | "missing-layout"
  | "out-of-bounds"
  | "overlap"
  | "duplicate-panel-id"
  | "missing-element"
  | "duplicate-reference"
  | "orphan-element"
  | "unknown-layout-kind"
  | "legacy-rows"
  | "row-order-mismatch"
  | "ignored-row-panels";

export type LayoutIssue = {
  severity: "error" | "warning";
  code: LayoutIssueCode;
  message: string;
  key?: string;
  otherKey?: string;
  container?: string;
  path?: string;
};

export type LayoutCheckResult = {
  format: "classic" | "v2";
  title: string;
  uid?: string;
  panels: number;
  issues: LayoutIssue[];
};

export function formatRect(rect: LayoutRect | undefined): string {
  if (!rect) return "auto";
  return `x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h}`;
}

export function describeItem(item: LayoutItem): string {
  const id = item.elementName ?? (item.panelId !== undefined ? `id=${item.panelId}` : item.path);
  const title = item.title ? ` "${item.title}"` : "";
  return `${item.isRow ? "row " : ""}${id}${title}`;
}

function rectValid(rect: LayoutRect): boolean {
  return [rect.x, rect.y, rect.w, rect.h].every((value) => Number.isInteger(value));
}

export function rectsOverlap(a: LayoutRect, b: LayoutRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function checkGeometry(graph: LayoutGraph, issues: LayoutIssue[]) {
  const byScope = new Map<string, LayoutItem[]>();
  for (const item of graph.items) {
    const rect = item.rect;
    if (!rect) {
      if (graph.format === "classic") {
        issues.push({
          severity: "error",
          code: "invalid-rect",
          message: `${describeItem(item)} has no gridPos`,
          key: item.key,
          container: item.container,
          path: item.path,
        });
      }
      continue;
    }
    if (!rectValid(rect)) {
      issues.push({
        severity: "error",
        code: "invalid-rect",
        message: `${describeItem(item)} has non-integer or missing coordinates (${formatRect(rect)})`,
        key: item.key,
        container: item.container,
        path: item.path,
      });
      continue;
    }
    if (rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 || rect.x + rect.w > GridColumnCount) {
      issues.push({
        severity: "error",
        code: "out-of-bounds",
        message: `${describeItem(item)} is outside the ${GridColumnCount}-column grid (${formatRect(rect)})`,
        key: item.key,
        container: item.container,
        path: item.path,
      });
    }
    const list = byScope.get(item.scope) || [];
    list.push(item);
    byScope.set(item.scope, list);
  }

  for (const items of byScope.values()) {
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i] as LayoutItem;
        const b = items[j] as LayoutItem;
        if (!a.rect || !b.rect || !rectsOverlap(a.rect, b.rect)) continue;
        issues.push({
          severity: "error",
          code: "overlap",
          message: `${describeItem(b)} (${formatRect(b.rect)}) overlaps ${describeItem(a)} (${formatRect(a.rect)})`,
          key: b.key,
          otherKey: a.key,
          container: b.container || a.container,
          path: b.path,
        });
      }
    }
  }
}

function checkIdentity(graph: LayoutGraph, issues: LayoutIssue[]) {
  const ids = new Map<number, string[]>();
  const record = (id: number | undefined, label: string) => {
    if (id === undefined) return;
    ids.set(id, [...(ids.get(id) || []), label]);
  };
  if (graph.format === "classic") {
    for (const item of graph.items) record(item.panelId, item.path);
  } else {
    for (const [name, id] of graph.elementPanelIds) record(id, name);
  }
  for (const [id, labels] of ids) {
    if (labels.length < 2) continue;
    issues.push({
      severity: "error",
      code: "duplicate-panel-id",
      message: `panel id ${id} is used ${labels.length} times (${labels.join(", ")}); --panel-id/DASH/PANEL selectors become ambiguous`,
      key: `panel:${id}`,
    });
  }

  if (graph.format !== "v2") return;
  const known = new Set(graph.elementNames);
  const refs = new Map<string, LayoutItem[]>();
  for (const item of graph.items) {
    if (!item.elementName || !known.has(item.elementName)) {
      issues.push({
        severity: "error",
        code: "missing-element",
        message: `layout references "${item.elementName ?? "(no name)"}" which is not in spec.elements`,
        key: item.key,
        container: item.container,
        path: item.path,
      });
      continue;
    }
    refs.set(item.elementName, [...(refs.get(item.elementName) || []), item]);
  }
  for (const [name, items] of refs) {
    if (items.length < 2) continue;
    issues.push({
      severity: "error",
      code: "duplicate-reference",
      message: `element "${name}" is placed ${items.length} times (${items.map((item) => item.container || "(root)").join(", ")})`,
      key: `element:${name}`,
    });
  }
  const partial = graph.unknownKinds.length > 0;
  for (const name of graph.elementNames) {
    if (refs.has(name)) continue;
    issues.push({
      severity: partial ? "warning" : "error",
      code: "orphan-element",
      message: `element "${name}" is defined in spec.elements but not placed in any ${partial ? "understood " : ""}layout (invisible)`,
      key: `element:${name}`,
      path: `$.spec.elements["${name}"]`,
    });
  }
}

/** Static layout lint. Pure; does not contact Grafana. */
export function checkLayout(graph: LayoutGraph): LayoutCheckResult {
  const issues: LayoutIssue[] = [];
  if (graph.legacyRows) {
    issues.push({
      severity: "warning",
      code: "legacy-rows",
      message: "legacy schema `rows[]` layout (schemaVersion < 16) is not checked",
    });
  }
  for (const path of graph.missingLayouts) {
    issues.push({
      severity: "error",
      code: "missing-layout",
      message: "layout is missing or has no kind; panels placed here are not rendered",
      path,
    });
  }
  for (const unknown of graph.unknownKinds) {
    issues.push({
      severity: "warning",
      code: "unknown-layout-kind",
      message: `layout kind "${unknown.kind}" is not understood by this CLI version; its children were not checked`,
      path: unknown.path,
    });
  }
  for (const note of graph.notes) {
    issues.push({
      severity: "warning",
      code: note.code,
      message: note.message,
      key: note.key,
      path: note.path,
    });
  }
  checkGeometry(graph, issues);
  checkIdentity(graph, issues);
  return {
    format: graph.format,
    title: graph.title,
    uid: graph.uid,
    panels: graph.items.filter((item) => !item.isRow).length,
    issues,
  };
}
