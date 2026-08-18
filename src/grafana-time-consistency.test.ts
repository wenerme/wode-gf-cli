import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCliProgram } from "./cli";
import { validateDashboards } from "./dashboard/validation";
import { buildGrafanaMacros, resolveTemplateString } from "./lib/template-vars";
import { buildRenderDashboardPath, buildRenderPanelPath } from "./utils";

const FromDateRef = "$" + "{__from:date:YYYYMMDD}";
const ToDateRef = "$" + "{__to:date:YYYYMMDD}";
const UnsupportedTimeRef = "$" + "{__from:unix}";
const UnsupportedDateRef = "$" + "{__from:date:BOGUS}";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function queryResponse(refId: string): Record<string, unknown> {
  return {
    results: {
      [refId]: {
        frames: [{ schema: { fields: [{ name: "value", type: "number" }] }, data: { values: [[1]] } }],
      },
    },
  };
}

afterEach(() => {
  process.exitCode = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Grafana 时间变量一致性", () => {
  it("按显式时区格式化 date 变量并展开 MySQL 时间宏", () => {
    const fromMs = Date.parse("2026-08-17T16:00:00.000Z");
    const toMs = Date.parse("2026-08-18T15:59:59.000Z");
    const vars = buildGrafanaMacros({ from: fromMs, to: toMs, intervalMs: 300_000, datasourceType: "mysql" });
    const sql = resolveTemplateString(
      `SELECT '${FromDateRef}' AS from_dt,
              '${ToDateRef}' AS to_dt,
              $__unixEpochFrom() AS from_epoch,
              $__unixEpochTo() AS to_epoch,
              $__timeGroupAlias(record_at,$__interval)
       FROM sample WHERE $__timeFilter(record_at)`,
      vars,
      { timeZone: "Asia/Shanghai", datasourceType: "mysql" },
    );

    expect(sql).toContain("'20260818' AS from_dt");
    expect(sql).toContain("'20260818' AS to_dt");
    expect(sql).toContain(`${Math.floor(fromMs / 1000)} AS from_epoch`);
    expect(sql).toContain(`${Math.floor(toMs / 1000)} AS to_epoch`);
    expect(sql).toContain('UNIX_TIMESTAMP(record_at) DIV 300 * 300 AS "time"');
    expect(sql).toContain(
      `record_at BETWEEN FROM_UNIXTIME(${Math.floor(fromMs / 1000)}) AND FROM_UNIXTIME(${Math.floor(toMs / 1000)})`,
    );
  });

  it("以 UTC 为默认时区并拒绝不支持的时间 formatter", () => {
    const fromMs = Date.parse("2026-08-17T16:00:00.000Z");
    const vars = buildGrafanaMacros({ from: fromMs, to: fromMs + 1000 });

    expect(resolveTemplateString(FromDateRef, vars)).toBe("20260817");
    expect(() => resolveTemplateString(UnsupportedTimeRef, vars)).toThrow(
      "Unsupported Grafana time formatter: unix",
    );
    expect(() => resolveTemplateString(UnsupportedDateRef, vars)).toThrow(
      "Unsupported Grafana date format: BOGUS",
    );
    expect(
      resolveTemplateString("WHERE $__timeFilter()", {
        __timeFilter: '"time" BETWEEN to_timestamp(1) AND to_timestamp(2)',
      }),
    ).toBe('WHERE "time" BETWEEN to_timestamp(1) AND to_timestamp(2)');
  });

  it("render 将 ISO 绝对时间转成毫秒并保留相对时间与毫秒 epoch", () => {
    const fromIso = "2026-08-18T08:00:00+08:00";
    const toEpoch = "1787068799000";
    const panelPath = buildRenderPanelPath({
      dashboardUid: "sla-preview",
      panelId: 29,
      from: fromIso,
      to: toEpoch,
      width: 1600,
      height: 900,
      tz: "Asia/Shanghai",
      theme: "light",
      vars: [],
    });
    const dashboardPath = buildRenderDashboardPath({
      dashboardUid: "sla-preview",
      from: "now-6h",
      to: "now",
      width: 1600,
      height: 900,
      tz: "UTC",
      theme: "light",
      vars: [],
    });

    const panelUrl = new URL(panelPath, "http://local");
    const dashboardUrl = new URL(dashboardPath, "http://local");
    expect(panelUrl.searchParams.get("from")).toBe(String(Date.parse(fromIso)));
    expect(panelUrl.searchParams.get("to")).toBe(toEpoch);
    expect(dashboardUrl.searchParams.get("from")).toBe("now-6h");
    expect(dashboardUrl.searchParams.get("to")).toBe("now");
    expect(dashboardUrl.searchParams.has("tz")).toBe(true);
    const dashboardTimeZonePath = buildRenderDashboardPath({
      dashboardUid: "sla-preview",
      from: "now-6h",
      to: "now",
      width: 1600,
      height: 900,
      theme: "light",
      vars: [],
    });
    expect(new URL(dashboardTimeZonePath, "http://local").searchParams.has("tz")).toBe(false);
    expect(() =>
      buildRenderPanelPath({
        dashboardUid: "sla-preview",
        panelId: 29,
        from: "2026-08-18 invalid",
        to: "now",
        width: 1600,
        height: 900,
        tz: "UTC",
        theme: "light",
        vars: [],
      }),
    ).toThrow("Invalid time expression");
  });

  it("query 使用同一时区格式化宏并向 API 发送绝对毫秒", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/datasources")) {
          return jsonResponse([{ uid: "mysql-main", name: "mysql-main", type: "mysql" }]);
        }
        requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        return jsonResponse(queryResponse("A"));
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCliProgram().parseAsync([
      "node",
      "wode-gf-cli",
      "--url",
      "http://127.0.0.1:3000",
      "--quiet",
      "query",
      "mysql-main",
      "--sql",
      `SELECT '${FromDateRef}', $__unixEpochFrom()`,
      "--from",
      "2026-08-18T08:00:00+08:00",
      "--to",
      "2026-08-18T23:59:59+08:00",
      "--tz",
      "Asia/Shanghai",
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      from: String(Date.parse("2026-08-18T08:00:00+08:00")),
      to: String(Date.parse("2026-08-18T23:59:59+08:00")),
      queries: [
        { rawSql: `SELECT '20260818', ${Math.floor(Date.parse("2026-08-18T08:00:00+08:00") / 1000)}` },
      ],
    });
  });

  it("validate 展开 23 条 Doris 风格查询且不报告 unresolved token", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        requests.push(body);
        const queries = body.queries as Array<{ refId: string }>;
        return jsonResponse(queryResponse(queries[0]?.refId || "A"));
      }),
    );
    const targets = Array.from({ length: 23 }, (_, index) => ({
      refId: `Q${index + 1}`,
      datasource: { uid: "doris", type: "mysql" },
      rawSql: `SELECT '${FromDateRef}' AS from_dt, $__unixEpochFrom() AS from_epoch WHERE $__timeFilter(record_at)`,
      format: "table",
    }));
    const dashboard = {
      dashboard: {
        title: "SLA",
        timezone: "Asia/Shanghai",
        panels: [{ id: 29, title: "Doris SLA", datasource: { uid: "doris", type: "mysql" }, targets }],
      },
    };

    const result = await validateDashboards(
      {
        url: "http://127.0.0.1:3000",
        timeoutMs: 1000,
        dryRun: false,
        debug: false,
        output: "text",
        quiet: true,
      },
      [dashboard],
      {
        from: "2026-08-17T16:00:00.000Z",
        to: "2026-08-18T15:59:59.000Z",
        timeoutMs: 1000,
        intervalMs: 60_000,
        concurrency: 1,
        failFast: false,
        skipPanelIds: [],
        vars: {},
      },
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(requests).toHaveLength(23);
    for (const request of requests) {
      const queries = request.queries as Array<{ rawSql: string }>;
      expect(queries[0]?.rawSql).toContain("'20260818' AS from_dt");
      expect(queries[0]?.rawSql).not.toContain("$__");
    }
  });
});
