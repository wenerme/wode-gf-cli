import { describe, expect, it } from "vitest";
import { checkLayout } from "./check";
import { diffLayout, layoutFingerprint } from "./diff";
import { buildLayoutGraph } from "./graph";
import { renderLayoutTree } from "./show";

const gridItem = (name: string, x: number, y: number, width: number, height: number) => ({
  kind: "GridLayoutItem",
  spec: { x, y, width, height, element: { kind: "ElementReference", name } },
});
const panel = (id: number, title: string) => ({
  kind: "Panel",
  spec: { id, title, vizConfig: { group: "timeseries" } },
});

function v2(items: unknown[], elements: Record<string, unknown>, rowTitle = "Restarts") {
  return {
    apiVersion: "dashboard.grafana.app/v2beta1",
    kind: "Dashboard",
    metadata: { name: "sample-dash" },
    spec: {
      title: "Sample",
      elements,
      layout: {
        kind: "TabsLayout",
        spec: {
          tabs: [
            {
              kind: "TabsLayoutTab",
              spec: {
                title: "Runtime",
                layout: {
                  kind: "RowsLayout",
                  spec: {
                    rows: [
                      {
                        kind: "RowsLayoutRow",
                        spec: { title: rowTitle, layout: { kind: "GridLayout", spec: { items } } },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
}

function classic(panels: unknown[]) {
  return {
    uid: "c1",
    title: "Classic",
    dashboard: { uid: "c1", title: "Classic", panels },
    __type: "dashboard",
  };
}

const codes = (doc: unknown) => checkLayout(buildLayoutGraph(doc) as never).issues.map((issue) => issue.code);

describe("dashboard layout check", () => {
  it("accepts a clean v2 layout", () => {
    const doc = v2([gridItem("p1", 0, 0, 12, 8), gridItem("p2", 12, 0, 12, 8)], {
      p1: panel(1, "A"),
      p2: panel(2, "B"),
    });
    expect(codes(doc)).toEqual([]);
  });

  it("reports v2 out-of-bounds, overlap, missing, duplicate and orphan elements", () => {
    const doc = v2(
      [
        gridItem("p1", 0, -208, 24, 6),
        gridItem("p2", 0, 0, 12, 8),
        gridItem("p2", 6, 0, 12, 8),
        gridItem("ghost", 18, 0, 8, 4),
      ],
      { p1: panel(1, "A"), p2: panel(2, "B"), p3: panel(2, "C") },
    );
    const found = codes(doc);
    expect(found).toEqual(
      expect.arrayContaining([
        "out-of-bounds",
        "overlap",
        "missing-element",
        "duplicate-reference",
        "orphan-element",
        "duplicate-panel-id",
      ]),
    );
  });

  it("checks classic overlaps against rows and the 24-column grid", () => {
    const doc = classic([
      { id: 5, type: "timeseries", gridPos: { x: 0, y: 18, w: 16, h: 10 } },
      { id: 30, type: "row", title: "Duration", gridPos: { x: 0, y: 28, w: 24, h: 1 } },
      { id: 7, type: "timeseries", gridPos: { x: 0, y: 27, w: 16, h: 8 } },
      { id: 9, type: "stat", gridPos: { x: 20, y: 40, w: 8, h: 4 } },
    ]);
    const issues = checkLayout(buildLayoutGraph(doc) as never).issues;
    const pairs = issues
      .filter((issue) => issue.code === "overlap")
      .map((issue) => [issue.key, issue.otherKey].sort().join("~"))
      .sort();
    expect(pairs).toEqual(["panel:30~panel:7", "panel:5~panel:7"]);
    expect(issues.find((issue) => issue.code === "out-of-bounds")?.key).toBe("panel:9");
  });

  it("scopes collapsed row children separately from the top-level grid", () => {
    const doc = classic([
      { id: 1, type: "timeseries", gridPos: { x: 0, y: 0, w: 24, h: 8 } },
      {
        id: 2,
        type: "row",
        collapsed: true,
        gridPos: { x: 0, y: 8, w: 24, h: 1 },
        panels: [{ id: 3, type: "timeseries", gridPos: { x: 0, y: 0, w: 24, h: 8 } }],
      },
    ]);
    expect(codes(doc)).toEqual([]);
  });

  it("warns on unknown future layout kinds instead of failing", () => {
    const doc = v2([], {});
    (doc.spec.layout as { kind: string }).kind = "MasonryLayout";
    expect(codes(doc)).toEqual(["unknown-layout-kind"]);
  });

  it("treats AutoGridLayout items as placed without coordinates", () => {
    const doc = v2([], { p1: panel(1, "A") });
    doc.spec.layout = {
      kind: "AutoGridLayout",
      spec: {
        items: [{ kind: "AutoGridLayoutItem", spec: { element: { kind: "ElementReference", name: "p1" } } }],
      },
    } as never;
    expect(codes(doc)).toEqual([]);
  });
});

describe("classic row membership follows Grafana sortPanelsByGridPos", () => {
  it("warns when array order and y position disagree on the owning row", () => {
    const doc = classic([
      { id: 1, type: "text", title: "Notes", gridPos: { x: 0, y: 41, w: 24, h: 4 } },
      { id: 10, type: "row", title: "Overview", gridPos: { x: 0, y: 0, w: 24, h: 1 } },
      { id: 11, type: "table", gridPos: { x: 0, y: 1, w: 24, h: 8 } },
    ]);
    const graph = buildLayoutGraph(doc) as never as { items: Array<{ key: string; container: string }> };
    expect(graph.items.find((item) => item.key === "panel:1")?.container).toBe("row:Overview");
    expect(codes(doc)).toEqual(["row-order-mismatch"]);
  });

  it("puts panels after a collapsed row at the root and flags ignored expanded row.panels", () => {
    const doc = classic([
      {
        id: 2,
        type: "row",
        title: "Hidden",
        collapsed: true,
        gridPos: { x: 0, y: 0, w: 24, h: 1 },
        panels: [],
      },
      { id: 3, type: "timeseries", gridPos: { x: 0, y: 1, w: 24, h: 8 } },
      {
        id: 4,
        type: "row",
        title: "Open",
        gridPos: { x: 0, y: 9, w: 24, h: 1 },
        panels: [{ id: 5, type: "stat", gridPos: { x: 0, y: 0, w: 4, h: 4 } }],
      },
    ]);
    const graph = buildLayoutGraph(doc) as never as { items: Array<{ key: string; container: string }> };
    expect(graph.items.find((item) => item.key === "panel:3")?.container).toBe("");
    expect(codes(doc)).toEqual(["ignored-row-panels"]);
  });

  it("keeps duplicate row titles as distinct containers", () => {
    const doc = classic([
      { id: 1, type: "row", title: "Same", gridPos: { x: 0, y: 0, w: 24, h: 1 } },
      { id: 2, type: "stat", gridPos: { x: 0, y: 1, w: 4, h: 4 } },
      { id: 3, type: "row", title: "Same", gridPos: { x: 0, y: 5, w: 24, h: 1 } },
      { id: 4, type: "stat", gridPos: { x: 0, y: 6, w: 4, h: 4 } },
    ]);
    const graph = buildLayoutGraph(doc) as never as { containers: Array<{ container: string }> };
    expect(graph.containers.map((container) => container.container)).toEqual(["row:Same", "row:Same#2"]);
  });
});

describe("dashboard layout diff and fingerprint", () => {
  it("is reflexive even with invalid coordinates", () => {
    const doc = v2(
      [{ kind: "GridLayoutItem", spec: { x: 0, element: { kind: "ElementReference", name: "p1" } } }],
      {
        p1: panel(1, "A"),
      },
    );
    const graph = buildLayoutGraph(doc) as never;
    expect(diffLayout(graph, buildLayoutGraph(structuredClone(doc)) as never).changed).toBe(false);
    expect(codes(doc)).toEqual(["invalid-rect"]);
  });

  it("detects repeat and row option changes", () => {
    const before = v2([gridItem("p1", 0, 0, 24, 8)], { p1: panel(1, "A") });
    const after = structuredClone(before);
    const row = (
      after.spec.layout.spec.tabs[0]?.spec.layout.spec.rows[0] as { spec: Record<string, unknown> }
    ).spec;
    row.collapse = true;
    const diff = diffLayout(buildLayoutGraph(before) as never, buildLayoutGraph(after) as never);
    expect(diff.changed).toBe(true);
    expect(diff.containers.changed).toEqual(["tab:Runtime/row:Restarts"]);
  });
  it("keeps fingerprint stable for query-only edits", () => {
    const before = v2([gridItem("p1", 0, 0, 24, 8)], { p1: panel(1, "A") });
    const after = structuredClone(before);
    (after.spec.elements.p1 as { spec: { title: string } }).spec.title = "Renamed";
    const a = buildLayoutGraph(before) as never;
    const b = buildLayoutGraph(after) as never;
    expect(layoutFingerprint(a)).toBe(layoutFingerprint(b));
    expect(diffLayout(a, b).changed).toBe(false);
  });

  it("reports moved, resized, added and reparented items", () => {
    const before = v2([gridItem("p1", 0, 0, 12, 8), gridItem("p2", 12, 0, 12, 8)], {
      p1: panel(1, "A"),
      p2: panel(2, "B"),
    });
    const after = v2(
      [gridItem("p1", 0, 8, 12, 8), gridItem("p2", 12, 0, 12, 9), gridItem("p3", 0, 16, 24, 8)],
      { p1: panel(1, "A"), p2: panel(2, "B"), p3: panel(3, "C") },
      "Restarts",
    );
    const diff = diffLayout(buildLayoutGraph(before) as never, buildLayoutGraph(after) as never);
    expect(diff.items.map((item) => `${item.change}:${item.key}`)).toEqual([
      "moved:element:p1",
      "resized:element:p2",
      "added:element:p3",
    ]);
    const moved = v2(
      [gridItem("p1", 0, 0, 12, 8), gridItem("p2", 12, 0, 12, 8)],
      {
        p1: panel(1, "A"),
        p2: panel(2, "B"),
      },
      "Other",
    );
    const reparented = diffLayout(buildLayoutGraph(before) as never, buildLayoutGraph(moved) as never);
    expect(reparented.items.map((item) => item.change)).toEqual(["reparented", "reparented"]);
    expect(reparented.containers.added).toEqual(["tab:Runtime/row:Other"]);
  });

  it("renders a tree with containers and coordinates", () => {
    const text = renderLayoutTree(
      buildLayoutGraph(v2([gridItem("p1", 0, 0, 24, 8)], { p1: panel(1, "A") })) as never,
    );
    expect(text).toContain("tab:Runtime");
    expect(text).toContain('- p1 "A"  x=0 y=0 w=24 h=8');
  });
});
