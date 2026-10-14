import { afterEach, describe, expect, it, vi } from "vitest";
import { GrafanaClient } from "../client";
import {
  comparableAlertRule,
  getCurrentAlertRule,
  rulerToProvisioning,
  writeAlertRuleVersion,
} from "./alert-rule-versions";

const rulerDto = (version: number, provenance?: string) => ({
  expr: "",
  for: "1m",
  keep_firing_for: "0s",
  labels: { team: "sre" },
  annotations: { summary: "s" },
  grafana_alert: {
    uid: "r1",
    title: "R1",
    condition: "C",
    data: [{ refId: "A", datasourceUid: "td", model: { refId: "A" } }],
    namespace_uid: "f",
    rule_group: "g",
    no_data_state: "NoData",
    exec_err_state: "Error",
    is_paused: false,
    version,
    updated: "2026-01-01T00:00:00Z",
    updated_by: { uid: "u1", name: "admin" },
    guid: "x",
    intervalSeconds: 60,
    ...(provenance ? { provenance } : {}),
  },
});

const provisioned = {
  id: 7,
  orgID: 1,
  uid: "r1",
  title: "R1",
  condition: "C",
  data: [{ refId: "A", datasourceUid: "td", model: { refId: "A" } }],
  folderUID: "f",
  ruleGroup: "g",
  noDataState: "NoData",
  execErrState: "Error",
  for: "1m",
  keep_firing_for: "0s",
  labels: { team: "sre" },
  annotations: { summary: "s" },
  isPaused: false,
  notification_settings: null,
  record: null,
  updated: "2026-01-01T00:00:00Z",
};

describe("alert rule versions mapping", () => {
  it("maps a ruler DTO to the provisioning shape so both compare equal", () => {
    expect(comparableAlertRule(rulerToProvisioning(rulerDto(3)))).toEqual(comparableAlertRule(provisioned));
  });

  it("ignores empty optional fields and server bookkeeping", () => {
    expect(
      comparableAlertRule({
        uid: "r",
        labels: {},
        record: null,
        keep_firing_for: "0s",
        isPaused: false,
        id: 1,
        provenance: "api",
      }),
    ).toEqual({ uid: "r" });
  });
});

describe("writeAlertRuleVersion", () => {
  const calls: Array<{ method: string; headers: Record<string, string> }> = [];
  const serve = (version: number, provenance?: string) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          method: init?.method || "GET",
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        const body =
          init?.method === "PUT"
            ? {}
            : rulerDto(version + calls.filter((call) => call.method === "PUT").length, provenance);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
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

  it("sends X-Disable-Provenance only for rules without provenance", async () => {
    serve(3);
    const current = await getCurrentAlertRule(client(), "r1");
    await writeAlertRuleVersion(client(), current, { ...current.rule, title: "old" });
    expect(calls.find((call) => call.method === "PUT")?.headers["x-disable-provenance"]).toBe("true");

    calls.length = 0;
    serve(3, "api");
    const api = await getCurrentAlertRule(client(), "r1");
    const after = await writeAlertRuleVersion(client(), api, { ...api.rule, title: "old" });
    expect(calls.find((call) => call.method === "PUT")?.headers["x-disable-provenance"]).toBeUndefined();
    expect(after.version).toBe(4);
  });

  it("refuses file-provisioned rules and rules that moved since review", async () => {
    serve(3, "file");
    const file = await getCurrentAlertRule(client(), "r1");
    await expect(writeAlertRuleVersion(client(), file, file.rule)).rejects.toThrow("provisioned from file");

    serve(5);
    const stale = { ...(await getCurrentAlertRule(client(), "r1")), version: 4 };
    await expect(writeAlertRuleVersion(client(), stale, stale.rule)).rejects.toThrow(
      "changed after version 4",
    );
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });
});
