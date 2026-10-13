import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCliProgram } from "../../cli";

const v2Doc = {
  apiVersion: "dashboard.grafana.app/v2beta1",
  kind: "Dashboard",
  metadata: { name: "d" },
  spec: {
    title: "D",
    elements: {
      "panel-14": {
        kind: "Panel",
        spec: {
          id: 14,
          title: "Restarts",
          data: { spec: { queries: [{ spec: { query: { spec: { expr: "increase(x[5m])" } } } }] } },
        },
      },
    },
    layout: {
      kind: "GridLayout",
      spec: {
        items: [
          {
            kind: "GridLayoutItem",
            spec: {
              x: 0,
              y: 0,
              width: 24,
              height: 8,
              element: { kind: "ElementReference", name: "panel-14" },
            },
          },
        ],
      },
    },
  },
};

const classicDoc = {
  uid: "c",
  title: "C",
  dashboard: {
    uid: "c",
    title: "C",
    panels: [
      { id: 1, type: "timeseries", title: "A", gridPos: { x: 0, y: 0, w: 12, h: 8 } },
      { id: 2, type: "timeseries", title: "B", gridPos: { x: 12, y: 0, w: 12, h: 8 } },
    ],
  },
};

let dir: string;
let output: string[];

async function run(args: string[]) {
  output = [];
  process.exitCode = undefined;
  const program = buildCliProgram();
  program.exitOverride();
  let error: Error | undefined;
  try {
    await program.parseAsync(["node", "wode-gf-cli", ...args]);
  } catch (caught) {
    error = caught as Error;
  }
  return error;
}

