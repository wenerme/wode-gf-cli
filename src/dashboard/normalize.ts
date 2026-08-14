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
  const queryOptions = getObjectField(queryGroup, "queryOptions");
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
        maxDataPoints: querySpec.maxDataPoints ?? queryOptions?.maxDataPoints,
      } as JsonObject;
      return { refId: asString(raw.refId) || String.fromCharCode(65 + index), raw };
    })
    .filter((target): target is DashboardTarget => Boolean(target));
}

export function extractPanelTimeFrom(panel: JsonObject): string | undefined {
  const classicTimeFrom = asString(panel.timeFrom);
  if (classicTimeFrom) return classicTimeFrom;
  const queryGroup = getObjectField(panel.data, "spec");
  const queryOptions = getObjectField(queryGroup, "queryOptions");
  return asString(queryOptions?.timeFrom);
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

export type DashboardPanelContext = {
  panel: JsonObject;
  variables: JsonObject[];
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

function collectV2PanelContexts(dashboard: JsonObject): DashboardPanelContext[] {
  const elements = getObjectField(dashboard, "elements") || {};
  const contexts: DashboardPanelContext[] = [];
  const referenced = new Set<string>();

  const visit = (value: unknown, inheritedVariables: JsonObject[]) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedVariables);
      return;
    }
    const node = asObject(value);
    if (!node) return;
    const spec = getObjectField(node, "spec") || node;
    const variables = [...inheritedVariables, ...asObjectArray(spec.variables)];
    if (asString(node.kind) === "ElementReference") {
      const name = asString(spec.name);
      const element = name ? asObject(elements[name]) : undefined;
      if (name && element && asString(element.kind) === "Panel") {
        referenced.add(name);
        contexts.push({ panel: { ...(getObjectField(element, "spec") || {}) }, variables });
      }
      return;
    }
    for (const [key, item] of Object.entries(spec)) {
      if (key !== "variables") visit(item, variables);
    }
  };

  visit(dashboard.layout, []);
  for (const [name, value] of Object.entries(elements)) {
    const element = asObject(value);
    if (!element || referenced.has(name) || asString(element.kind) !== "Panel") continue;
    contexts.push({ panel: { ...(getObjectField(element, "spec") || {}) }, variables: [] });
  }
  return contexts;
}

export function collectDashboardPanelContexts(dashboardEntry: JsonObject): DashboardPanelContext[] {
  const normalized = normalizeDashboardInput(dashboardEntry);
  if (!normalized) return [];
  if (normalized.format === "v2") {
    return collectV2PanelContexts(normalized.dashboard);
  }
  return collectPanels(normalized.dashboard.panels).map((panel) => ({ panel, variables: [] }));
}

export function collectDashboardPanels(dashboardEntry: JsonObject): JsonObject[] {
  return collectDashboardPanelContexts(dashboardEntry).map((context) => context.panel);
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
