import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCliProgram } from "../../cli";

type Panel = {
  id: number;
  type: string;
  title: string;
  gridPos: { x: number; y: number; w: number; h: number };
};
const panel = (id: number, title: string, y = 0): Panel => ({
  id,
  type: "text",
  title,
  gridPos: { x: 0, y, w: 12, h: 4 },
});

/** Minimal classic Grafana: versions newest first, overwrite:false CAS on POST /api/dashboards/db. */
function fakeGrafana(options: { v2Status?: number; normalize?: boolean } = {}) {
  const history: Array<{ version: number; message: string; data: Record<string, unknown> }> = [
    {
      version: 1,
      message: "Initial save",
      data: { uid: "d", title: "D", version: 1, panels: [panel(1, "a"), panel(2, "b", 4)] },
    },
    {
      version: 2,
      message: "broke layout",
      data: { uid: "d", title: "D", version: 2, panels: [panel(1, "a"), panel(2, "b", 2)] },
    },
    {
      version: 3,
      message: "edit",
      data: { uid: "d", title: "D", version: 3, panels: [panel(1, "c"), panel(2, "b", 4)] },
    },
  ];
  // Metadata-only save: same version number appears twice.
  history.push({ version: 3, message: "meta only", data: history[2]?.data as Record<string, unknown> });
  const writes: unknown[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const latest = () => history[history.length - 1] as (typeof history)[number];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      if (url.pathname.startsWith("/apis/dashboard.grafana.app/v2beta1/") && method === "GET") {
        const status = options.v2Status ?? 404;
        return json(
          status,
          status === 200 ? { metadata: { name: "d" }, spec: {}, status: {} } : { message: "x" },
        );
      }
      if (url.pathname === "/api/dashboards/uid/d" && method === "GET") {
        return json(200, {
          meta: { version: latest().version, folderUid: "f" },
          dashboard: { ...latest().data, id: 5 },
        });
      }
      if (url.pathname === "/api/dashboards/uid/d/versions" && method === "GET") {
        return json(200, {
          continueToken: "",
          versions: [...history].reverse().slice(0, Number(url.searchParams.get("limit") || 100)),
        });
      }
      const one = url.pathname.match(/^\/api\/dashboards\/uid\/d\/versions\/(\d+)$/);
      if (one && method === "GET") {
        const hit = [...history].reverse().find((item) => item.version === Number(one[1]));
        return hit ? json(200, hit) : json(404, { message: "nope" });
      }
      if (url.pathname === "/api/dashboards/db" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        if (body.overwrite !== false || body.dashboard.version !== latest().version)
          return json(409, { message: "version-mismatch" });
        const version = latest().version + 1;
        const data = { ...body.dashboard, version, ...(options.normalize ? { schemaVersion: 99 } : {}) };
        delete data.id;
        history.push({ version, message: body.message, data });
        return json(200, { version, status: "success" });
      }
      return json(404, { message: `unexpected ${method} ${url.pathname}` });
    }),
  );
  return { writes, history };
}

let output: string[];
let dir: string;

async function run(args: string[]) {
  output = [];
  process.exitCode = undefined;
  const program = buildCliProgram();
  program.exitOverride();
  try {
    await program.parseAsync(["node", "wode-gf-cli", "--url", "http://127.0.0.1:3000", ...args]);
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "versions-"));
  vi.stubEnv("HOME", dir);
  vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => output.push(args.join(" ")));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("dashboard versions restore", () => {
  it("--dry-run and a stale --expect-version never write", async () => {
    const grafana = fakeGrafana();
    await run(["--dry-run", "dashboard", "versions", "restore", "d", "1"]);
    expect(grafana.writes).toEqual([]);
    expect(output.join("\n")).toContain("[DRY-RUN] restore d (classic) v3 -> content of v1");
    const error = await run(["dashboard", "versions", "restore", "d", "1", "--expect-version", "2"]);
    expect(error?.message).toContain("expected 2");
    expect(grafana.writes).toEqual([]);
  });

  it("writes with overwrite:false and the current id/version, then verifies the readback", async () => {
    const grafana = fakeGrafana();
    expect(
      await run(["dashboard", "versions", "restore", "d", "1", "--expect-version", "3"]),
    ).toBeUndefined();
    expect(grafana.writes).toEqual([
      expect.objectContaining({
        overwrite: false,
        folderUid: "f",
        message: "Restored from version 1",
        dashboard: expect.objectContaining({ id: 5, version: 3, uid: "d" }),
      }),
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(output.join("\n")).toContain("Restored as v4");
  });

  it("exits 2 when Grafana normalizes the saved content", async () => {
    fakeGrafana({ normalize: true });
    await run(["dashboard", "versions", "restore", "d", "1"]);
    expect(process.exitCode).toBe(2);
    expect(output.join("\n")).toContain("readback differs");
  });

  it("--json prints exactly one JSON document, with layout issues embedded", async () => {
    fakeGrafana();
    await run(["--dry-run", "dashboard", "versions", "restore", "d", "2", "--json"]);
    const parsed = JSON.parse(output.join("\n"));
    expect(parsed).toMatchObject({ action: "plan", from: 3, to: 2, layout: { mode: "warn", warnings: 1 } });
  });

  it("refuses a format conversion and does not guess the format on detection errors", async () => {
    const grafana = fakeGrafana({ v2Status: 200 });
    expect(
      (await run(["dashboard", "versions", "restore", "d", "1", "--dashboard-api", "classic"]))?.message,
    ).toContain("stored as v2");
    fakeGrafana({ v2Status: 403 });
    expect((await run(["dashboard", "versions", "restore", "d", "1"]))?.message).toContain(
      "Cannot detect storage format",
    );
    expect(grafana.writes).toEqual([]);
  });
});

describe("dashboard versions diff", () => {
  it("current~1 skips repeated version numbers and exits 2 on differences", async () => {
    fakeGrafana();
    await run(["dashboard", "versions", "diff", "d", "current~1"]);
    expect(output.join("\n")).toContain("v2 -> current (v3)");
    expect(process.exitCode).toBe(2);
  });

  it("list --check-layout marks where errors were introduced and fixed", async () => {
    fakeGrafana();
    await run(["dashboard", "versions", "list", "d", "--check-layout", "--json"]);
    const rows = JSON.parse(output.join("\n")).versions as Array<{
      version: number;
      layout: { errors: number; note?: string };
    }>;
    expect(rows.map((row) => [row.version, row.layout.errors, row.layout.note])).toEqual([
      [3, 0, undefined],
      [3, 0, "fixed"],
      [2, 1, "introduced"],
      [1, 0, undefined],
    ]);
  });
});
