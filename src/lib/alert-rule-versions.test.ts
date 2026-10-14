import { describe, expect, it } from "vitest";
import { comparableAlertRule, rulerToProvisioning } from "./alert-rule-versions";

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
