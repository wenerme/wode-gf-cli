import type { JsonObject } from "../core/json";
import { attachSourceFile, sourceFileOf } from "../core/source-file";
import { asObject, asObjectArray, asString, getObjectField } from "../lib/json-narrow";
import type { ExportBundle } from "../schema";
import { dashboardResourceV2Name, dashboardResourceV2Title, isDashboardResourceV2 } from "./model";
import type { DashboardTarget } from "./types";

function v2DatasourceType(group: string | undefined): string | undefined {
  if (!group) return undefined;
  if (group === "prometheus") return "prometheus";
  if (group === "grafana-postgresql-datasource") return "grafana-postgresql-datasource";
  if (group === "tencent-cls-grafana-datasource") return "tencent-cls-grafana-datasource";
  return group;
}

export function extractPanelTargets(panel: JsonObject): DashboardTarget[] {
  const targets = asObjectArray(panel.targets);
  if (targets.length > 0) {
    return targets.map((target, index) => ({
      refId: asString(target.refId) || String.fromCharCode(65 + index),
      raw: target,
    }));
  }

  const queryGroup = getObjectField(panel.data, "spec");
  return asObjectArray(queryGroup?.queries)
    .map((panelQuery, index) => {
      const panelQuerySpec = getObjectField(panelQuery, "spec");
      const query = getObjectField(panelQuerySpec, "query");
      const querySpec = getObjectField(query, "spec");
      if (!querySpec) return undefined;
      const datasource = getObjectField(query, "datasource");
      const datasourceUid = asString(datasource?.uid) || asString(datasource?.name);
      const datasourceType = asString(datasource?.type) || v2DatasourceType(asString(query?.group));
      const raw = {
        ...querySpec,
        refId:
          asString(panelQuerySpec?.refId) || asString(querySpec.refId) || String.fromCharCode(65 + index),
        datasource: { ...datasource, uid: datasourceUid, type: datasourceType },
      } as JsonObject;
      return { refId: asString(raw.refId) || String.fromCharCode(65 + index), raw };
    })
    .filter((target): target is DashboardTarget => Boolean(target));
}

function collectPanels(input: unknown): JsonObject[] {
  const panels: JsonObject[] = [];
  for (const panel of asObjectArray(input)) {
    panels.push(panel);
    panels.push(...collectPanels(panel.panels));
  }
  return panels;
}

export type NormalizedDashboardInput = {
  format: "classic" | "v2";
  dashboard: JsonObject;
  sourceFile?: string;
  title: string;
  uid?: string;
};

export function normalizeDashboardInput(dashboardEntry: JsonObject): NormalizedDashboardInput | undefined {
  const sourceFile = sourceFileOf(dashboardEntry);
  if (isDashboardResourceV2(dashboardEntry)) {
    const spec = getObjectField(dashboardEntry, "spec");
    if (!spec) return undefined;
    return {
      format: "v2",
      dashboard: spec,
      sourceFile,
      title: dashboardResourceV2Title(dashboardEntry) || "(untitled dashboard)",
      uid: dashboardResourceV2Name(dashboardEntry),
    };
  }

  const dashboard = getObjectField(dashboardEntry, "dashboard") || dashboardEntry;
  if (!dashboard || isDashboardResourceV2(dashboard)) return undefined;
  if (!dashboard.panels && !dashboard.rows && !dashboard.templating && !dashboard.title && !dashboard.uid)
    return undefined;
  return {
    format: "classic",
    dashboard,
    sourceFile,
    title: asString(dashboardEntry.title) || asString(dashboard.title) || "(untitled dashboard)",
    uid: asString(dashboardEntry.uid) || asString(dashboard.uid),
  };
}

export function collectDashboardPanels(dashboardEntry: JsonObject): JsonObject[] {
  const normalized = normalizeDashboardInput(dashboardEntry);
  if (!normalized) return [];
  if (normalized.format === "v2") {
    const elements = getObjectField(normalized.dashboard, "elements");
    return Object.values(elements || {})
      .map((element) => asObject(element))
      .filter((element): element is JsonObject => asString(element?.kind) === "Panel")
      .map((element) => ({ ...(getObjectField(element, "spec") || {}) }));
  }
  return collectPanels(normalized.dashboard.panels);
}

export function collectDashboards(bundle: ExportBundle): JsonObject[] {
  return asObjectArray(bundle.dashboards)
    .map((entry) => {
      const normalized = normalizeDashboardInput(entry);
      if (!normalized) return undefined;
      const out = {
        ...entry,
        title: normalized.title,
        uid: normalized.uid,
        dashboard: normalized.dashboard,
      } as JsonObject;
      if (normalized.sourceFile) attachSourceFile(out, normalized.sourceFile);
      return out;
    })
    .filter((value): value is JsonObject => Boolean(value));
}
