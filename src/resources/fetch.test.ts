import { afterEach, describe, expect, it, vi } from "vitest";
import { GrafanaClient } from "../client";
import { fetchResources } from "./fetch";

function client(): GrafanaClient {
  return new GrafanaClient({
    url: "http://127.0.0.1:3000",
    timeoutMs: 1000,
    dryRun: false,
    debug: false,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resource fetch failure semantics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fails closed by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "forbidden" }), { status: 403 })),
    );

    await expect(fetchResources(client(), ["folders"])).rejects.toThrow(
      "Failed to fetch folders: 403 GET /api/folders",
    );
  });

  it("only returns a partial bundle when explicitly enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const bundle = await fetchResources(client(), ["folders"], { allowPartial: true });

    expect(bundle.folders).toBeUndefined();
    expect(bundle.failedResources).toEqual(["folders"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skip folders"));
  });

  it("rejects an object where an array response is required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ items: [] })),
    );

    await expect(fetchResources(client(), ["folders"])).rejects.toThrow("folders response must be an array");
  });

  it("rejects a dashboard v2 list without items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ apiVersion: "v1" })),
    );

    await expect(fetchResources(client(), ["dashboards"], { dashboardApi: "v2" })).rejects.toThrow(
      "dashboard v2 items response must be an array",
    );
  });

  it("rejects invalid items inside array responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([null])),
    );

    await expect(fetchResources(client(), ["datasources"])).rejects.toThrow(
      "datasources response item[0] must be an object",
    );
  });
});
