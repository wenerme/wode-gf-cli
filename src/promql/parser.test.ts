import { describe, expect, it } from "vitest";
import type { PromQLExpression, PromQLSubqueryExpression } from "./index";
import { collectPromQLTemplateRefs, PromQLParseError, parsePromQL, validatePromQLSyntax } from "./index";

const bracedEnvName = "$" + "{env_name}";
const bracedEnvRegex = "$" + "{env:regex}";

function collectSubqueries(expr: PromQLExpression): PromQLSubqueryExpression[] {
  const out: PromQLSubqueryExpression[] = [];
  const visit = (node: PromQLExpression) => {
    switch (node.type) {
      case "SubqueryExpression":
        out.push(node);
        visit(node.expression);
        return;
      case "CallExpression":
        for (const arg of node.arguments) visit(arg);
        return;
      case "AggregateExpression":
        for (const arg of node.arguments) visit(arg);
        return;
      case "BinaryExpression":
        visit(node.left);
        visit(node.right);
        return;
      case "UnaryExpression":
        visit(node.argument);
        return;
      case "ParenthesizedExpression":
        visit(node.expression);
        return;
      default:
        return;
    }
  };
  visit(expr);
  return out;
}

describe("promql parser", () => {
  it("parses Grafana macro-heavy PromQL from dashboard examples", () => {
    const expr = parsePromQL(
      `avg by (env,rollouts_pod_template_hash) (rate(container_cpu_usage_seconds_total{container="server",env=~"${bracedEnvName}"}[$__rate_interval]) * on(pod,env) group_left(rollouts_pod_template_hash) go_goroutines{app="server",env=~"${bracedEnvName}"})`,
    );

    expect(expr.type).toBe("AggregateExpression");
    if (expr.type !== "AggregateExpression") throw new Error("expected aggregate");
    expect(expr.operator).toBe("avg");
    expect(expr.grouping).toEqual({
      type: "AggregateGrouping",
      modifier: "by",
      labels: ["env", "rollouts_pod_template_hash"],
    });
    expect(collectPromQLTemplateRefs(expr).map((ref) => ref.raw)).toEqual([
      bracedEnvName,
      "$__rate_interval",
      bracedEnvName,
    ]);
  });

  it("parses function calls, vector matching, and duration macros", () => {
    const expr = parsePromQL(
      'rate(http_requests_total{job=~"$job",instance!=""}[$__interval]) / ignoring(instance) group_left sum(up{job="$job"})',
    );

    expect(expr.type).toBe("BinaryExpression");
    if (expr.type !== "BinaryExpression") throw new Error("expected binary");
    expect(expr.operator).toBe("/");
    expect(expr.vectorMatching).toEqual({
      type: "VectorMatching",
      labelMatching: { operator: "ignoring", labels: ["instance"] },
      groupModifier: { operator: "group_left", labels: [] },
    });
    expect(collectPromQLTemplateRefs(expr).map((ref) => ref.name)).toEqual(["job", "__interval", "job"]);
  });

  it("parses scalar macros and braced formatter macros", () => {
    const expr = parsePromQL(
      `histogram_quantile(0.95, sum by (le) (rate(bucket{env=~"${bracedEnvRegex}"}[5m])))`,
    );

    expect(expr.type).toBe("CallExpression");
    expect(collectPromQLTemplateRefs(expr)).toEqual([
      { type: "TemplateRef", raw: bracedEnvRegex, name: "env", format: "regex", braced: true },
    ]);
  });

  it("parses real dashboard subquery range and template resolution", () => {
    const expr = parsePromQL(`
      avg_over_time(
        (avg by (env, rollouts_pod_template_hash) (
          go_goroutines{app="thirdparty-api-adapter", env=~"${bracedEnvName}", pod=~"$fusion_pod"}
        ))[30m:$__interval]
      )
      +
      3 * stddev_over_time(
        (avg by (env, rollouts_pod_template_hash) (
          go_goroutines{app="thirdparty-api-adapter", env=~"${bracedEnvName}", pod=~"$fusion_pod"}
        ))[30m:$__interval]
      )
    `);

    const subqueries = collectSubqueries(expr);
    expect(subqueries).toHaveLength(2);
    expect(subqueries.map((subquery) => subquery.range.raw)).toEqual(["30m", "30m"]);
    expect(subqueries.map((subquery) => subquery.resolution)).toEqual([
      { type: "TemplateRef", raw: "$__interval", name: "__interval", format: undefined, braced: false },
      { type: "TemplateRef", raw: "$__interval", name: "__interval", format: undefined, braced: false },
    ]);
    expect(collectPromQLTemplateRefs(expr).map((ref) => ref.raw)).toEqual([
      bracedEnvName,
      "$fusion_pod",
      "$__interval",
      bracedEnvName,
      "$fusion_pod",
      "$__interval",
    ]);
  });

  it("parses real dashboard subqueries with comments", () => {
    const expr = parsePromQL(`# baseline RPM
      avg_over_time(
        (
          sum by (model) (rate(ai_fusion_provider_request_latency_count{env=~"${bracedEnvName}",model=~"$model"}[$__rate_interval])) * 60
        )[15m:$__interval]
      )
      +
      # 3-sigma
      3 * stddev_over_time(
        (
          sum by (model) (rate(ai_fusion_provider_request_latency_count{env=~"${bracedEnvName}",model=~"$model"}[$__rate_interval])) * 60
        )[15m:$__interval]
      )`);

    expect(collectSubqueries(expr).map((subquery) => subquery.range.raw)).toEqual(["15m", "15m"]);
    expect(collectPromQLTemplateRefs(expr).map((ref) => ref.raw)).toContain("$__interval");
  });

  it("rejects duplicate label selectors found in dashboards and accepts merged matchers", () => {
    expect(() =>
      parsePromQL(
        `go_gc_duration_seconds{app="faas-llm-api",env=~"${bracedEnvName}",pod=~"$pod"}{quantile="0.5"}`,
      ),
    ).toThrow(PromQLParseError);

    const expr = parsePromQL(
      `go_gc_duration_seconds{app="faas-llm-api",env=~"${bracedEnvName}",pod=~"$pod",quantile="0.5"}`,
    );

    expect(expr.type).toBe("VectorSelector");
    if (expr.type !== "VectorSelector") throw new Error("expected vector selector");
    expect(expr.matchers.map((matcher) => matcher.label)).toEqual(["app", "env", "pod", "quantile"]);
  });

  it("validates syntax and reports parse errors with location", () => {
    expect(() => validatePromQLSyntax("sum(rate(foo[5m]))")).not.toThrow();
    expect(() => validatePromQLSyntax('sum(rate(foo{job="api"}[5m])')).toThrow(PromQLParseError);
    expect(() => validatePromQLSyntax('sum(rate(foo{job="api"}[5m])')).toThrow(/at 1:/);
  });
});
