import { afterEach, describe, expect, it, vi } from "vitest";
import { GrafanaClient } from "../client";
import { importAlertRules } from "./import-alert-rules";

type Dto = {
  for: string;
  keep_firing_for?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  grafana_alert: Record<string, unknown>;
};
const dto = (uid: string, group: string, provenance?: string): Dto => ({
  for: "1m",
  labels: {},
  annotations: {},
  grafana_alert: {
    uid,
    title: uid,
    condition: "C",
    data: [
      {
        refId: "C",
        datasourceUid: "__expr__",
        model: { refId: "C", intervalMs: 1000, maxDataPoints: 43200 },
        queryType: "",
        relativeTimeRange: { from: 0, to: 0 },
      },
    ],
    namespace_uid: "f",
    rule_group: group,
    no_data_state: "NoData",
    exec_err_state: "Error",
    is_paused: false,
    version: 1,
    ...(provenance ? { provenance } : {}),
  },
});
/** What a repo file looks like: provisioning shape, written by hand (no server-filled defaults). */
const file = (uid: string, group: string, extra: Record<string, unknown> = {}) => ({
  uid,
  title: uid,
  folderUID: "f",
  ruleGroup: group,
  condition: "C",
  data: [{ refId: "C", datasourceUid: "__expr__", model: { refId: "C" } }],
  noDataState: "NoData",
  execErrState: "Error",
  for: "1m",
  ...extra,
});

/**
 * Fake Grafana. Ruler POST behaves like Grafana for moves: a posted uid that lives in another group is removed
 * there. Provisioning PUT moves the rule to index 1 of its group (the index loss seen on 13.1).
 */
function fakeGrafana(groups: Record<string, Dto[]>, options: { putStatus?: number } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown; headers: Record<string, string> }> = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const uidOf = (rule: Dto) => rule.grafana_alert.uid as string;
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
      if (url.pathname === "/api/ruler/grafana/api/v1/rules" && method === "GET") {
        return json(200, {
          F: Object.entries(groups).map(([name, rules]) => ({ name, interval: "1m", rules })),
        });
      }
      const one = url.pathname.match(/^\/api\/ruler\/grafana\/api\/v1\/rules\/f\/([^/]+)$/);
      if (one && method === "GET") {
        const rules = groups[one[1] as string];
        return rules ? json(202, { name: one[1], interval: "1m", rules }) : json(404, {});
      }
      if (url.pathname === "/api/ruler/grafana/api/v1/rules/f" && method === "POST") {
        const posted = (body.rules as Dto[]).map((rule) => ({
          ...rule,
          grafana_alert: { ...rule.grafana_alert, rule_group: body.name },
        }));
        const ids = new Set(posted.map(uidOf));
        for (const [name, rules] of Object.entries(groups))
          if (name !== body.name) groups[name] = rules.filter((rule) => !ids.has(uidOf(rule)));
        groups[body.name] = posted;
        return json(202, {});
      }
      const put = url.pathname.match(/^\/api\/v1\/provisioning\/alert-rules\/([^/]+)$/);
      if (put && method === "PUT") {
        if (options.putStatus && options.putStatus !== 200) return json(options.putStatus, {});
        for (const rules of Object.values(groups)) {
          const index = rules.findIndex((rule) => uidOf(rule) === put[1]);
          if (index < 0) continue;
          const [moved] = rules.splice(index, 1);
          if (moved) rules.splice(1, 0, moved);
        }
        return json(200, {});
      }
      if (url.pathname === "/api/v1/provisioning/alert-rules" && method === "POST") return json(201, {});
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
const writes = (calls: ReturnType<typeof fakeGrafana>) => calls.filter((call) => call.method !== "GET");

afterEach(() => vi.unstubAllGlobals());

