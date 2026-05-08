import { describe, expect, it } from "vitest";
import { __test__ } from "./cli";
import { parsePanelRef, replacePanelInDashboard } from "./commands/build-panel";

describe("cli internal unit tests", () => {
  it("parses env file with export/quote/comment", () => {
    const env = __test__.parseEnvFile(
      ["# comment", "A=1", "export B='two'", 'C="three"', "D=four # trailing"].join("\n"),
    );

    expect(env.A).toBe("1");
    expect(env.B).toBe("two");
    expect(env.C).toBe("three");
    expect(env.D).toBe("four");
  });

  it("parses resources and deduplicates", () => {
    const resources = __test__.parseResources("dashboards,datasources,dashboards");
    expect(resources).toEqual(["dashboards", "datasources"]);
  });

  it("fails for unsupported resources", () => {
    expect(() => __test__.parseResources("invalid-resource")).toThrow("Unsupported resource");
  });

  it("infers resource type from object payload", () => {
    expect(__test__.inferResourceFromObject({ dashboard: { uid: "x" } })).toBe("dashboards");
    expect(__test__.inferResourceFromObject({ uid: "u1", title: "Folder A" })).toBe("folders");
    expect(__test__.inferResourceFromObject({ name: "d1", type: "testdata", access: "proxy" })).toBe(
      "datasources",
    );
  });

  it("parses resource aliases for dashboard/connection/folder/policy", () => {
    expect(__test__.parseResourceAlias("dash")).toBe("dashboards");
    expect(__test__.parseResourceAlias("d")).toBe("dashboards");
    expect(__test__.parseResourceAlias("conn")).toBe("datasources");
    expect(__test__.parseResourceAlias("folder")).toBe("folders");
    expect(__test__.parseResourceAlias("policy")).toBe("policies");
  });

  it("parses simple yaml config", () => {
    const parsed = __test__.parseSimpleYamlConfig(
      [
        "context: local",
        "contexts:",
        "  - name: default",
        "    baseUrl: http://127.0.0.1:3300",
        "  - name: local",
        "    baseUrl: http://127.0.0.1:4300",
        "    username: admin",
        "    password: admin",
        "    serviceAccountToken: glsa_xxx",
      ].join("\n"),
    );

    expect(parsed.context).toBe("local");
    expect(parsed.contexts[1]?.name).toBe("local");
    expect(parsed.contexts[1]?.username).toBe("admin");
    expect(parsed.contexts[1]?.serviceAccountToken).toBe("glsa_xxx");
  });

  it("migrates legacy profile keys to context keys", () => {
    const migrated = __test__.migrateLegacyConfig(
      ["profile: local", "profiles:", "  - name: local", "    baseUrl: http://127.0.0.1:3300"].join("\n"),
    );

    expect(migrated).toContain("context: local");
    expect(migrated).toContain("contexts:");
    expect(migrated).not.toContain("profile:");
    expect(migrated).not.toContain("profiles:");
  });

  it("extracts custom $__all values from query fallback", () => {
    const vars = __test__.extractTemplatingValues({
      templating: {
        list: [
          {
            name: "env",
            type: "custom",
            query: "prod,staging,dev",
            options: [],
            current: { value: "$__all" },
          },
        ],
      },
    });
    expect(vars.env).toEqual(["prod", "staging", "dev"]);
  });

  it("supports where/set expressions", () => {
    expect(__test__.parseWhereExpr("a.b=1")).toEqual({ path: "a.b", value: 1 });
    expect(__test__.parseSetExpr('title="abc"')).toEqual({ path: "title", value: "abc" });
    expect(__test__.parseSetExpr("123", "count")).toEqual({ path: "count", value: 123 });
  });

  it("parses render vars and builds render path", () => {
    expect(__test__.parseRenderVar("env=prod")).toEqual({ key: "env", value: "prod" });
    const renderPath = __test__.buildRenderPanelPath({
      dashboardUid: "abc123",
      panelId: 7,
      from: "now-1h",
      to: "now",
      width: 1200,
      height: 800,
      tz: "UTC",
      theme: "light",
      vars: ["env=prod", "region=ap-southeast-1"],
    });
    expect(renderPath).toContain("/render/d-solo/abc123/_");
    expect(renderPath).toContain("panelId=7");
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
    expect(__test__.resolveTemplateString(envPipeRef, { env: ["gpt-4", "kimi-k2.5"] })).toBe(
      "gpt-4|kimi-k2.5",
    );
    expect(__test__.resolveTemplateString(envCsvRef, { env: ["gpt-4", "kimi-k2.5"] })).toBe(
      "gpt-4,kimi-k2.5",
    );
    expect(__test__.resolveTemplateString(envSingleQuoteRef, { env: ["gpt-4", "kimi-k2.5"] })).toBe(
      "'gpt-4','kimi-k2.5'",
    );
    expect(__test__.resolveTemplateString(envSingleQuoteRef, { env: "gpt-4" })).toBe("'gpt-4'");
    expect(__test__.resolveTemplateString(envDoubleQuoteRef, { env: ["gpt-4", "kimi-k2.5"] })).toBe(
      '"gpt-4","kimi-k2.5"',
    );
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
  });

  it("gets and sets nested path values", () => {
    const target: Record<string, unknown> = {};
    __test__.setPathValue(target, "a.b[0].name", "alice");
    expect(__test__.getPathValue(target, "a.b[0].name")).toBe("alice");
  });

  it("parses panel refs and replaces nested panels", () => {
    expect(parsePanelRef("dash-uid/12")).toEqual({ dashboard: "dash-uid", panelId: 12 });
    expect(() => parsePanelRef("dash-uid")).toThrow("Panel ref must be DASH/PANEL");
    expect(() => parsePanelRef("dash-uid/panel-a")).toThrow("numeric panel id");

    const dashboard = {
      panels: [
        { id: 1, title: "A" },
        { id: 2, title: "Row", panels: [{ id: 3, title: "Nested" }] },
      ],
    };
    const updated = replacePanelInDashboard(dashboard, 3, { id: 3, title: "Next" });
    expect(updated.panels[1].panels[0].title).toBe("Next");
    expect(dashboard.panels[1].panels[0].title).toBe("Nested");
  });

  it("deep merges objects and replaces arrays", () => {
    const merged = __test__.deepMerge(
      { a: { b: 1 }, arr: [1, 2], keep: true },
      { a: { c: 2 }, arr: [3], next: "x" },
    ) as {
      a: { b: number; c: number };
      arr: number[];
      keep: boolean;
      next: string;
    };

    expect(merged.a).toEqual({ b: 1, c: 2 });
    expect(merged.arr).toEqual([3]);
    expect(merged.keep).toBe(true);
    expect(merged.next).toBe("x");
  });
});
