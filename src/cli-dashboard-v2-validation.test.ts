import { describe, expect, it } from "vitest";
import { __test__ } from "./cli";
import { normalizeRefIds, targetHasValidationQuery } from "./commands/build-panel";

describe("cli internal unit tests", () => {
  it("normalizes classic wrapper and naked dashboards without v2 spec access", () => {
    const wrapper = {
      __type: "grafana-dashboard",
      dashboard: {
        uid: "classic-wrapper",
        title: "Classic Wrapper",
        panels: [
          {
            id: 1,
            title: "SQL",
            type: "table",
            targets: [{ refId: "A", datasource: { uid: "pg", type: "postgres" }, rawSql: "select 1" }],
          },
          { id: 2, title: "No Targets", type: "text" },
        ],
      },
    };
    const naked = {
      uid: "classic-naked",
      title: "Classic Naked",
      panels: [{ id: 3, title: "Empty", type: "timeseries" }],
    };

    expect(__test__.normalizeDashboardInput(wrapper)?.format).toBe("classic");
    expect(__test__.normalizeDashboardInput(naked)?.format).toBe("classic");
    expect(__test__.collectDashboardPanels(wrapper).map((panel) => panel.title)).toEqual([
      "SQL",
      "No Targets",
    ]);
    expect(__test__.extractPanelTargets(wrapper.dashboard.panels[0] as Record<string, unknown>)).toHaveLength(
      1,
    );
    expect(__test__.extractPanelTargets(wrapper.dashboard.panels[1] as Record<string, unknown>)).toEqual([]);
    expect(__test__.extractPanelTargets(naked.panels[0] as Record<string, unknown>)).toEqual([]);
  });

  it("extracts Grafana dashboard v2 panels and queries", () => {
    const dashboard = {
      apiVersion: "dashboard.grafana.app/v2beta1",
      kind: "Dashboard",
      metadata: { name: "sample-dashboard", uid: "runtime-uid", resourceVersion: "1" },
      spec: {
        title: "sample-dashboard",
        elements: {
          "panel-1": {
            kind: "Panel",
            spec: {
              id: 1,
              title: "RPM",
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
                          group: "prometheus",
                          version: "v0",
                          datasource: { name: "$" + "{env}" },
                          spec: { expr: "up", range: true },
                        },
                      },
                    },
                  ],
                  transformations: [],
                  queryOptions: {},
                },
              },
            },
          },
        },
      },
    };

    expect(__test__.isDashboardResourceV2(dashboard)).toBe(true);
    expect(__test__.dashboardResourceV2Name(dashboard)).toBe("sample-dashboard");
    expect(__test__.dashboardResourceV2Title(dashboard)).toBe("sample-dashboard");
    expect(
      __test__.dashboardResourceV2HasTabs({
        ...dashboard,
        spec: { ...dashboard.spec, layout: { kind: "TabsLayout", spec: { tabs: [] } } },
      }),
    ).toBe(true);
    const sanitized = __test__.sanitizeDashboardResourceV2(dashboard);
    expect(sanitized.metadata).toEqual({ name: "sample-dashboard" });
    expect(
      __test__.sanitizeDashboardResourceV2({
        apiVersion: "dashboard.grafana.app/v2beta1",
        kind: "Dashboard",
        metadata: {},
        spec: { uid: "from-spec", title: "From Spec" },
      }).metadata,
    ).toEqual({ name: "from-spec" });
    const panels = __test__.collectDashboardPanels(dashboard);
    expect(panels).toHaveLength(1);
    const targets = __test__.extractPanelTargets(panels[0] as Record<string, unknown>);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.raw).toMatchObject({
      expr: "up",
      datasource: { uid: "$" + "{env}", type: "prometheus" },
    });
  });

  it("按 Tab 和 Row 作用域绑定重复引用并补入未引用 Panel", () => {
    const panel = (id: number) => ({
      kind: "Panel",
      spec: {
        id,
        title: `Panel ${id}`,
        data: { kind: "QueryGroup", spec: { queries: [], transformations: [], queryOptions: {} } },
      },
    });
    const row = (name: string, value: string, panelName: string) => ({
      kind: "RowsLayoutRow",
      spec: {
        title: name,
        variables: [
          { kind: "TextVariable", spec: { name: "detail_user", current: { value }, query: value } },
        ],
        layout: {
          kind: "GridLayout",
          spec: {
            items: [
              {
                kind: "GridLayoutItem",
                spec: { element: { kind: "ElementReference", spec: { name: panelName } } },
              },
            ],
          },
        },
      },
    });
    const dashboard = {
      apiVersion: "dashboard.grafana.app/v2beta1",
      kind: "Dashboard",
      metadata: { name: "row-scope" },
      spec: {
        title: "row-scope",
        elements: { "panel-1": panel(1), "panel-2": panel(2), "panel-3": panel(3) },
        layout: {
          kind: "TabsLayout",
          spec: {
            tabs: [
              {
                kind: "TabsLayoutTab",
                spec: {
                  title: "Tab",
                  variables: [
                    { kind: "TextVariable", spec: { name: "tab_scope", current: { value: "tab-a" } } },
                  ],
                  layout: {
                    kind: "RowsLayout",
                    spec: {
                      rows: [
                        row("A", "user-a", "panel-1"),
                        row("B", "user-b", "panel-2"),
                        row("C", "user-c", "panel-1"),
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    };

    const contexts = __test__.collectDashboardPanelContexts(dashboard);
    expect(
      contexts.map(({ panel, variables }) => [panel.id, __test__.extractTemplatingValues({ variables })]),
    ).toEqual([
      [1, { tab_scope: "tab-a", detail_user: "user-a" }],
      [2, { tab_scope: "tab-a", detail_user: "user-b" }],
      [1, { tab_scope: "tab-a", detail_user: "user-c" }],
      [3, {}],
    ]);
  });

  it("保留 v2 queryOptions maxDataPoints 供 CLS 宏展开", () => {
    const dashboard = {
      apiVersion: "dashboard.grafana.app/v2beta1",
      kind: "Dashboard",
      metadata: { name: "cls-max-data-points" },
      spec: {
        title: "cls-max-data-points",
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
                            logServiceParams: {
                              Query: "$__cls_interval $__cls_interval_ms $__interval $__interval_ms",
                            },
                          },
                        },
                      },
                    },
                    {
                      kind: "PanelQuery",
                      spec: {
                        refId: "B",
                        query: {
                          kind: "DataQuery",
                          group: "tencent-cls-grafana-datasource",
                          datasource: { name: "cls" },
                          spec: {
                            maxDataPoints: 7,
                            logServiceParams: {
                              Query: "$__cls_interval $__cls_interval_ms $__interval $__interval_ms",
                            },
                          },
                        },
                      },
                    },
                  ],
                  transformations: [],
                  queryOptions: { maxDataPoints: 12 },
                },
              },
            },
          },
        },
      },
    };

    const [target, queryTarget] = __test__.extractPanelTargets(__test__.collectDashboardPanels(dashboard)[0]);
    expect(target?.raw.maxDataPoints).toBe(12);
    expect(queryTarget?.raw.maxDataPoints).toBe(7);
    if (!target || !queryTarget) throw new Error("CLS targets not found");
    expect(
      __test__.buildValidateQueryBody(target, {
        datasourceUid: "cls",
        vars: {},
        fromMs: 0,
        toMs: 3_600_000,
        intervalMs: 60_000,
      }),
    ).toMatchObject({
      maxDataPoints: 12,
      logServiceParams: { Query: "300 second 300000 300 second 300000" },
    });
    expect(
      __test__.buildValidateQueryBody(queryTarget, {
        datasourceUid: "cls",
        vars: {},
        fromMs: 0,
        toMs: 3_600_000,
        intervalMs: 60_000,
      }),
    ).toMatchObject({
      maxDataPoints: 7,
      logServiceParams: { Query: "515 second 515000 515 second 515000" },
    });
  });

  it("rejects stable v2 transformation shape in v2beta1 dashboards", () => {
    const querySpec: { queries: unknown[]; transformations: unknown } = {
      queries: [],
      transformations: [
        {
          kind: "Transformation",
          group: "joinByField",
          spec: { options: { byField: "model_key", mode: "outer" } },
        },
      ],
    };
    const dashboard = {
      apiVersion: "dashboard.grafana.app/v2beta1",
      kind: "Dashboard",
      metadata: { name: "sample-dashboard" },
      spec: {
        title: "sample-dashboard",
        elements: {
          "panel-1": {
            kind: "Panel",
            spec: {
              id: 1,
              data: {
                kind: "QueryGroup",
                spec: querySpec,
              },
            },
          },
        },
      },
    };

    expect(() => __test__.sanitizeDashboardResourceV2(dashboard)).toThrow(
      /panel "panel-1" transformation\[0\].*kind and spec\.id/,
    );
    querySpec.transformations = [
      {
        kind: "joinByField",
        spec: { id: "joinByField", options: { byField: "model_key", mode: "outer" } },
      },
    ];
    expect(() => __test__.sanitizeDashboardResourceV2(dashboard)).not.toThrow();
    querySpec.transformations = {};
    expect(() => __test__.sanitizeDashboardResourceV2(dashboard)).toThrow(/transformations must be an array/);
    querySpec.transformations = [null];
    expect(() => __test__.sanitizeDashboardResourceV2(dashboard)).toThrow(
      /transformation\[0\] must be an object/,
    );
    querySpec.transformations = [{ kind: "joinByField", spec: { id: "joinByField" } }];
    expect(() => __test__.sanitizeDashboardResourceV2(dashboard)).toThrow(
      /transformation\[0\] spec\.options must be an object/,
    );
  });

  it("diffs dashboard v2 resources without runtime metadata noise", () => {
    const local = {
      __type: "dashboard-v2",
      apiVersion: "dashboard.grafana.app/v2beta1",
      kind: "Dashboard",
      metadata: { name: "sample-dashboard" },
      spec: { title: "sample-dashboard", layout: { kind: "TabsLayout", spec: { tabs: [] } } },
    };
    const remote = {
      apiVersion: "dashboard.grafana.app/v2beta1",
      kind: "Dashboard",
      metadata: {
        name: "sample-dashboard",
        namespace: "default",
        uid: "runtime-uid",
        resourceVersion: "42",
        annotations: {
          "grafana.app/createdBy": "service-account:1",
          "grafana.app/updatedBy": "service-account:1",
          "grafana.app/updatedTimestamp": "2026-06-25T00:00:00Z",
        },
        labels: { "grafana.app/deprecatedInternalID": "123" },
      },
      spec: { title: "sample-dashboard", layout: { kind: "TabsLayout", spec: { tabs: [] } } },
    };

    expect(__test__.diffArray("dashboards", [local], [remote])).toEqual([]);
    expect(__test__.selectedResourceChanged("dashboards", local, remote)).toBe(false);
    expect(__test__.selectedResourceChanged("dashboards", local, remote, "metadata.resourceVersion")).toBe(
      true,
    );
    expect(__test__.selectedResourceChanged("dashboards", undefined, remote)).toBe(true);
    expect(__test__.selectedResourceChanged("dashboards", local, undefined)).toBe(true);
    expect(__test__.selectedResourceChanged("dashboards", undefined, undefined)).toBe(false);
    expect(__test__.selectedResourceChanged("dashboards", undefined, remote, "spec.missing")).toBe(true);
  });

  it("filters dashboard validation by panel and refId", () => {
    const onlyPanels = new Set([7056]);
    const skippedPanels = new Set<number>();
    const onlyRefs = new Set(["F", "G"]);
    expect(__test__.matchesValidationTarget(7056, "F", onlyPanels, skippedPanels, onlyRefs)).toBe(true);
    expect(__test__.matchesValidationTarget(7056, "A", onlyPanels, skippedPanels, onlyRefs)).toBe(false);
    expect(__test__.matchesValidationTarget(7055, "F", onlyPanels, skippedPanels, onlyRefs)).toBe(false);
    expect(__test__.matchesValidationTarget(7056, "F", onlyPanels, new Set([7056]), onlyRefs)).toBe(false);
  });

  it("normalizes repeated refIds and rejects targets without supported query bodies", () => {
    expect(normalizeRefIds([" F ", "G", "F", ""])).toEqual(["F", "G"]);
    expect(normalizeRefIds(undefined)).toEqual([]);
    expect(targetHasValidationQuery({ expr: "up" })).toBe(true);
    expect(targetHasValidationQuery({ rawSql: "select 1" })).toBe(true);
    expect(targetHasValidationQuery({ logServiceParams: { Query: "* | select 1" } })).toBe(true);
    expect(
      targetHasValidationQuery({ datasource: { type: "__expr__" }, type: "math", expression: "$A" }),
    ).toBe(false);
  });

  it("can diff only resources present locally", () => {
    const local = [{ uid: "a", title: "A" }];
    const remote = [
      { uid: "a", title: "A" },
      { uid: "b", title: "B" },
    ];

    expect(__test__.diffArray("dashboards", local, remote)).toEqual([{ key: "b", change: "removed" }]);
    expect(__test__.diffArray("dashboards", local, remote, { localOnly: true })).toEqual([]);
  });
});
