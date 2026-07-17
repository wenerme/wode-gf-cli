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
