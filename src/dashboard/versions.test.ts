import { afterEach, describe, expect, it, vi } from "vitest";
import { GrafanaClient } from "../client";
import { restoreMessage } from "../commands/mutate/build-dashboard-versions";
import {
  comparableDashboard,
  comparableFromLocal,
  detectDashboardApi,
  getDashboardVersion,
  listDashboardVersions,
  writeDashboardVersion,
} from "./versions";

type Route = (url: URL, init?: RequestInit) => { status: number; body: unknown } | undefined;
const calls: Array<{ method: string; path: string; body?: unknown }> = [];

function serve(...routes: Route[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method || "GET",
        path: url.pathname + url.search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      for (const route of routes) {
        const hit = route(url, init);
        if (hit)
          return new Response(JSON.stringify(hit.body), {
            status: hit.status,
            headers: { "content-type": "application/json" },
          });
      }
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    }),
  );
}

const client = () =>
  new GrafanaClient({
    url: "http://127.0.0.1:3000",
    timeoutMs: 1000,
    debug: false,
    dryRun: false,
    output: "text",
    quiet: true,
  } as never);

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe("dashboard versions helpers", () => {
  it("normalizes classic and v2 documents", () => {
    expect(
      comparableDashboard({ api: "classic", document: { id: 3, version: 7, iteration: 1, title: "T" } }),
    ).toEqual({ title: "T" });
    expect(
      comparableDashboard({ api: "v2", document: { metadata: { name: "d" }, spec: { title: "T" } } }),
    ).toEqual({ title: "T" });
  });

  it("reads local export items, raw dashboards, v2 resources and bundles", () => {
    const v2 = {
      apiVersion: "dashboard.grafana.app/v2beta1",
      kind: "Dashboard",
      metadata: { name: "d" },
      spec: { title: "V" },
    };
    expect(comparableFromLocal(v2, "d")).toEqual({ api: "v2", document: { title: "V" } });
    expect(
      comparableFromLocal({ uid: "d", dashboard: { uid: "d", title: "C", version: 2, panels: [] } }, "d"),
    ).toEqual({
      api: "classic",
      document: { uid: "d", title: "C", panels: [] },
    });
    const bundle = [
      { uid: "x", dashboard: { uid: "x", title: "X", panels: [] } },
      { uid: "d", dashboard: { uid: "d", title: "D", panels: [] } },
    ];
    expect(comparableFromLocal(bundle, "d").document.title).toBe("D");
    expect(() => comparableFromLocal(bundle, "missing")).toThrow("No dashboard missing");
  });

  it("refuses restore messages that break Grafana's version list", () => {
    expect(restoreMessage(3)).toBe("Restored from version 3");
    expect(restoreMessage(3, "rollback after incident")).toBe("rollback after incident");
    expect(restoreMessage(3, "Restored from version 3")).toBe("Restored from version 3");
    expect(() => restoreMessage(3, "Restored from version 3 by me")).toThrow("Grafana bug");
  });
});

