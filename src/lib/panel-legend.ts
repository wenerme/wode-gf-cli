import { asObject, asObjectArray, asString } from "./json-narrow";

export type JsonObject = Record<string, unknown>;

export type LegendPresetOptions = {
  calcs: string[];
  rightTable?: boolean;
  meanDesc?: boolean;
};

export type LegendPresetResult = {
  panelId: number;
  panelTitle: string;
  status: "updated" | "unchanged" | "skip";
  message: string;
};

export function parsePanelIds(input: string | undefined): number[] {
  const text = String(input || "")
    .trim()
    .replace(/^,+|,+$/g, "");
  if (!text) return [];
  return text.split(",").map((part) => {
    const value = Number.parseInt(part.trim(), 10);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid panel id: ${part}`);
    return value;
  });
}

export function applyLegendPresetToDashboard(
  dashboard: JsonObject,
  panelIds: number[],
  options: LegendPresetOptions,
): { dashboard: JsonObject; results: LegendPresetResult[] } {
  const clone = JSON.parse(JSON.stringify(dashboard)) as JsonObject;
  const targetIds = new Set(panelIds);
  const results: LegendPresetResult[] = [];
  const panels = flattenPanels(clone.panels);

  for (const panel of panels) {
    const panelId = numberValue(panel.id);
    if (!panelId || (targetIds.size > 0 && !targetIds.has(panelId))) continue;
    const panelTitle = asString(panel.title) || "(untitled panel)";
    if (asString(panel.type) !== "timeseries") {
      results.push({ panelId, panelTitle, status: "skip", message: "not a timeseries panel" });
      continue;
    }

    const before = JSON.stringify(asObject(panel.options)?.legend || {});
    const panelOptions = asObject(panel.options) || {};
    panel.options = panelOptions;
    panelOptions.legend = {
      ...(asObject(panelOptions.legend) || {}),
      showLegend: true,
      displayMode: options.rightTable ? "table" : "list",
      placement: options.rightTable ? "right" : "bottom",
      calcs: options.calcs,
      sortBy: options.meanDesc ? "Mean" : undefined,
      sortDesc: options.meanDesc || undefined,
    };
    const after = JSON.stringify(panelOptions.legend);
    results.push({
      panelId,
      panelTitle,
      status: before === after ? "unchanged" : "updated",
      message: before === after ? "legend already matches preset" : "legend preset applied",
    });
  }

  return { dashboard: clone, results };
}

function flattenPanels(input: unknown): JsonObject[] {
  const panels: JsonObject[] = [];
  for (const panel of asObjectArray(input)) {
    panels.push(panel);
    panels.push(...flattenPanels(panel.panels));
  }
  return panels;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return undefined;
}
