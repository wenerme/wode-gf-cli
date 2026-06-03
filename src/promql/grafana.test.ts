import { describe, expect, it } from "vitest";
import {
  GrafanaPromQLMacroError,
  normalizeGrafanaPromQLTemplates,
  parseGrafanaPromQL,
  parseGrafanaPromQLMacroMode,
  prepareGrafanaPromQLExpression,
  scanGrafanaPromQLTemplates,
  validateGrafanaPromQLSyntax,
} from "./grafana";

const envRegex = "$" + "{env:regex}";
const fromDate = "$" + "{__from:date:YYYY-MM}";
const fromRef = "$" + "{__from}";
const dsUid = "$" + "{ds.uid}";
const modelsPipe = "$" + "{models:pipe}";

describe("Grafana PromQL macro preflight", () => {
  it("scans Grafana template and macro tokens with string context", () => {
    const expr = `sum(rate(foo{job="$job", env=~"${envRegex}", old="[[legacy:csv]]"}[$__rate_interval]))`;
    const tokens = scanGrafanaPromQLTemplates(expr);

    expect(
      tokens.map((token) => ({
        raw: token.raw,
        name: token.name,
        format: token.format,
        inString: token.inString,
      })),
    ).toEqual([
      { raw: "$job", name: "job", format: undefined, inString: true },
      { raw: envRegex, name: "env", format: "regex", inString: true },
      { raw: "[[legacy:csv]]", name: "legacy", format: "csv", inString: true },
      { raw: "$__rate_interval", name: "__rate_interval", format: undefined, inString: false },
    ]);
  });

  it("scans macro calls and field-path braced references", () => {
    const expr = `sum_over_time(foo{ds="${dsUid}"}[$__timeGroup($__interval, 1m)])`;
    const tokens = scanGrafanaPromQLTemplates(expr);

    expect(
      tokens.map((token) => ({
        raw: token.raw,
        kind: token.kind,
        fullName: token.fullName,
        args: token.args,
      })),
    ).toEqual([
      { raw: dsUid, kind: "braced", fullName: "ds.uid", args: [] },
      {
        raw: "$__timeGroup($__interval, 1m)",
        kind: "call",
        fullName: "__timeGroup",
        args: ["$__interval", "1m"],
      },
    ]);
  });

  it("keeps dashboard expressions by default while canonicalizing legacy and unsupported braced syntax", () => {
    const result = validateGrafanaPromQLSyntax(
      `rate(foo{job="[[job]]", env=~"${envRegex}", ts="${fromDate}", ds="${dsUid}"}[$__rate_interval])`,
    );

    expect(result.macroMode).toBe("keep");
    expect(result.normalizedExpression).toBe(
      `rate(foo{job="$job", env=~"${envRegex}", ts="$__from", ds="$ds"}[$__rate_interval])`,
    );
    expect(result.warnings).toEqual([]);
  });

  it("rejects Grafana macros in strict mode", () => {
    expect(() => validateGrafanaPromQLSyntax("rate(foo[$__rate_interval])", { macroMode: "strict" })).toThrow(
      GrafanaPromQLMacroError,
    );
  });

  it("uses syntax-safe presets for common Grafana placeholders", () => {
    const result = validateGrafanaPromQLSyntax(
      `topk($top, sum(rate(foo{env=~"${envRegex}", job="$job"}[$__rate_interval])))`,
      { macroMode: "preset", intervalMs: 30_000 },
    );

    expect(result.normalizedExpression).toBe('topk(1, sum(rate(foo{env=~".*", job="placeholder"}[4m])))');
    expect(result.warnings).toEqual([]);
  });

  it("evaluates supplied vars and time macros, then falls back to presets with warnings", () => {
    const result = validateGrafanaPromQLSyntax(
      `sum(rate(foo{env=~"${envRegex}", job="$job", missing="$missing"}[$__interval])) + $__range_s + ${fromRef}`,
      {
        macroMode: "eval",
        vars: { env: ["prod", "staging"], job: "api" },
        fromMs: 1_594_671_549_254,
        toMs: 1_594_675_149_254,
        intervalMs: 60_000,
      },
    );

    expect(result.normalizedExpression).toBe(
      'sum(rate(foo{env=~"prod|staging", job="api", missing="placeholder"}[1m])) + 3600 + 1594671549254',
    );
    expect(result.warnings).toEqual(["using preset for unresolved Grafana macro/template $missing"]);
  });

  it("supports common Grafana variable formatters in eval mode", () => {
    expect(
      normalizeGrafanaPromQLTemplates(`foo{env=~"${envRegex}", model=~"$model"}`, {
        macroMode: "eval",
        vars: { env: ["prod", "staging"], model: "gpt-4" },
      }).normalizedExpression,
    ).toBe('foo{env=~"prod|staging", model=~"gpt-4"}');

    expect(
      normalizeGrafanaPromQLTemplates(`label_replace(up, 'x', ${modelsPipe}, 'y', '$1')`, {
        macroMode: "eval",
        vars: { models: ["gpt-4", "kimi"] },
      }).normalizedExpression,
    ).toBe("label_replace(up, 'x', gpt-4|kimi, 'y', '$1')");
  });

  it("preserves escaped string safety while evaluating values", () => {
    const result = prepareGrafanaPromQLExpression('foo{label="$value"}', {
      macroMode: "eval",
      vars: { value: 'a"b\\c' },
    });

    expect(result.normalizedExpression).toBe('foo{label="a\\"b\\\\c"}');
    validateGrafanaPromQLSyntax(result.normalizedExpression, { macroMode: "keep" });
  });

  it("parses normalized Grafana PromQL and validates macro mode input", () => {
    expect(parseGrafanaPromQLMacroMode("PRESET")).toBe("preset");
    expect(() => parseGrafanaPromQLMacroMode("expand")).toThrow("Unsupported PromQL macro mode");

    const parsed = parseGrafanaPromQL(`sum(rate(foo{env=~"${envRegex}"}[$__rate_interval]))`, {
      macroMode: "preset",
    });
    expect(parsed.type).toBe("AggregateExpression");
  });
});
