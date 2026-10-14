import { describe, expect, it } from "vitest";
import {
  decodeAlertmanagerAlerts,
  decodeHistoryFrame,
  decodePrometheusRules,
  failingRules,
  formatDuration,
  normalizeHistoryTimeMs,
  parseAnnotationTextLabels,
  parseLabelFilters,
  RuleStateFilters,
  selectActiveAlerts,
  selectHistoryRows,
  splitListValues,
  validateChoices,
} from "./alert-runtime";
import {
  buildSilencePayload,
  decodeSilences,
  formatMatcher,
  matcherMatchesEmpty,
  parseDurationMs,
  parseLabelMatcher,
  validateSilenceMatchers,
} from "./alert-silence";

const rulesResponse = {
  status: "success",
  data: {
    groups: [
      {
        name: "g1",
        file: "team-folder",
        folderUid: "f1",
        interval: 10,
        rules: [
          {
            uid: "r1",
            name: "R1",
            state: "firing",
            health: "ok",
            type: "alerting",
            isPaused: false,
            lastEvaluation: "2026-01-01T00:00:10Z",
            evaluationTime: 0.01,
            labels: { team: "sre" },
            totals: { alerting: 2, normal: 1 },
            alerts: [
              {
                labels: { alertname: "R1", team: "sre", __alert_rule_uid__: "r1" },
                state: "Alerting",
                activeAt: "2026-01-01T00:00:00Z",
                value: "1e+00",
              },
            ],
          },
          {
            uid: "r2",
            name: "R2",
            state: "inactive",
            health: "error",
            lastError: "datasource timeout",
            isPaused: true,
            lastEvaluation: "0001-01-01T00:00:00Z",
            totals: { error: 1 },
          },
        ],
      },
    ],
    groupNextToken: "next-1",
  },
};

describe("decodePrometheusRules", () => {
  it("flattens groups and normalizes counts", () => {
    const page = decodePrometheusRules(rulesResponse);
    expect(page.nextToken).toBe("next-1");
    expect(page.rules).toHaveLength(2);
    const [r1, r2] = page.rules;
    expect(r1).toMatchObject({
      uid: "r1",
      title: "R1",
      folder: "team-folder",
      folderUid: "f1",
      group: "g1",
      state: "firing",
      counts: { firing: 2, pending: 0, normal: 1, error: 0 },
      labels: { team: "sre" },
    });
    expect(r1?.instances?.[0]?.labels).toEqual({ alertname: "R1", team: "sre" });
    expect(r2).toMatchObject({ isPaused: true, health: "error", lastError: "datasource timeout" });
    expect(r2?.lastEvaluation).toBeUndefined();
    expect(r2?.instances).toBeUndefined();
  });

  it("throws on API error status and tolerates empty data", () => {
    expect(() => decodePrometheusRules({ status: "error", error: "unknown state 'x'" })).toThrow(
      "unknown state 'x'",
    );
    expect(decodePrometheusRules({ status: "success", data: { groups: [] } }).rules).toEqual([]);
  });

  it("evaluates --fail-on against state, health, and counts", () => {
    const { rules } = decodePrometheusRules(rulesResponse);
    expect(failingRules(rules, ["firing"]).map((rule) => rule.uid)).toEqual(["r1"]);
    expect(failingRules(rules, ["error"]).map((rule) => rule.uid)).toEqual(["r2"]);
    expect(failingRules(rules, ["nodata", "pending"])).toEqual([]);
    expect(failingRules(rules, [])).toEqual([]);
  });

  it("validates filter choices; rule state filters exclude error/nodata (Grafana ignores them for rules)", () => {
    expect(
      validateChoices(splitListValues(["Firing,pending", "inactive"]), RuleStateFilters, "--state"),
    ).toEqual(["firing", "pending", "inactive"]);
    expect(() => validateChoices(["bogus"], RuleStateFilters, "--state")).toThrow("Invalid --state value");
    expect(() => validateChoices(["error"], RuleStateFilters, "--state")).toThrow("Invalid --state value");
  });

  it("uses totalsFiltered for counts when instance matchers are applied", () => {
    const response = {
      status: "success",
      data: {
        groups: [
          {
            name: "g",
            rules: [{ uid: "r", name: "R", state: "firing", totals: { alerting: 2 }, totalsFiltered: {} }],
          },
        ],
      },
    };
    expect(decodePrometheusRules(response).rules[0]?.counts.firing).toBe(2);
    expect(decodePrometheusRules(response, { filteredTotals: true }).rules[0]?.counts.firing).toBe(0);
  });
});

