import { describe, expect, it } from "vitest";
import { checkLayout } from "./check";
import { diffLayout } from "./diff";
import { compactVertical, detectIndent, fixLayout, unsafeFix } from "./fix";
import { buildLayoutGraph } from "./graph";

type Panel = Record<string, unknown> & {
  id: number;
  gridPos: { x: number; y: number; w: number; h: number };
};
const p = (
  id: number,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Record<string, unknown> = {},
): Panel => ({
  id,
  type: "timeseries",
  title: `P${id}`,
  gridPos: { x, y, w, h },
  ...extra,
});
const row = (id: number, y: number, extra: Record<string, unknown> = {}): Panel =>
  p(id, 0, y, 24, 1, { type: "row", title: `R${id}`, collapsed: false, panels: [], ...extra });
const classic = (panels: Panel[]) => ({ uid: "u", title: "T", dashboard: { uid: "u", title: "T", panels } });
const byId = (doc: ReturnType<typeof classic>) =>
  new Map((doc.dashboard.panels as Panel[]).map((panel) => [panel.id, panel.gridPos]));
const errors = (doc: unknown) =>
  checkLayout(buildLayoutGraph(doc) as never).issues.filter((issue) => issue.severity === "error");

describe("compactVertical (react-grid-layout 1.5.3 port)", () => {
  it("pushes overlapping items down and closes gaps", () => {
    const out = compactVertical([
      { key: "a", x: 0, y: 0, w: 12, h: 4 },
      { key: "b", x: 0, y: 2, w: 12, h: 4 },
      { key: "c", x: 12, y: 10, w: 12, h: 4 },
    ]);
    expect(out.get("b")).toMatchObject({ y: 4 });
    expect(out.get("c")).toMatchObject({ y: 0 });
  });

  it("renders negative y at 0 and keeps later items below it", () => {
    const out = compactVertical([
      { key: "note", x: 0, y: -1, w: 24, h: 7 },
      { key: "stat", x: 0, y: 0, w: 3, h: 4 },
    ]);
    expect(out.get("note")).toMatchObject({ y: 0 });
    expect(out.get("stat")).toMatchObject({ y: 7 });
  });

  it("converges when several items start above the grid (Grafana re-renders until stable)", () => {
    const out = compactVertical([
      { key: "a", x: 0, y: -5, w: 24, h: 2 },
      { key: "b", x: 0, y: -3, w: 24, h: 2 },
    ]);
    expect([out.get("a")?.y, out.get("b")?.y]).toEqual([0, 2]);
  });

  it("cascades pushes through later items", () => {
    const out = compactVertical([
      { key: "a", x: 0, y: 0, w: 24, h: 4 },
      { key: "b", x: 0, y: 1, w: 12, h: 4 },
      { key: "c", x: 0, y: 5, w: 12, h: 4 },
      { key: "d", x: 12, y: 5, w: 12, h: 4 },
    ]);
    expect(["a", "b", "c", "d"].map((key) => out.get(key)?.y)).toEqual([0, 4, 8, 4]);
  });

  it("clamps items that overflow the 24-column grid", () => {
    const out = compactVertical([{ key: "a", x: 20, y: 0, w: 8, h: 2 }]);
    expect(out.get("a")).toMatchObject({ x: 16, w: 8 });
  });
});