describe("dashboard versions over HTTP", () => {
  it("detects native v2 storage and treats converted or missing v2 as classic", async () => {
    serve(
      (url) =>
        url.pathname.endsWith("/native")
          ? { status: 200, body: { metadata: {}, spec: {}, status: {} } }
          : undefined,
      (url) =>
        url.pathname.endsWith("/legacy")
          ? {
              status: 200,
              body: { metadata: {}, spec: {}, status: { conversion: { storedVersion: "v0alpha1" } } },
            }
          : undefined,
    );
    await expect(detectDashboardApi(client(), "native")).resolves.toBe("v2");
    await expect(detectDashboardApi(client(), "legacy")).resolves.toBe("classic");
    await expect(detectDashboardApi(client(), "absent")).resolves.toBe("classic");
  });

  it("follows continueToken and falls back to k8s history when the legacy list 404s", async () => {
    serve(
      (url) =>
        url.pathname === "/api/dashboards/uid/ok/versions"
          ? url.searchParams.get("continueToken")
            ? {
                status: 200,
                body: { continueToken: "", versions: [{ version: 1, message: "Initial save" }] },
              }
            : { status: 200, body: { continueToken: "t", versions: [{ version: 2, createdBy: "admin" }] } }
          : undefined,
      (url) =>
        url.pathname.endsWith("/v1/namespaces/default/dashboards") &&
        url.searchParams.get("fieldSelector") === "metadata.name=broken"
          ? {
              status: 200,
              body: {
                metadata: {},
                items: [
                  {
                    metadata: {
                      generation: 5,
                      annotations: {
                        "grafana.app/message": "Restored from version 2 by x",
                        "grafana.app/updatedBy": "user:u1",
                      },
                    },
                    spec: { title: "T", panels: [] },
                  },
                ],
              },
            }
          : undefined,
    );
    expect((await listDashboardVersions(client(), "ok", 10)).map((row) => row.version)).toEqual([2, 1]);
    const fallback = await listDashboardVersions(client(), "broken", 10);
    expect(fallback).toEqual([
      {
        version: 5,
        created: undefined,
        createdBy: "user:u1",
        message: "Restored from version 2 by x",
        data: { title: "T", panels: [] },
      },
    ]);
    await expect(getDashboardVersion(client(), "broken", 5, "classic")).resolves.toMatchObject({
      document: { title: "T" },
    });
  });

  it("refuses v2 history entries that failed conversion", async () => {
    serve((url) =>
      url.pathname.endsWith("/v2beta1/namespaces/default/dashboards")
        ? {
            status: 200,
            body: {
              metadata: {},
              items: [
                {
                  metadata: { generation: 3 },
                  spec: {},
                  status: { conversion: { failed: true, error: "schema migration failed" } },
                },
              ],
            },
          }
        : undefined,
    );
    await expect(getDashboardVersion(client(), "d", 3, "v2")).rejects.toThrow("--dashboard-api classic");
  });

  it("writes classic with overwrite:false + current id/version and explains 409", async () => {
    serve((url, init) =>
      url.pathname === "/api/dashboards/db" && init?.method === "POST"
        ? { status: 409, body: { message: "exists" } }
        : undefined,
    );
    const current = {
      api: "classic" as const,
      uid: "d",
      version: 4,
      id: 11,
      folderUid: "f",
      document: { uid: "d", title: "now" },
    };
    const target = {
      api: "classic" as const,
      uid: "d",
      version: 2,
      document: { uid: "d", title: "old", id: 99, version: 2 },
    };
    await expect(writeDashboardVersion(client(), current, target, "Restored from version 2")).rejects.toThrow(
      "save after version 4",
    );
    expect(calls[0]?.body).toEqual({
      dashboard: { uid: "d", title: "old", id: 11, version: 4 },
      folderUid: "f",
      overwrite: false,
      message: "Restored from version 2",
    });
  });

  it("writes v2 with the current resourceVersion, target spec and an explicit message", async () => {
    serve((_url, init) =>
      init?.method === "PUT" ? { status: 200, body: { metadata: { generation: 6 } } } : undefined,
    );
    const current = {
      api: "v2" as const,
      uid: "d",
      version: 5,
      resourceVersion: "rv5",
      document: {
        apiVersion: "dashboard.grafana.app/v2beta1",
        kind: "Dashboard",
        metadata: {
          name: "d",
          resourceVersion: "rv5",
          annotations: { "grafana.app/folder": "f", "grafana.app/message": "old msg" },
        },
        spec: { title: "now" },
        status: {},
      },
    };
    const target = {
      api: "v2" as const,
      uid: "d",
      version: 2,
      document: { metadata: { name: "d", generation: 2 }, spec: { title: "old" } },
    };
    await expect(writeDashboardVersion(client(), current, target, "Restored from version 2")).resolves.toBe(
      6,
    );
    expect(calls[0]?.body).toEqual({
      apiVersion: "dashboard.grafana.app/v2beta1",
      kind: "Dashboard",
      metadata: {
        name: "d",
        resourceVersion: "rv5",
        annotations: { "grafana.app/folder": "f", "grafana.app/message": "Restored from version 2" },
      },
      spec: { title: "old" },
    });
  });
});
