import { afterEach, describe, expect, it, vi } from "vitest";
import { validateDashboards } from "./validation";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validationOptions(vars: Record<string, string> = {}) {
  return {
    from: "now-24h",
    to: "now",
    timeoutMs: 1000,
    intervalMs: 60_000,
    concurrency: 1,
    failFast: false,
    skipPanelIds: [],
    vars,
  };
}

function validationContext() {
  return {
    url: "http://127.0.0.1:3000",
    timeoutMs: 1000,
    dryRun: false,
    debug: false,
    output: "text" as const,
    quiet: true,
  };
}

function panelTimeFromDashboard(
  value: string | string[],
  query = "30m,1h,3h,6h",
  options: Array<{ selected: boolean; text: string; value: string }> = [],
) {
  return {
    apiVersion: "dashboard.grafana.app/v2beta1",
    kind: "Dashboard",
    metadata: { name: "panel-time-from" },
    spec: {
      title: "panel-time-from",
      timeSettings: { timezone: "utc", fiscalYearStartMonth: 0, weekStart: "sunday" },
      variables: [
        {
          kind: "CustomVariable",
          spec: {
            name: "analysis_window",
            current: { text: value, value },
            query,
            options,
            allowCustomValue: false,
          },
        },
      ],
      elements: {
        "panel-1": {
          kind: "Panel",
          spec: {
            id: 1,
            title: "CLS",
            data: {
              kind: "QueryGroup",
              spec: {
                queries: [
                  {
                    kind: "PanelQuery",
                    spec: {
                      refId: "A",
                      query: {
                        kind: "DataQuery",
                        group: "tencent-cls-grafana-datasource",
                        datasource: { name: "cls" },
                        spec: {
                          maxDataPoints: 12,
                          logServiceParams: {
                            Query: "$__range $__range_ms $__cls_interval $__cls_interval_ms $__from",
                          },
                        },
                      },
                    },
                  },
                ],
                transformations: [],
                queryOptions: { timeFrom: "$analysis_window" },
              },
            },
          },
        },
      },
    },
  };
}