describe("importAlertRules", () => {
  it("does not write unchanged rules, ignoring defaults Grafana fills in and key order", async () => {
    const calls = fakeGrafana({ g: [dto("a", "g"), dto("b", "g")] });
    const report = await importAlertRules(client(), [file("b", "g"), file("a", "g")], { dryRun: false });
    expect(report.items.map((item) => item.action)).toEqual(["unchanged", "unchanged"]);
    expect(writes(calls)).toEqual([]);
  });

  it("writes an unprovisioned group once through the ruler API, keeping order and appending new rules", async () => {
    const groups = { g: [dto("z", "g"), dto("m", "g"), dto("a", "g")] };
    const calls = fakeGrafana(groups);
    const report = await importAlertRules(
      client(),
      [file("a", "g", { annotations: { summary: "x" } }), file("new", "g"), file("z", "g")],
      { dryRun: false },
    );
    expect(report.items.map((item) => [item.key, item.action, item.via])).toEqual([
      ["a", "update", "ruler-group"],
      ["new", "create", "ruler-group"],
      ["z", "unchanged", undefined],
    ]);
    expect(writes(calls)).toHaveLength(1);
    const posted = writes(calls)[0]?.body as { rules: Dto[] };
    expect(posted.rules.map((rule) => rule.grafana_alert.uid)).toEqual(["z", "m", "a", "new"]);
    expect(posted.rules[3]?.grafana_alert).toMatchObject({ missing_series_evals_to_resolve: 0 });
    expect(posted.rules[3]?.keep_firing_for).toBe("0s");
    expect(report.reordered).toEqual([]);
  });

  it("uses provisioning PUT in groups with provisioned rules and keeps each rule's provenance", async () => {
    const calls = fakeGrafana({ gp: [dto("n", "gp"), dto("p", "gp", "api")] });
    await importAlertRules(client(), [file("n", "gp", { title: "n2" }), file("p", "gp", { title: "p2" })], {
      dryRun: false,
    });
    const puts = writes(calls);
    expect(puts.map((call) => [call.method, call.path, call.headers["x-disable-provenance"]])).toEqual([
      ["PUT", "/api/v1/provisioning/alert-rules/n", "true"],
      ["PUT", "/api/v1/provisioning/alert-rules/p", undefined],
    ]);
  });

  it("never turns a failed PUT into a create (no duplicate-key POST); only 404 creates", async () => {
    const calls = fakeGrafana({ gp: [dto("p", "gp", "api")] }, { putStatus: 409 });
    const report = await importAlertRules(client(), [file("p", "gp", { title: "p2" })], { dryRun: false });
    expect(report.items[0]).toMatchObject({ action: "failed", error: expect.stringContaining("409 PUT") });
    expect(writes(calls).some((call) => call.method === "POST")).toBe(false);

    const gone = fakeGrafana({ gp: [dto("p", "gp", "api")] }, { putStatus: 404 });
    await importAlertRules(client(), [file("p", "gp", { title: "p2" })], { dryRun: false });
    expect(writes(gone).map((call) => call.method)).toEqual(["PUT", "POST"]);
  });

  it("refuses file-provisioned rules, flags duplicate uids, and plans without writing in dry-run", async () => {
    const calls = fakeGrafana({ g: [dto("a", "g")], gf: [dto("fp", "gf", "file")] });
    const report = await importAlertRules(
      client(),
      [file("fp", "gf", { title: "x" }), file("a", "g", { title: "y" }), file("a", "g")],
      { dryRun: true },
    );
    expect(report.items.map((item) => [item.key, item.action])).toEqual([
      ["fp", "failed"],
      ["a", "update"],
      ["a", "failed"],
    ]);
    expect(report.items[0]?.error).toContain("provisioned from file");
    expect(writes(calls)).toEqual([]);
  });

  it("marks every rule of a group failed when the group write is rejected, and continues with other groups", async () => {
    fakeGrafana({ g: [dto("a", "g")], h: [dto("b", "h")] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const json = (status: number, body: unknown) =>
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (url.pathname === "/api/ruler/grafana/api/v1/rules")
          return json(200, {
            F: [
              { name: "g", rules: [dto("a", "g")] },
              { name: "h", rules: [dto("b", "h")] },
            ],
          });
        if (url.pathname.endsWith("/f/g")) return json(202, { name: "g", rules: [dto("a", "g")] });
        if (url.pathname.endsWith("/f/h")) return json(202, { name: "h", rules: [dto("b", "h")] });
        if (init?.method === "POST")
          return JSON.parse(String(init.body)).name === "g" ? json(400, { message: "bad" }) : json(202, {});
        return json(404, {});
      }),
    );
    const report = await importAlertRules(
      client(),
      [file("a", "g", { title: "x" }), file("b", "h", { title: "y" })],
      { dryRun: false },
    );
    expect(report.items.map((item) => [item.key, item.action])).toEqual([
      ["a", "failed"],
      ["b", "update"],
    ]);
  });

  it("moves a rule between two ruler groups in either write order without losing or duplicating it", async () => {
    for (const order of [
      ["g", "h"],
      ["h", "g"],
    ]) {
      const groups: Record<string, Dto[]> = { g: [dto("a", "g"), dto("m", "g")], h: [dto("b", "h")] };
      fakeGrafana(groups);
      const files = { g: [file("a", "g", { title: "a2" })], h: [file("b", "h"), file("m", "h")] };
      const rules = order.flatMap((name) => files[name as "g" | "h"]);
      const report = await importAlertRules(client(), rules, { dryRun: false });
      expect(report.items.find((item) => item.key === "m")).toMatchObject({
        action: "update",
        moved: true,
        via: "ruler-group",
      });
      expect(groups.g?.map((rule) => rule.grafana_alert.uid)).toEqual(["a"]);
      expect(groups.h?.map((rule) => rule.grafana_alert.uid)).toEqual(["b", "m"]);
    }
  });

  it("uses provisioning for a uid-less rule or a move out of a provisioned group, and reports reorders", async () => {
    const groups: Record<string, Dto[]> = {
      g: [dto("z", "g"), dto("m", "g"), dto("a", "g")],
      gp: [dto("p", "gp", "api"), dto("q", "gp")],
    };
    const calls = fakeGrafana(groups);
    const noUid = file("", "g");
    delete (noUid as Record<string, unknown>).uid;
    const report = await importAlertRules(
      client(),
      [noUid, file("a", "g", { title: "a2" }), file("q", "g")],
      { dryRun: false },
    );
    expect(report.items.map((item) => item.via)).toEqual(["provisioning", "provisioning", "provisioning"]);
    expect(calls.some((call) => call.method === "POST" && call.path.startsWith("/api/ruler"))).toBe(false);
    expect(report.reordered).toEqual(["f/g"]);
  });
});
