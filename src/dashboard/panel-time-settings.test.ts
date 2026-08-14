import { afterEach, describe, expect, it, vi } from "vitest";
import { validateDashboards } from "./validation";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function context() {
  return {
    url: "http://127.0.0.1:3000",
    timeoutMs: 1000,
    dryRun: false,
    debug: false,
    output: "text" as const,
    quiet: true,
  };
}

function options() {
  return {
    from: "now-24h",
    to: "now",
    timeoutMs: 1000,
    intervalMs: 60_000,
    concurrency: 1,
    failFast: false,
    skipPanelIds: [],
    vars: {},
  };
}

function dashboard(timeFrom: string, timeSettings: Record<string, unknown>) {
  return {
    apiVersion: "dashboard.grafana.app/v2beta1",
    kind: "Dashboard",
    metadata: { name: "time-settings" },
    spec: {
      title: "time-settings",
      timeSettings,
      elements: {
        panel: {
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
                        spec: { logServiceParams: { Query: "$__range" } },
                      },
                    },
                  },
                ],
                transformations: [],
                queryOptions: { timeFrom },
              },
            },
          },
        },
      },
    },
  };
}

function captureRequests() {
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      return response({ results: { A: { frames: [{ schema: { fields: [] }, data: { values: [] } }] } } });
    }),
  );
  return requests;
}

describe("Dashboard Panel timezone 与 fiscal time", () => {
  it("按 Dashboard 与 browser timezone 计算日历 rounding", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const requests = captureRequests();
    const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    for (const timeZone of ["Asia/Shanghai", "browser", browserTimeZone]) {
      const result = await validateDashboards(
        context(),
        [dashboard("now/d", { timezone: timeZone, fiscalYearStartMonth: 0, weekStart: "sunday" })],
        options(),
      );
      expect(result.errors).toEqual([]);
    }

    expect(requests[0]?.from).toBe(String(Date.parse("2026-08-13T16:00:00.000Z")));
    expect(requests[1]?.from).toBe(requests[2]?.from);
  });

  it("匹配 Moment 在纽约 fold 与柏林 gap 的源 offset 语义", async () => {
    vi.useFakeTimers();
    const requests = captureRequests();

    vi.setSystemTime(new Date("2026-11-02T06:30:00.000Z"));
    expect(
      (
        await validateDashboards(
          context(),
          [dashboard("1d", { timezone: "America/New_York", fiscalYearStartMonth: 0 })],
          options(),
        )
      ).errors,
    ).toEqual([]);

    vi.setSystemTime(new Date("2026-03-28T01:30:00.000Z"));
    expect(
      (
        await validateDashboards(
          context(),
          [dashboard("+1d", { timezone: "Europe/Berlin", fiscalYearStartMonth: 0 })],
          options(),
        )
      ).errors,
    ).toEqual([]);

    expect(requests[0]?.from).toBe(String(Date.parse("2026-11-01T06:30:00.000Z")));
    expect(requests[1]?.to).toBe(String(Date.parse("2026-03-29T00:30:00.000Z")));
  });

  it("按 fiscal month 与 weekStart rounding", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const requests = captureRequests();
    const cases = [
      ["now/fQ", { timezone: "utc", fiscalYearStartMonth: 3, weekStart: "sunday" }],
      ["now/fy", { timezone: "utc", fiscalYearStartMonth: 3, weekStart: "sunday" }],
      ["now/w", { timezone: "utc", fiscalYearStartMonth: 0, weekStart: "monday" }],
      ["now/w", { timezone: "utc", fiscalYearStartMonth: 0, weekStart: "saturday" }],
    ] as const;

    for (const [timeFrom, settings] of cases) {
      expect(
        (await validateDashboards(context(), [dashboard(timeFrom, settings)], options())).errors,
      ).toEqual([]);
    }

    expect(requests.map((request) => request.from)).toEqual([
      String(Date.parse("2026-07-01T00:00:00.000Z")),
      String(Date.parse("2026-04-01T00:00:00.000Z")),
      String(Date.parse("2026-08-10T00:00:00.000Z")),
      String(Date.parse("2026-08-08T00:00:00.000Z")),
    ]);
  });

  it("把非法 timezone/fiscal/weekStart 作为 Dashboard 错误并继续", async () => {
    const fetch = vi.fn(async () => response({ results: {} }));
    vi.stubGlobal("fetch", fetch);
    const dashboards = [
      dashboard("1h", { timezone: "Mars/Olympus", fiscalYearStartMonth: 0 }),
      dashboard("1h", { timezone: "utc", fiscalYearStartMonth: 12 }),
      dashboard("1h", { timezone: "utc", fiscalYearStartMonth: 0, weekStart: "friday" }),
    ];

    const result = await validateDashboards(context(), dashboards, options());

    expect(result.errors.map((error) => error.message)).toEqual([
      "Unsupported dashboard timezone: Mars/Olympus",
      "Invalid dashboard fiscalYearStartMonth: 12",
      "Invalid dashboard weekStart: friday",
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
