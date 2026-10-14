import { describe, expect, it } from "vitest";
import { diffJson, formatJsonChanges } from "./json-diff";

describe("diffJson", () => {
  it("reports nothing for equal documents", () => {
    expect(diffJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
  });

  it("keys arrays by id so an insert is one change, not a cascade", () => {
    const before = {
      panels: [
        { id: 1, title: "a" },
        { id: 2, title: "b" },
      ],
    };
    const after = {
      panels: [
        { id: 1, title: "a" },
        { id: 9, title: "new" },
        { id: 2, title: "b" },
      ],
    };
    expect(diffJson(before, after)).toEqual([
      { path: "$.panels[?(@.id==9)]", kind: "added", after: { id: 9, title: "new" } },
    ]);
  });

  it("uses refId and string identities with quoted paths", () => {
    const changes = diffJson(
      { data: [{ refId: "A", expr: "up" }, { refId: "B" }] },
      { data: [{ refId: "A", expr: "up == 1" }, { refId: "B" }] },
    );
    expect(changes).toEqual([
      { path: '$.data[?(@.refId=="A")].expr', kind: "changed", before: "up", after: "up == 1" },
    ]);
  });

  it("reports pure reordering of keyed items", () => {
    const changes = diffJson({ p: [{ id: 1 }, { id: 2 }] }, { p: [{ id: 2 }, { id: 1 }] });
    expect(changes).toEqual([{ path: "$.p#order", kind: "changed", before: [1, 2], after: [2, 1] }]);
  });

  it("falls back to index comparison when identities repeat or are missing", () => {
    expect(diffJson({ p: [{ id: 1 }, { id: 1 }] }, { p: [{ id: 1 }, { id: 2 }] })).toEqual([
      { path: "$.p[1].id", kind: "changed", before: 1, after: 2 },
    ]);
    expect(diffJson([1, 2], [1])).toEqual([{ path: "$[1]", kind: "removed", before: 2 }]);
  });

  it("treats numeric and string ids as different and handles empty sides", () => {
    expect(diffJson({ p: [{ id: 1 }] }, { p: [{ id: "1" }] })).toEqual([
      { path: "$.p[?(@.id==1)]", kind: "removed", before: { id: 1 } },
      { path: '$.p[?(@.id=="1")]', kind: "added", after: { id: "1" } },
    ]);
    expect(diffJson({ p: [] }, { p: [{ id: 1 }] })).toEqual([
      { path: "$.p[0]", kind: "added", after: { id: 1 } },
    ]);
  });

  it("quotes keys that are not identifiers and reports type changes", () => {
    expect(diffJson({ "grafana.app/x": 1, n: null }, { "grafana.app/x": 2, n: {} })).toEqual([
      { path: '$["grafana.app/x"]', kind: "changed", before: 1, after: 2 },
      { path: "$.n", kind: "changed", before: null, after: {} },
    ]);
  });
});

describe("formatJsonChanges", () => {
  it("summarizes large values", () => {
    const panel = {
      id: 9,
      title: "Latency",
      targets: Array.from({ length: 20 }, (_, i) => ({ refId: `R${i}` })),
    };
    const [added, changed] = formatJsonChanges([
      { path: "$.panels[?(@.id==9)]", kind: "added", after: panel },
      { path: "$.title", kind: "changed", before: "a", after: "b" },
    ]);
    expect(added).toBe('+ $.panels[?(@.id==9)] = {3 keys "Latency"}');
    expect(changed).toBe('~ $.title: "a" -> "b"');
  });
});