describe("decodeHistoryFrame", () => {
  const fields = ["time", "text", "prev", "next", "data"].map((name) => ({ name }));
  const annotationFrame = {
    schema: { name: "states", fields },
    data: {
      values: [
        [1767225600000000, 1767225660000000, null],
        [
          "R1 {alertname=R1, team=sre} - B=5.000000",
          "R1 {alertname=R1, team=ops} - B=1.000000",
          "R1 {alertname=R1}",
        ],
        ["Normal", "Alerting", "Normal"],
        ["Alerting", "Normal", "Pending"],
        ['{"values":{"B":5,"C":1}}', null, "{}"],
      ],
    },
  };

  it("decodes annotation frames and scales the inflated time column to ms", () => {
    const rows = decodeHistoryFrame(annotationFrame);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      time: "2026-01-01T00:00:00.000Z",
      timeMs: 1767225600000,
      prev: "Normal",
      next: "Alerting",
      labels: { alertname: "R1", team: "sre" },
      values: { B: 5, C: 1 },
    });
    expect(rows[1]?.values).toBeUndefined();
  });

  it("handles empty frames and non-object input", () => {
    expect(decodeHistoryFrame({ schema: { fields }, data: { values: [[], [], [], [], []] } })).toEqual([]);
    expect(decodeHistoryFrame({ schema: { fields } })).toEqual([]);
    expect(decodeHistoryFrame(null)).toEqual([]);
  });

  it("decodes loki frames", () => {
    const rows = decodeHistoryFrame({
      schema: { fields: [{ name: "time" }, { name: "line" }, { name: "labels" }] },
      data: {
        values: [
          [1767225600000],
          [{ previous: "Normal", current: "Error", error: "boom", labels: { team: "sre" }, values: {} }],
          [{ folderUID: "f1" }],
        ],
      },
    });
    expect(rows[0]).toMatchObject({ timeMs: 1767225600000, prev: "Normal", next: "Error", error: "boom" });
    expect(rows[0]?.labels).toEqual({ team: "sre" });
  });

  it("filters by labels client-side, sorts newest first, and limits", () => {
    const rows = decodeHistoryFrame(annotationFrame);
    expect(selectHistoryRows(rows, { labels: { team: "sre" }, limit: 10 }).map((row) => row.timeMs)).toEqual([
      1767225600000,
    ]);
    expect(selectHistoryRows(rows, { labels: {}, limit: 1 }).map((row) => row.timeMs)).toEqual([
      1767225660000,
    ]);
  });

  it("parses helpers", () => {
    expect(normalizeHistoryTimeMs(1767225600000)).toBe(1767225600000);
    expect(parseAnnotationTextLabels("x {a=1, b=c=d} - y")).toEqual({ a: "1", b: "c=d" });
    expect(parseLabelFilters(["team=sre"])).toEqual({ team: "sre" });
    expect(() => parseLabelFilters(["team"])).toThrow("Invalid --label");
    expect(() => parseLabelFilters(["team!=x"])).toThrow("Invalid --label");
  });
});

describe("Alertmanager alerts", () => {
  const response = [
    {
      labels: { alertname: "R1", severity: "warning", team: "sre", __alert_rule_uid__: "r1" },
      annotations: { summary: "s", __values__: "{}" },
      startsAt: "2026-01-01T00:00:00Z",
      fingerprint: "fp1",
      receivers: [{ name: "oncall" }],
      status: { state: "active", silencedBy: [], inhibitedBy: [] },
    },
    {
      labels: { alertname: "R2" },
      fingerprint: "fp2",
      receivers: [],
      status: { state: "suppressed", silencedBy: ["s1"], inhibitedBy: [] },
    },
    {
      labels: { alertname: "R3" },
      fingerprint: "fp3",
      status: { state: "suppressed", silencedBy: [], inhibitedBy: ["fp1"] },
    },
  ];

  it("decodes and hides silenced/inhibited by default", () => {
    const alerts = decodeAlertmanagerAlerts(response);
    expect(alerts[0]).toMatchObject({
      alertname: "R1",
      severity: "warning",
      ruleUid: "r1",
      labels: { alertname: "R1", severity: "warning", team: "sre" },
      annotations: { summary: "s" },
      receivers: ["oncall"],
    });
    const selected = selectActiveAlerts(alerts, { silenced: false, inhibited: false });
    expect(selected.alerts.map((item) => item.fingerprint)).toEqual(["fp1"]);
    expect(selected).toMatchObject({ hiddenSilenced: 1, hiddenInhibited: 1 });
    expect(selectActiveAlerts(alerts, { silenced: true, inhibited: true }).alerts).toHaveLength(3);
    expect(() => decodeAlertmanagerAlerts({})).toThrow("not an array");
  });
});

