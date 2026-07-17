import { asObject, asObjectArray, asString } from "../../lib/json-narrow";
import { type PanelJsonObject, type PanelMatch, panelNumberValue } from "../../lib/panel-tree";
import type { DashboardSelection } from "./selection";

function datasourceLabel(value: unknown): string | undefined {
  const datasource = asObject(value);
  if (datasource) {
    return asString(datasource.uid) || asString(datasource.name) || asString(datasource.type);
  }
  return asString(value);
}

export function panelDatasources(panel: PanelJsonObject): string[] {
  const values = new Set<string>();
  const own = datasourceLabel(panel.datasource);
  if (own) values.add(own);
  for (const target of asObjectArray(panel.targets)) {
    const targetDatasource = datasourceLabel(target.datasource);
    if (targetDatasource) values.add(targetDatasource);
  }
  return Array.from(values);
}

function shortText(value: unknown, maxLength = 80): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function panelTargetSummary(panel: PanelJsonObject) {
  return asObjectArray(panel.targets).map((target) => ({
    refId: asString(target.refId) || "",
    datasource: datasourceLabel(target.datasource) || "",
    query:
      shortText(target.expr) ||
      shortText(target.rawSql) ||
      shortText(target.query) ||
      shortText(target.expression) ||
      "",
  }));
}

export function panelInspectSummary(selection: DashboardSelection, match: PanelMatch) {
  const panel = match.panel;
  const fieldConfig = asObject(panel.fieldConfig);
  const options = asObject(panel.options);
  return {
    dashboard: { uid: selection.uid, title: selection.title },
    panel: {
      id: panelNumberValue(panel.id) ?? null,
      title: asString(panel.title) || "",
      type: asString(panel.type) || "",
      path: match.path,
      depth: match.depth,
      datasource: panelDatasources(panel),
      targets: panelTargetSummary(panel),
      transformations: asObjectArray(panel.transformations).map((item) => ({
        id: asString(item.id) || "",
      })),
      overrides: asObjectArray(fieldConfig?.overrides).length,
      optionsKeys: options ? Object.keys(options).sort() : [],
      gridPos: asObject(panel.gridPos) || null,
      links: asObjectArray(panel.links).length,
    },
  };
}

export function renderPanelInspectText(summary: ReturnType<typeof panelInspectSummary>): string {
  const lines = [
    `Dashboard: ${summary.dashboard.title} [${summary.dashboard.uid}]`,
    `Panel: ${summary.panel.title || "(untitled)"} [${summary.panel.id ?? "?"}]`,
    `Type: ${summary.panel.type || "<none>"}`,
    `Path: ${summary.panel.path}`,
    `Datasource: ${summary.panel.datasource.join(", ") || "<none>"}`,
    `Targets: ${summary.panel.targets.length}`,
  ];
  for (const target of summary.panel.targets) {
    lines.push(
      `  - ${target.refId || "?"}${target.datasource ? ` @ ${target.datasource}` : ""}${target.query ? `: ${target.query}` : ""}`,
    );
  }
  if (summary.panel.transformations.length > 0) {
    lines.push(
      `Transformations: ${summary.panel.transformations.map((item) => item.id || "<unknown>").join(", ")}`,
    );
  }
  if (summary.panel.overrides > 0) lines.push(`Overrides: ${summary.panel.overrides}`);
  if (summary.panel.optionsKeys.length > 0) lines.push(`Options: ${summary.panel.optionsKeys.join(", ")}`);
  if (summary.panel.links > 0) lines.push(`Links: ${summary.panel.links}`);
  return lines.join("\n");
}
