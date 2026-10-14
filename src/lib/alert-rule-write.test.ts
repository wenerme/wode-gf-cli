import { afterEach, describe, expect, it, vi } from "vitest";
import { GrafanaClient } from "../client";
import { rulerToProvisioning } from "./alert-rule-versions";
import { applyProvisioningToRuler, orderChanged, writeAlertRule } from "./alert-rule-write";

type Dto = {
  for: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  grafana_alert: Record<string, unknown>;
};
const dto = (uid: string, version: number, provenance?: string): Dto => ({
  for: "1m",
  labels: { team: "sre" },
  annotations: {},
  grafana_alert: {
    uid,
    title: uid.toUpperCase(),
    condition: "C",
    data: [{ refId: "C" }],
    namespace_uid: "f",
    rule_group: "g",
    no_data_state: "NoData",
    exec_err_state: "Error",
    is_paused: false,
    version,
    ...(provenance ? { provenance } : {}),
  },
});

/** Fake ruler: provisioning PUT drops the group index (moves the rule to position 1), like Grafana 13.1. */
function fakeRuler(rules: Dto[]) {
  const calls: Array<{ method: string; path: string; body?: unknown; headers: Record<string, string> }> = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        method,
        path: url.pathname,
        body,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      const single = url.pathname.match(/^\/api\/ruler\/grafana\/api\/v1\/rule\/([^/]+)$/);
      if (single && method === "GET")
        return json(
          200,
          rules.find((rule) => rule.grafana_alert.uid === single[1]),
        );
      if (url.pathname === "/api/ruler/grafana/api/v1/rules/f/g" && method === "GET")
        return json(202, { name: "g", interval: "1m", rules });
      if (url.pathname === "/api/ruler/grafana/api/v1/rules/f" && method === "POST") {
        rules.splice(
          0,
          rules.length,
          ...(body.rules as Dto[]).map((rule) => ({
            ...rule,
            grafana_alert: { ...rule.grafana_alert, version: Number(rule.grafana_alert.version) + 1 },
          })),
        );
        return json(202, { message: "ok" });
      }
      const prov = url.pathname.match(/^\/api\/v1\/provisioning\/alert-rules\/([^/]+)$/);
      if (prov && method === "PUT") {
        const index = rules.findIndex((rule) => rule.grafana_alert.uid === prov[1]);
        const [moved] = rules.splice(index, 1);
        if (moved)
          rules.splice(1, 0, {
            ...moved,
            grafana_alert: {
              ...moved.grafana_alert,
              title: body.title,
              version: Number(moved.grafana_alert.version) + 1,
            },
          });
        return json(200, {});
      }
      return json(404, { message: "unexpected" });
    }),
  );
  return calls;
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

afterEach(() => vi.unstubAllGlobals());

describe("applyProvisioningToRuler", () => {
  it("round-trips a ruler DTO through the provisioning shape", () => {
    const original = dto("a", 3);
    expect(applyProvisioningToRuler(original, rulerToProvisioning(original))).toEqual({
      ...original,
      keep_firing_for: undefined,
      grafana_alert: { ...original.grafana_alert, missing_series_evals_to_resolve: 0 },
    });
  });
});

describe("applyProvisioningToRuler resets fields the old version did not set", () => {
  it("sends missing_series_evals_to_resolve=0 so the ruler API does not keep the current value", () => {
    const current = dto("a", 5);
    current.grafana_alert.missing_series_evals_to_resolve = 2;
    const old = rulerToProvisioning(dto("a", 3) as never);
    expect(applyProvisioningToRuler(current, old).grafana_alert).toMatchObject({
      missing_series_evals_to_resolve: 0,
    });
  });
});

describe("writeAlertRule", () => {
  it("re-submits the ruler group when nothing is provisioned, keeping order", async () => {
    const rules = [dto("z", 1), dto("m", 1), dto("a", 1)];
    const calls = fakeRuler(rules);
    const result = await writeAlertRule(
      client(),
      "a",
      { ...rulerToProvisioning(rules[2] as never), isPaused: true },
      1,
    );
    expect(result.path).toBe("ruler-group");
    expect(orderChanged(result)).toBe(false);
    const post = calls.find((call) => call.method === "POST")?.body as { rules: Dto[] };
    expect(post.rules.map((rule) => [rule.grafana_alert.uid, rule.grafana_alert.is_paused])).toEqual([
      ["z", false],
      ["m", false],
      ["a", true],
    ]);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("falls back to the provisioning PUT in provisioned groups and reports the reorder", async () => {
    const rules = [dto("z", 1, "api"), dto("m", 1), dto("a", 1)];
    const calls = fakeRuler(rules);
    const result = await writeAlertRule(
      client(),
      "a",
      { ...rulerToProvisioning(rules[2] as never), title: "new" },
      1,
    );
    expect(result.path).toBe("provisioning");
    expect(calls.find((call) => call.method === "PUT")?.headers["x-disable-provenance"]).toBe("true");
    expect(orderChanged(result)).toBe(true);

    const apiCalls = fakeRuler([dto("z", 1, "api"), dto("a", 1, "api")]);
    await writeAlertRule(client(), "a", { title: "x" }, 1);
    expect(apiCalls.find((call) => call.method === "PUT")?.headers["x-disable-provenance"]).toBeUndefined();
  });

  it("refuses file-provisioned and changed rules without writing", async () => {
    const calls = fakeRuler([dto("a", 2, "file")]);
    await expect(writeAlertRule(client(), "a", {}, 2)).rejects.toThrow("provisioned from file");
    await expect(writeAlertRule(client(), "a", {}, 1)).rejects.toThrow("changed after version 1");
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });
});