describe("fixLayout classic", () => {
  it("does nothing for a clean dashboard, even with gaps", () => {
    const doc = classic([row(1, 0), p(2, 0, 1, 24, 8), row(3, 20), p(4, 0, 30, 24, 8)]);
    const before = structuredClone(doc);
    expect(fixLayout(doc)).toEqual({ changed: false });
    expect(doc).toEqual(before);
  });

  it("resolves an inserted row that overlaps the previous row's panels and shifts what follows", () => {
    // Real-world shape: panels 7/8 left at y=27 while a new row was inserted at y=28.
    const doc = classic([
      row(4, 17),
      p(5, 0, 18, 16, 10),
      p(6, 16, 18, 8, 10),
      row(30, 28),
      p(31, 0, 29, 16, 8),
      p(7, 0, 27, 16, 8),
      p(8, 16, 27, 8, 8),
      row(9, 44),
      p(10, 0, 45, 24, 10),
    ]);
    expect(fixLayout(doc).changed).toBe(true);
    const pos = byId(doc);
    expect(pos.get(7)).toMatchObject({ y: 28 });
    expect(pos.get(30)).toMatchObject({ y: 36 });
    expect(pos.get(31)).toMatchObject({ y: 37 });
    expect(pos.get(9)).toMatchObject({ y: 52 });
    expect(pos.get(10)).toMatchObject({ y: 53 });
    expect(errors(doc)).toEqual([]);
    expect((doc.dashboard.panels as Panel[]).map((panel) => panel.id)).toEqual([
      4, 5, 6, 7, 8, 30, 31, 9, 10,
    ]);
  });

  it("never changes row membership", () => {
    const doc = classic([row(1, 0), p(2, 0, 1, 12, 8), p(3, 6, 1, 12, 8), row(4, 9), p(5, 0, 10, 24, 4)]);
    const before = buildLayoutGraph(structuredClone(doc)) as never;
    fixLayout(doc);
    const diff = diffLayout(before, buildLayoutGraph(doc) as never);
    expect(diff.items.filter((item) => item.change === "reparented")).toEqual([]);
    expect(errors(doc)).toEqual([]);
  });

  it("reorders panels[] when array order disagrees with the row the y places a panel in", () => {
    const doc = classic([p(1, 0, 41, 24, 4, { title: "Notes" }), row(10, 0), p(11, 0, 1, 24, 8)]);
    expect(fixLayout(doc).changed).toBe(true);
    expect((doc.dashboard.panels as Panel[]).map((panel) => panel.id)).toEqual([10, 11, 1]);
    expect(byId(doc).get(1)).toMatchObject({ y: 41 });
    expect(checkLayout(buildLayoutGraph(doc) as never).issues).toEqual([]);
  });

  it("repairs overlaps inside collapsed rows without touching their offset", () => {
    const doc = classic([row(1, 0, { collapsed: true, panels: [p(2, 0, 5, 24, 4), p(3, 0, 6, 24, 4)] })]);
    fixLayout(doc);
    const children = (doc.dashboard.panels[0] as Panel).panels as Panel[];
    expect(children.map((child) => child.gridPos.y)).toEqual([5, 9]);
  });

  it("skips ambiguous layouts instead of guessing", () => {
    const afterCollapsed = classic([row(1, 0, { collapsed: true }), p(2, 0, 1, 24, 4), p(3, 0, 2, 24, 4)]);
    expect(fixLayout(afterCollapsed).skipped).toContain("collapsed row");
    const withNull = classic([p(1, 0, 4, 24, 4), null as unknown as Panel, p(2, 0, 0, 24, 8)]);
    expect(fixLayout(withNull).skipped).toContain("non-object");
    expect(withNull.dashboard.panels).toHaveLength(3);
    const missing = classic([{ id: 1, type: "text" } as unknown as Panel]);
    expect(fixLayout(missing).skipped).toContain("gridPos");
  });
});

describe("fixLayout classic edge cases", () => {
  const cases: Record<string, () => ReturnType<typeof classic>> = {
    "broken root shifts later rows": () =>
      classic([p(1, 0, 0, 24, 4), p(2, 0, 2, 24, 4), row(3, 4), p(4, 0, 5, 24, 4)]),
    "broken group grows and pushes a collapsed row": () =>
      classic([
        row(1, 0),
        p(2, 0, 1, 24, 4),
        p(3, 0, 2, 24, 4),
        row(4, 5, { collapsed: true, panels: [p(5, 0, 6, 24, 4)] }),
      ]),
    "negative header and duplicate y": () =>
      classic([row(1, -1), p(2, 0, 0, 12, 4), p(3, 0, 0, 12, 4), row(4, 4), p(5, 0, 5, 24, 4)]),
    "two negative panels": () =>
      classic([p(1, 0, -5, 24, 2), p(2, 0, -3, 24, 2), row(3, 1), p(4, 0, 2, 24, 2)]),
  };
  for (const [name, make] of Object.entries(cases)) {
    it(`${name}: no errors, membership kept, idempotent`, () => {
      const doc = make();
      const before = buildLayoutGraph(structuredClone(doc)) as never;
      expect(fixLayout(doc).changed).toBe(true);
      const after = buildLayoutGraph(doc) as never;
      expect(errors(doc)).toEqual([]);
      expect(unsafeFix(before, after)).toBeUndefined();
      const again = structuredClone(doc);
      expect(fixLayout(again).changed).toBe(false);
      expect(again).toEqual(doc);
    });
  }

  it("keeps the collapsed row below the grown group", () => {
    const doc = cases["broken group grows and pushes a collapsed row"]?.() as ReturnType<typeof classic>;
    fixLayout(doc);
    const pos = byId(doc);
    expect(pos.get(3)).toMatchObject({ y: 5 });
    expect(pos.get(4)).toMatchObject({ y: 9 });
    const child = ((doc.dashboard.panels as Panel[]).find((panel) => panel.id === 4)?.panels as Panel[])[0];
    expect(child?.gridPos.y).toBe(6);
  });
});