function write(name: string, doc: unknown) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-file-"));
  vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => output.push(args.join(" ")));
  vi.stubEnv("HOME", dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("dashboard patch-file", () => {
  it("does not write in --dry-run mode", async () => {
    const file = write("v2.json", v2Doc);
    const before = fs.readFileSync(file, "utf8");
    const error = await run([
      "--dry-run",
      "dashboard",
      "patch-file",
      file,
      "--panel-id",
      "14",
      "--set",
      "title",
      '"X"',
    ]);
    expect(error).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("maps --panel-id to v2 spec.elements by spec.id", async () => {
    const file = write("v2.json", v2Doc);
    const error = await run([
      "dashboard",
      "patch-file",
      file,
      "--panel-id",
      "14",
      "--regex",
      "data.spec.queries[*].spec.query.spec.expr",
      "\\[5m\\]",
      "[10m]",
    ]);
    expect(error).toBeUndefined();
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(doc.spec.elements["panel-14"].spec.data.spec.queries[0].spec.query.spec.expr).toBe(
      "increase(x[10m])",
    );
  });

  it("fails and keeps the file when an operation matches nothing", async () => {
    const file = write("v2.json", v2Doc);
    const before = fs.readFileSync(file, "utf8");
    const error = await run([
      "dashboard",
      "patch-file",
      file,
      "--set",
      "title",
      '"X"',
      "--set",
      "$.spec.nope.value",
      "1",
    ]);
    expect(error?.message).toContain("1 operation(s) matched nothing: $.spec.nope.value");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("allows zero matches with --allow-no-match", async () => {
    const file = write("v2.json", v2Doc);
    const error = await run([
      "dashboard",
      "patch-file",
      file,
      "--panel-id",
      "99",
      "--set",
      "title",
      '"X"',
      "--allow-no-match",
    ]);
    expect(error).toBeUndefined();
  });

  it("patches through a symlink without replacing the link", async () => {
    const file = write("real.json", v2Doc);
    const link = path.join(dir, "link.json");
    fs.symlinkSync(file, link);
    const error = await run(["dashboard", "patch-file", link, "--panel-id", "14", "--set", "title", '"Y"']);
    expect(error).toBeUndefined();
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).spec.elements["panel-14"].spec.title).toBe("Y");
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("resolves --panel-id under a {dashboard: v2} wrapper", async () => {
    const file = write("wrapped.json", { uid: "d", dashboard: v2Doc });
    const error = await run(["dashboard", "patch-file", file, "--panel-id", "14", "--set", "title", '"W"']);
    expect(error).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).dashboard.spec.elements["panel-14"].spec.title).toBe(
      "W",
    );
  });

  it("rejects --panel-id combined with an absolute $ path", async () => {
    const file = write("v2.json", v2Doc);
    const before = fs.readFileSync(file, "utf8");
    const error = await run(["dashboard", "patch-file", file, "--panel-id", "14", "--set", "$.title", '"X"']);
    expect(error?.message).toContain("cannot be combined with absolute path");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses to drop the whole layout", async () => {
    const file = write("classic.json", classicDoc);
    const before = fs.readFileSync(file, "utf8");
    const error = await run(["dashboard", "patch-file", file, "--set", "$.dashboard.panels", "null"]);
    expect(error?.message).toContain("removes the dashboard layout");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses to delete a v2 layout, direct or wrapped", async () => {
    for (const [name, doc, target] of [
      ["direct.json", v2Doc, "$.spec.layout"],
      ["wrapped.json", { uid: "d", dashboard: v2Doc }, "$.dashboard.spec.layout"],
    ] as const) {
      const file = write(name, doc);
      const before = fs.readFileSync(file, "utf8");
      const error = await run(["dashboard", "patch-file", file, "--set", target, "null"]);
      expect(error?.message).toContain("layout is missing");
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    }
  });

  it("still blocks deleting the root layout when a nested layout is already missing", async () => {
    // No elements, so deleting the root produces no orphan error: only the missing-layout path differs.
    const doc = structuredClone(v2Doc) as { spec: Record<string, unknown> };
    doc.spec.elements = {};
    doc.spec.layout = {
      kind: "RowsLayout",
      spec: {
        rows: [
          { kind: "RowsLayoutRow", spec: { title: "Broken", layout: null } },
          {
            kind: "RowsLayoutRow",
            spec: { title: "Ok", layout: { kind: "GridLayout", spec: { items: [] } } },
          },
        ],
      },
    };
    const file = write("nested.json", doc);
    const before = fs.readFileSync(file, "utf8");
    const error = await run(["dashboard", "patch-file", file, "--set", "$.spec.layout", "null"]);
    expect(error?.message).toContain("introduces");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("does not rewrite on net-zero edits", async () => {
    const file = write("classic.json", classicDoc);
    fs.writeFileSync(file, JSON.stringify(classicDoc));
    const before = fs.readFileSync(file, "utf8");
    const error = await run([
      "dashboard",
      "patch-file",
      file,
      "--panel-id",
      "1",
      "--set",
      "title",
      '"B"',
      "--set",
      "title",
      '"A"',
    ]);
    expect(error).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("treats a warning that becomes an error as newly introduced", async () => {
    const unknownLayout = structuredClone(v2Doc) as { spec: { layout: unknown } };
    unknownLayout.spec.layout = { kind: "FutureLayout", spec: {} };
    const file = write("future.json", unknownLayout);
    const error = await run([
      "dashboard",
      "patch-file",
      file,
      "--set",
      "$.spec.layout",
      '{"kind":"GridLayout","spec":{"items":[]}}',
    ]);
    expect(error?.message).toContain("introduces 1 layout error");
    expect(error?.message).toContain("not placed in any layout");
  });

  it("rejects patches that introduce layout overlap", async () => {
    const file = write("classic.json", classicDoc);
    const before = fs.readFileSync(file, "utf8");
    const error = await run(["dashboard", "patch-file", file, "--panel-id", "2", "--set", "gridPos.x", "0"]);
    expect(error?.message).toContain("introduces 1 layout error");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("enforces --forbid-layout-change and reports layout in json", async () => {
    const file = write("classic.json", classicDoc);
    const error = await run([
      "dashboard",
      "patch-file",
      file,
      "--panel-id",
      "2",
      "--set",
      "gridPos.h",
      "9",
      "--forbid-layout-change",
      "--json",
    ]);
    expect(error?.message).toContain("--forbid-layout-change");
    const summary = JSON.parse(output.find((line) => line.trim().startsWith("{")) as string);
    expect(summary.layout.changed).toBe(true);
    expect(summary.written).toBe(false);
  });
});

describe("validate layout integration", () => {
  const overlapping = {
    ...classicDoc,
    dashboard: {
      ...classicDoc.dashboard,
      panels: [
        classicDoc.dashboard.panels[0],
        { ...classicDoc.dashboard.panels[1], gridPos: { x: 6, y: 0, w: 12, h: 8 } },
      ],
    },
  };

  it("runs --syntax-only without a Grafana URL and only warns on layout by default", async () => {
    write("classic.json", overlapping);
    const error = await run(["validate", "--syntax-only", dir]);
    expect(error).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
    expect(output.join("\n")).toContain("Layout: C");
  });

  it("blocks import before any request with --layout error", async () => {
    write("classic.json", overlapping);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const error = await run([
      "--url",
      "http://127.0.0.1:9",
      "import",
      dir,
      "--layout",
      "error",
      "--skip-promql-check",
    ]);
    expect(error?.message).toContain("Layout check failed before import");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not call Grafana for datasource type filters without URL", async () => {
    write("classic.json", classicDoc);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await run(["validate", "--syntax-only", "--datasource-type", "prometheus", dir]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("checks every dashboard of an array source file", async () => {
    const second = {
      ...overlapping,
      uid: "c2",
      dashboard: { ...overlapping.dashboard, uid: "c2", title: "C2" },
    };
    write("bundle.json", [classicDoc, second]);
    const error = await run([
      "--url",
      "http://127.0.0.1:9",
      "push",
      dir,
      "--layout",
      "error",
      "--skip-promql-check",
    ]);
    expect(error?.message).toContain("Layout check failed before push");
  });

  it("fails with --layout error", async () => {
    write("classic.json", overlapping);
    await run(["validate", "--syntax-only", "--layout", "error", dir]);
    expect(process.exitCode).toBe(1);
  });
});

describe("dashboard layout check command", () => {
  it("fix does not write skipped files and exits 1", async () => {
    const file = write("ambiguous.json", {
      ...classicDoc,
      dashboard: {
        ...classicDoc.dashboard,
        panels: [
          {
            id: 9,
            type: "row",
            title: "R",
            collapsed: true,
            panels: [],
            gridPos: { x: 0, y: 0, w: 24, h: 1 },
          },
          { id: 1, type: "timeseries", title: "A", gridPos: { x: 0, y: 1, w: 24, h: 8 } },
          { id: 2, type: "timeseries", title: "B", gridPos: { x: 0, y: 2, w: 24, h: 8 } },
        ],
      },
    });
    const before = fs.readFileSync(file, "utf8");
    await run(["dashboard", "layout", "fix", file, "--json"]);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(output.join("\n")).results[0].skipped).toContain("collapsed row");
  });

  it("fix keeps 4-space indentation", async () => {
    const file = path.join(dir, "indent.json");
    const doc = {
      ...classicDoc,
      dashboard: {
        ...classicDoc.dashboard,
        panels: [
          classicDoc.dashboard.panels[0],
          { ...classicDoc.dashboard.panels[1], gridPos: { x: 6, y: 0, w: 12, h: 8 } },
        ],
      },
    };
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 4)}\n`);
    await run(["dashboard", "layout", "fix", file]);
    expect(fs.readFileSync(file, "utf8")).toMatch(/^\{\n {4}"uid"/);
  });

  it("fix --dry-run reports a plan without writing, then fix writes", async () => {
    const file = write("classic.json", {
      ...classicDoc,
      dashboard: {
        ...classicDoc.dashboard,
        panels: [
          classicDoc.dashboard.panels[0],
          { ...classicDoc.dashboard.panels[1], gridPos: { x: 6, y: 0, w: 12, h: 8 } },
        ],
      },
    });
    const before = fs.readFileSync(file, "utf8");
    await run(["--dry-run", "dashboard", "layout", "fix", file, "--json"]);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(output.join("\n")).results[0].changed).toBe(true);
    await run(["dashboard", "layout", "fix", file]);
    expect(process.exitCode).toBeUndefined();
    const fixed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(fixed.dashboard.panels[1].gridPos).toEqual({ x: 6, y: 8, w: 12, h: 8 });
  });

  it("exits 1 with overlap details", async () => {
    write("classic.json", {
      ...classicDoc,
      dashboard: {
        ...classicDoc.dashboard,
        panels: [
          classicDoc.dashboard.panels[0],
          { ...classicDoc.dashboard.panels[1], gridPos: { x: 6, y: 0, w: 12, h: 8 } },
        ],
      },
    });
    await run(["dashboard", "layout", "check", dir, "--json"]);
    expect(process.exitCode).toBe(1);
    const report = JSON.parse(output.join("\n"));
    expect(report.errors).toBe(1);
    expect(report.results[0].issues[0].code).toBe("overlap");
  });
});
