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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skip folders"));
  });
});