describe("unsafeFix and detectIndent", () => {
  it("rejects membership changes and leftover geometry errors", () => {
    const a = classic([row(1, 0), p(2, 0, 1, 24, 4), row(3, 5), p(4, 0, 6, 24, 4)]);
    const moved = structuredClone(a);
    (moved.dashboard.panels[3] as Panel).gridPos.y = 2;
    expect(unsafeFix(buildLayoutGraph(a) as never, buildLayoutGraph(moved) as never)).toContain("membership");
    const overlapping = classic([p(1, 0, 0, 24, 4), p(2, 0, 2, 24, 4)]);
    const graph = buildLayoutGraph(overlapping) as never;
    expect(unsafeFix(graph, graph)).toContain("geometry");
  });

  it("allows reordering panels without ids", () => {
    const noIds = classic([p(1, 0, 4, 24, 4), p(2, 0, 0, 24, 4)]).dashboard.panels.map(
      ({ id: _id, ...rest }) => rest,
    );
    const doc = { uid: "u", title: "T", dashboard: { uid: "u", title: "T", panels: noIds } };
    const before = buildLayoutGraph(structuredClone(doc)) as never;
    (doc.dashboard.panels as unknown[]).reverse();
    expect(unsafeFix(before, buildLayoutGraph(doc) as never)).toBeUndefined();
  });

  it("catches id-less panels swapping rows", () => {
    const strip = (doc: ReturnType<typeof classic>) => {
      doc.dashboard.panels = doc.dashboard.panels.map((panel) =>
        panel.type === "row" ? panel : ({ ...panel, id: undefined } as unknown as Panel),
      );
      return doc;
    };
    const a = strip(classic([row(1, 0), p(2, 0, 1, 24, 4), row(3, 5), p(4, 0, 6, 24, 4)]));
    const swapped = structuredClone(a);
    (swapped.dashboard.panels[1] as Panel).title = "P4";
    (swapped.dashboard.panels[3] as Panel).title = "P2";
    expect(unsafeFix(buildLayoutGraph(a) as never, buildLayoutGraph(swapped) as never)).toContain(
      "membership",
    );
  });

  it("preserves the source indentation style", () => {
    expect(detectIndent('{\n    "a": 1\n}')).toBe(4);
    expect(detectIndent('{\n\t"a": 1\n}')).toBe("\t");
    expect(detectIndent('{"a":1}')).toBe(0);
  });
});

describe("fixLayout v2", () => {
  const item = (name: string, x: number, y: number, width: number, height: number) => ({
    kind: "GridLayoutItem",
    spec: { x, y, width, height, element: { kind: "ElementReference", name } },
  });
  const v2 = (items: unknown[]) => ({
    apiVersion: "dashboard.grafana.app/v2beta1",
    kind: "Dashboard",
    metadata: { name: "d" },
    spec: {
      title: "D",
      elements: { a: { kind: "Panel", spec: { id: 1 } }, b: { kind: "Panel", spec: { id: 2 } } },
      layout: {
        kind: "TabsLayout",
        spec: {
          tabs: [
            {
              kind: "TabsLayoutTab",
              spec: { title: "Notes", layout: { kind: "GridLayout", spec: { items } } },
            },
          ],
        },
      },
    },
  });

  it("moves a far negative item back into view", () => {
    const doc = v2([item("a", 0, -208, 24, 6)]);
    expect(fixLayout(doc).changed).toBe(true);
    const items = doc.spec.layout.spec.tabs[0]?.spec.layout.spec.items as Array<{ spec: { y: number } }>;
    expect(items[0]?.spec.y).toBe(0);
  });

  it("re-sorts items of a fixed grid by position", () => {
    const doc = v2([item("b", 0, 2, 24, 4), item("a", 0, 0, 24, 4)]);
    expect(fixLayout(doc).changed).toBe(true);
    const items = doc.spec.layout.spec.tabs[0]?.spec.layout.spec.items as Array<{
      spec: { y: number; element: { name: string } };
    }>;
    expect(items.map((entry) => [entry.spec.element.name, entry.spec.y])).toEqual([
      ["a", 0],
      ["b", 4],
    ]);
  });

  it("leaves a clean grid with a gap untouched", () => {
    const doc = v2([item("a", 0, 0, 24, 6), item("b", 0, 20, 24, 6)]);
    expect(fixLayout(doc)).toEqual({ changed: false, skipped: undefined });
  });
});