describe("Dashboard Panel 时间范围验证", () => {
  it("按 v2 timeFrom 变量与合法覆盖重算请求窗口和 CLS 宏", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        return jsonResponse({
          results: { A: { frames: [{ schema: { fields: [] }, data: { values: [] } }] } },
        });
      }),
    );
    const dashboard = panelTimeFromDashboard("6h");

    const result = await validateDashboards(validationContext(), [dashboard], validationOptions());
    const overridden = await validateDashboards(
      validationContext(),
      [dashboard],
      validationOptions({ analysis_window: "3h", __range: "bad", __from: "bad" }),
    );

    expect(result.errors).toEqual([]);
    expect(overridden.errors).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      from: String(Date.parse("2026-08-14T06:00:00.000Z")),
      to: String(Date.parse("2026-08-14T12:00:00.000Z")),
      queries: [
        {
          maxDataPoints: 12,
          logServiceParams: {
            Query: `21600s 21600000 1800 second 1800000 ${Date.parse("2026-08-14T06:00:00.000Z")}`,
          },
        },
      ],
    });
    expect(requests[1]).toMatchObject({
      from: String(Date.parse("2026-08-14T09:00:00.000Z")),
      to: String(Date.parse("2026-08-14T12:00:00.000Z")),
      queries: [
        {
          maxDataPoints: 12,
          logServiceParams: {
            Query: `10800s 10800000 900 second 900000 ${Date.parse("2026-08-14T09:00:00.000Z")}`,
          },
        },
      ],
    });
  });

  it("拒绝多值或候选外 timeFrom 且不发送 datasource 请求", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const fetch = vi.fn(async () => jsonResponse({ results: {} }));
    vi.stubGlobal("fetch", fetch);

    const multi = await validateDashboards(
      validationContext(),
      [panelTimeFromDashboard(["1h", "6h"])],
      validationOptions(),
    );
    const invalid = await validateDashboards(
      validationContext(),
      [panelTimeFromDashboard("12h")],
      validationOptions(),
    );

    expect(multi.errors[0]?.message).toContain("must resolve to one value");
    expect(invalid.errors[0]?.message).toContain("outside declared options");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("以 CustomVariable query 为候选 authority 并支持 key/value 语法", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        return jsonResponse({
          results: { A: { frames: [{ schema: { fields: [] }, data: { values: [] } }] } },
        });
      }),
    );
    const stale = panelTimeFromDashboard("12h", "30m,1h", [{ selected: true, text: "stale", value: "12h" }]);
    const keyValue = panelTimeFromDashboard("1h", "30 分钟 : 30m,1 小时 : 1h");

    const staleResult = await validateDashboards(validationContext(), [stale], validationOptions());
    const keyValueResult = await validateDashboards(validationContext(), [keyValue], validationOptions());

    expect(staleResult.errors[0]?.message).toContain("outside declared options");
    expect(keyValueResult.errors).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("拒绝未解析变量或不支持的静态 timeFrom", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const fetch = vi.fn(async () => jsonResponse({ results: {} }));
    vi.stubGlobal("fetch", fetch);
    const unresolved = panelTimeFromDashboard("1h");
    unresolved.spec.variables = [];
    const unsupported = panelTimeFromDashboard("1h");
    unsupported.spec.elements["panel-1"].spec.data.spec.queryOptions.timeFrom = "nonsense";

    const unresolvedResult = await validateDashboards(validationContext(), [unresolved], validationOptions());
    const unsupportedResult = await validateDashboards(
      validationContext(),
      [unsupported],
      validationOptions(),
    );

    expect(unresolvedResult.errors[0]?.message).toContain("unresolved template tokens");
    expect(unsupportedResult.errors[0]?.message).toContain("Unsupported Panel timeFrom expression");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Dashboard 使用绝对时间时忽略 Panel relative time override", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        return jsonResponse({
          results: { A: { frames: [{ schema: { fields: [] }, data: { values: [] } }] } },
        });
      }),
    );
    const from = Date.parse("2026-08-14T10:00:00.000Z");
    const to = Date.parse("2026-08-14T11:00:00.000Z");

    const result = await validateDashboards(validationContext(), [panelTimeFromDashboard("6h")], {
      ...validationOptions(),
      from: String(from),
      to: String(to),
    });

    expect(result.errors).toEqual([]);
    expect(requests[0]).toMatchObject({ from: String(from), to: String(to) });
  });

  it("Dashboard 任一端为相对时间时应用 Panel override", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        return jsonResponse({
          results: { A: { frames: [{ schema: { fields: [] }, data: { values: [] } }] } },
        });
      }),
    );

    const result = await validateDashboards(validationContext(), [panelTimeFromDashboard("1h")], {
      ...validationOptions(),
      from: String(Date.parse("2026-08-14T00:00:00.000Z")),
      to: "now",
    });

    expect(result.errors).toEqual([]);
    expect(requests[0]).toMatchObject({
      from: String(Date.parse("2026-08-14T11:00:00.000Z")),
      to: String(Date.parse("2026-08-14T12:00:00.000Z")),
    });
  });

  it("支持 Grafana 月/季度/年窗口并拒绝毫秒单位", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        return jsonResponse({
          results: { A: { frames: [{ schema: { fields: [] }, data: { values: [] } }] } },
        });
      }),
    );

    for (const value of ["1M", "1Q", "1y", "now/d"]) {
      const result = await validateDashboards(
        validationContext(),
        [panelTimeFromDashboard(value, value)],
        validationOptions(),
      );
      expect(result.errors).toEqual([]);
    }
    const milliseconds = await validateDashboards(
      validationContext(),
      [panelTimeFromDashboard("1ms", "1ms")],
      validationOptions(),
    );

    expect(requests.map((request) => request.from)).toEqual([
      String(Date.parse("2026-07-14T12:00:00.000Z")),
      String(Date.parse("2026-05-14T12:00:00.000Z")),
      String(Date.parse("2025-08-14T12:00:00.000Z")),
      String(Date.parse("2026-08-14T00:00:00.000Z")),
    ]);
    expect(milliseconds.errors[0]?.message).toContain("Unsupported Panel timeFrom expression");
  });

  it("按 classic timeFrom 重算请求窗口", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        return jsonResponse({
          results: { A: { frames: [{ schema: { fields: [] }, data: { values: [] } }] } },
        });
      }),
    );
    const dashboard = {
      dashboard: {
        uid: "classic-time-from",
        title: "classic-time-from",
        panels: [
          {
            id: 1,
            title: "CLS",
            timeFrom: "30m",
            datasource: { uid: "cls", type: "tencent-cls-grafana-datasource" },
            targets: [
              {
                refId: "A",
                datasource: { uid: "cls", type: "tencent-cls-grafana-datasource" },
                logServiceParams: { Query: "$__range $__cls_interval" },
              },
            ],
          },
        ],
      },
    };

    const result = await validateDashboards(validationContext(), [dashboard], validationOptions());

    expect(result.errors).toEqual([]);
    expect(requests[0]).toMatchObject({
      from: String(Date.parse("2026-08-14T11:30:00.000Z")),
      to: String(Date.parse("2026-08-14T12:00:00.000Z")),
      queries: [{ logServiceParams: { Query: "1800s 60 second" } }],
    });
  });
});
