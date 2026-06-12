import { describe, expect, it } from "vitest";
import {
  extractAlertRuleQueries,
  lintAlertRuleThresholds,
  validateAlertRuleExpressionRefs,
} from "./alert-rule-ops";
import { applyLegendPresetToDashboard } from "./panel-legend";
import { parsePolicyMatcher, routeLabel, upsertPolicyRoute } from "./policy-route";

const alertRule = {
  uid: "rule-1",
  title: "Foo >=3 alert",
  annotations: { summary: "Foo >=3" },
  data: [
    {
      refId: "A",
      datasourceUid: "cls-main",
      model: {
        datasource: { uid: "cls-main", type: "tencentcloud-cls-datasource" },
        logServiceParams: { Query: "* | select count(*)" },
      },
    },
    {
      refId: "B",
      datasourceUid: "__expr__",
      model: { type: "reduce", expression: "A" },
    },
    {
      refId: "C",
      datasourceUid: "__expr__",
      model: { type: "threshold", expression: "B", evaluator: { type: "gt", params: [4] } },
    },
  ],
};

describe("alert ops helpers", () => {
  it("extracts real alert rule datasource queries and validates expression refs", () => {
    expect(extractAlertRuleQueries(alertRule).map((query) => query.refId)).toEqual(["A"]);
    expect(validateAlertRuleExpressionRefs(alertRule)).toEqual([]);
    expect(
      validateAlertRuleExpressionRefs({
        ...alertRule,
        data: [...alertRule.data, { refId: "D", datasourceUid: "__expr__", model: { expression: "Z" } }],
      }),
    ).toEqual([{ refId: "D", missingRefId: "Z", message: "D references missing refId Z" }]);
  });

  it("lints threshold business semantics", () => {
    const warnings = lintAlertRuleThresholds(alertRule).map((item) => item.message);
    expect(warnings).toContain("threshold C uses gt 4, business semantic is >=5");
    expect(warnings).toContain('title contains ">=3", possible mismatch with >=5');
    expect(warnings).toContain('summary contains ">=3", possible mismatch with >=5');
  });

  it("upserts policy routes idempotently by matcher", () => {
    const policy = { receiver: "default", routes: [] };
    const input = {
      receiver: "KS Feishu",
      matchers: [parsePolicyMatcher('alert_group="ks-claude-anomaly"')],
      groupBy: ["alertname", "env"],
      groupWait: "30s",
    };
    const inserted = upsertPolicyRoute(policy, input);
    expect(inserted.action).toBe("insert");
    expect(routeLabel(inserted.route)).toBe('alert_group="ks-claude-anomaly" -> KS Feishu');

    const unchanged = upsertPolicyRoute(inserted.policy, input);
    expect(unchanged.action).toBe("unchanged");
    expect(unchanged.policy.routes).toHaveLength(1);
  });

  it("applies legend preset only to timeseries panels", () => {
    const dashboard = {
      panels: [
        { id: 1, title: "TS", type: "timeseries", options: {} },
        { id: 2, title: "Table", type: "table", options: {} },
      ],
    };
    const result = applyLegendPresetToDashboard(dashboard, [1, 2], {
      rightTable: true,
      meanDesc: true,
      calcs: ["mean", "max", "sum"],
    });
    expect(result.results.map((item) => item.status)).toEqual(["updated", "skip"]);
    expect(result.dashboard.panels[0].options.legend).toEqual({
      showLegend: true,
      displayMode: "table",
      placement: "right",
      calcs: ["mean", "max", "sum"],
      sortBy: "Mean",
      sortDesc: true,
    });
  });
});
