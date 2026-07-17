import { describe, expect, it } from "vitest";
import { __test__ } from "./cli";
import { calcClsInterval } from "./lib/cls-interval";
import { parsePositiveInt, parsePositiveNumber, parseRenderScale } from "./utils";

describe("cli internal unit tests", () => {
  it("extracts custom $__all values from query fallback", () => {
    const vars = __test__.extractTemplatingValues({
      templating: {
        list: [
          {
            name: "env",
            type: "custom",
            query: "sample-a,sample-b,sample-c",
            options: [],
            current: { value: "$__all" },
          },
        ],
      },
    });
    expect(vars.env).toEqual(["sample-a", "sample-b", "sample-c"]);
  });

  it("extracts empty textbox variables for validation", () => {
    const vars = __test__.extractTemplatingValues({
      templating: { list: [{ name: "filter", type: "textbox", current: { value: "" } }] },
    });
    expect(vars.filter).toBe("");
  });

  it("extracts Grafana dashboard v2 variables", () => {
    const vars = __test__.extractTemplatingValues({
      variables: [
        { kind: "CustomVariable", spec: { name: "env", current: { value: "sample-env" } } },
        {
          kind: "CustomVariable",
          spec: {
            name: "provider",
            current: { value: "$__all" },
            allValue: ".*",
          },
        },
      ],
    });
    expect(vars.env).toBe("sample-env");
    expect(vars.provider).toBe(".*");
  });

  it("supports where/set expressions", () => {
    expect(__test__.parseWhereExpr("a.b=1")).toEqual({ path: "a.b", value: 1 });
    expect(__test__.parseSetExpr('title="abc"')).toEqual({ path: "title", value: "abc" });
    expect(__test__.parseSetExpr("123", "count")).toEqual({ path: "count", value: 123 });
  });

  it("parses render vars and builds render path", () => {
    expect(__test__.parseRenderVar("env=prod")).toEqual({ key: "env", value: "prod" });
    expect(() => __test__.parseRenderVar("kiosk", "--render-param")).toThrow(
      "Invalid --render-param expression",
    );
    expect(parsePositiveInt("1200", 1)).toBe(1200);
    expect(() => parsePositiveInt("1200px", 1)).toThrow("Invalid positive integer");
    expect(parsePositiveNumber("1.5", 1)).toBe(1.5);
    expect(() => parsePositiveNumber("1.5x", 1)).toThrow("Invalid positive number");
    expect(parseRenderScale(undefined, true)).toBe(2);
    expect(parseRenderScale("1.5", false)).toBe(1.5);
    expect(() => parseRenderScale("5", false)).toThrow("Maximum is 4");
    const renderPath = __test__.buildRenderPanelPath({
      dashboardUid: "abc123",
      panelId: 7,
      from: "now-1h",
      to: "now",
      width: 1200,
      height: 800,
      scale: 2,
      tz: "UTC",
      theme: "light",
      vars: ["env=prod", "region=ap-southeast-1"],
      renderParams: ["kiosk=1", "timeout=120"],
    });
    expect(renderPath).toContain("/render/d-solo/abc123/_");
    expect(renderPath).toContain("panelId=7");
    expect(renderPath).toContain("scale=2");
    expect(renderPath).toContain("kiosk=1");
    expect(renderPath).toContain("timeout=120");
    expect(renderPath).toContain("var-env=prod");
  });

  it("parses validate options helpers", () => {
    const envRef = "$" + "{env}";
    const envPipeRef = "$" + "{env:pipe}";
    const envCsvRef = "$" + "{env:csv}";
    const envSingleQuoteRef = "$" + "{env:singlequote}";
    const envDoubleQuoteRef = "$" + "{env:doublequote}";
    const dsRef = "$" + "{ds}";
    const childRef = "$" + "{child}";
    expect(__test__.parseSkipPanelIds("1,2,2,3")).toEqual([1, 2, 3]);
    expect(__test__.parseVarAssignments(["env=prod", "region=ap"]).env).toBe("prod");
    expect(__test__.resolveTemplateString(`${envRef}-$__from`, { env: "prod", __from: "1000" })).toBe(
      "prod-1000",
    );
    expect(__test__.resolveTemplateString(envPipeRef, { env: ["sample-model-a", "sample-model-b"] })).toBe(
      "sample-model-a|sample-model-b",
    );
    expect(__test__.resolveTemplateString(envCsvRef, { env: ["sample-model-a", "sample-model-b"] })).toBe(
      "sample-model-a,sample-model-b",
    );
    expect(
      __test__.resolveTemplateString(envSingleQuoteRef, { env: ["sample-model-a", "sample-model-b"] }),
    ).toBe("'sample-model-a','sample-model-b'");
    expect(__test__.resolveTemplateString(envSingleQuoteRef, { env: "sample-model-a" })).toBe(
      "'sample-model-a'",
    );
    expect(
      __test__.resolveTemplateString(envDoubleQuoteRef, { env: ["sample-model-a", "sample-model-b"] }),
    ).toBe('"sample-model-a","sample-model-b"');
    expect(__test__.resolveDatasourceUid(dsRef, undefined, { ds: "pg-main" })).toBe("pg-main");
    expect(__test__.resolveDatasourceUid("-- Mixed --", childRef, { child: "pg-replica" })).toBe(
      "pg-replica",
    );
    expect(__test__.resolveTemplateString("$__from::bigint", { __from: "1700000000000" })).toBe(
      "1700000000000::bigint",
    );
    const intervalRef = "$" + "{__interval_ms}";
    const timeFromRef = "$" + "{__timeFrom}";
    const timeFilterRef = "$" + "{__timeFilter}";
    expect(__test__.resolveTemplateString(`${intervalRef} millisecond`, { __interval_ms: "60000" })).toBe(
      "60000 millisecond",
    );
    expect(__test__.resolveTemplateString(`${timeFromRef}`, { __timeFrom: "to_timestamp(1700000000)" })).toBe(
      "to_timestamp(1700000000)",
    );
    expect(
      __test__.resolveTemplateString(`WHERE ${timeFilterRef}`, {
        __timeFilter: '"time" BETWEEN to_timestamp(1700000000) AND to_timestamp(1700003600)',
      }),
    ).toBe('WHERE "time" BETWEEN to_timestamp(1700000000) AND to_timestamp(1700003600)');
    expect(
      __test__.resolveTemplateString("WHERE $__timeFilter(ts)", {
        __timeFrom: "to_timestamp(1700000000)",
        __timeTo: "to_timestamp(1700003600)",
      }),
    ).toBe('WHERE "ts" BETWEEN to_timestamp(1700000000) AND to_timestamp(1700003600)');
    expect(
      __test__.resolveTemplateString("to_char($__timeFrom()::date, 'YYYYMMDD')", {
        __timeFrom: "to_timestamp(1700000000)",
      }),
    ).toBe("to_char(to_timestamp(1700000000)::date, 'YYYYMMDD')");
  });

  it("detects query mode and resolves datasource identifier", () => {
    const flags1 = __test__.detectQueryMode("dashboard", { query: [] });
    expect(flags1.isQuickQueryMode).toBe(false);
    expect(flags1.resourceAlias).toBe("dashboards");

    const flags2 = __test__.detectQueryMode("my-ds", { sql: "select 1", query: [] });
    expect(flags2.isQuickQueryMode).toBe(true);
    expect(__test__.resolveQueryDatasourceIdentifier("my-ds", {}, flags2)).toBe("my-ds");

    const flags3 = __test__.detectQueryMode("dashboard", { sql: "select 1", query: [] });
    expect(() => __test__.resolveQueryDatasourceIdentifier("dashboard", {}, flags3)).toThrow(
      "conflicts with datasource query mode",
    );
  });

  it("normalizes render target", () => {
    expect(__test__.normalizeRenderTarget("panel")).toBe("panel");
    expect(__test__.normalizeRenderTarget("dashboard")).toBe("dashboard");
    expect(() => __test__.normalizeRenderTarget("dash")).toThrow("Unsupported render target");
  });

  it("parses query assignment and resolves relative time", () => {
    expect(__test__.parseQueryAssignment("logServiceParams.SyntaxRule=1")).toEqual({
      path: "logServiceParams.SyntaxRule",
      value: 1,
    });
    const now = 1_700_000_000_000;
    expect(__test__.resolveTimeToMs("now", now)).toBe(now);
    expect(__test__.resolveTimeToMs("now-1h", now)).toBe(now - 3_600_000);
    expect(__test__.resolveTimeToMs("1700000000", now)).toBe(1_700_000_000_000);
    expect(__test__.msToInterval(60_000)).toBe("1m");
    expect(__test__.msToInterval(3_600_000)).toBe("1h");
    expect(__test__.msToInterval(86_400_000)).toBe("1d");
    expect(calcClsInterval(0, 3_600_000)).toBe("1 minute");
    expect(calcClsInterval(0, 21_600_000)).toBe("5 minute");
    expect(calcClsInterval(0, 86_400_000)).toBe("10 minute");
    expect(calcClsInterval(0, 2_592_000_000)).toBe("6 hour");
  });

  it("finds unresolved template tokens", () => {
    const knownCsv = "$" + "{known:csv}";
    expect(__test__.findUnresolvedTemplateTokens({ a: "$__unknown", b: knownCsv })).toEqual([
      "$__unknown",
      knownCsv,
    ]);
  });
});