describe("matchers and silences", () => {
  it("parses all operators and quoted values", () => {
    expect(parseLabelMatcher("team=sre")).toEqual({
      name: "team",
      value: "sre",
      isRegex: false,
      isEqual: true,
    });
    expect(parseLabelMatcher('team!="a b"')).toEqual({
      name: "team",
      value: "a b",
      isRegex: false,
      isEqual: false,
    });
    expect(parseLabelMatcher("env=~prod|stg")).toMatchObject({ isRegex: true, isEqual: true });
    expect(parseLabelMatcher("env!~'dev.*'")).toMatchObject({
      value: "dev.*",
      isRegex: true,
      isEqual: false,
    });
    expect(parseLabelMatcher("team=")).toMatchObject({ value: "" });
    expect(() => parseLabelMatcher("team")).toThrow("Invalid matcher");
    // Regexes are Go RE2: JS-unparseable ones are left for the server to validate, not rejected locally.
    expect(parseLabelMatcher("env=~(")).toMatchObject({ value: "(", isRegex: true });
    expect(matcherMatchesEmpty(parseLabelMatcher("env=~("))).toBe(false);
    // RE2's (?i) prefix is translated, so the empty-match guard still sees through it.
    expect(matcherMatchesEmpty(parseLabelMatcher("team=~(?i).*"))).toBe(true);
    expect(matcherMatchesEmpty(parseLabelMatcher("team=~(?i)SRE"))).toBe(false);
    expect(formatMatcher(parseLabelMatcher('a=x"y'))).toBe('a="x\\"y"');
  });

  it("detects matchers that match the empty string", () => {
    expect(matcherMatchesEmpty(parseLabelMatcher("team=~.*"))).toBe(true);
    expect(matcherMatchesEmpty(parseLabelMatcher("team=~.+"))).toBe(false);
    expect(matcherMatchesEmpty(parseLabelMatcher("team!=x"))).toBe(true);
    expect(matcherMatchesEmpty(parseLabelMatcher("team=sre"))).toBe(false);
    expect(matcherMatchesEmpty(parseLabelMatcher("team!~.+"))).toBe(true);
  });

  it("refuses zero or match-everything matcher sets", () => {
    expect(() => validateSilenceMatchers([])).toThrow("at least one --matcher");
    expect(() => validateSilenceMatchers([parseLabelMatcher("team=~.*")])).toThrow("Refusing silence");
    expect(() =>
      validateSilenceMatchers([parseLabelMatcher("team=~.*"), parseLabelMatcher("env=prod")]),
    ).not.toThrow();
  });

  it("builds payloads and parses durations", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00Z");
    const payload = buildSilencePayload({
      matchers: [parseLabelMatcher("team=sre")],
      nowMs,
      endMs: nowMs + parseDurationMs("1h30m"),
      createdBy: "admin",
      comment: " maintenance ",
    });
    expect(payload).toEqual({
      matchers: [{ name: "team", value: "sre", isRegex: false, isEqual: true }],
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-01T01:30:00.000Z",
      createdBy: "admin",
      comment: "maintenance",
    });
    expect(() => buildSilencePayload({ ...payload, nowMs, endMs: nowMs, comment: "x" })).toThrow(
      "in the future",
    );
    expect(() => buildSilencePayload({ ...payload, nowMs, endMs: nowMs + 1, comment: " " })).toThrow(
      "--comment",
    );
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
    expect(() => parseDurationMs("2 hours")).toThrow("Invalid duration");
    expect(() => parseDurationMs("0m")).toThrow("Invalid duration");
  });

  it("decodes silences and hides expired by default", () => {
    const response = [
      {
        id: "s1",
        status: { state: "expired" },
        matchers: [{ name: "a", value: "1" }],
        endsAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "s2",
        status: { state: "active" },
        matchers: [{ name: "b", value: "x.*", isRegex: true, isEqual: false }],
      },
    ];
    expect(decodeSilences(response, { all: false }).map((item) => item.id)).toEqual(["s2"]);
    const all = decodeSilences(response, { all: true });
    expect(all.map((item) => item.id)).toEqual(["s2", "s1"]);
    expect(all[1]?.matchers[0]).toEqual({ name: "a", value: "1", isRegex: false, isEqual: true });
    expect(formatMatcher(all[0]?.matchers[0] ?? { name: "", value: "", isRegex: false, isEqual: true })).toBe(
      'b!~"x.*"',
    );
  });
});

describe("formatDuration", () => {
  it("formats compact ages", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(65_000)).toBe("1m5s");
    expect(formatDuration(3_720_000)).toBe("1h2m");
    expect(formatDuration(90_000_000)).toBe("1d1h");
  });
});
