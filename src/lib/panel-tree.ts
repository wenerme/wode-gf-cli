import { asObject } from "./json-narrow";

export type PanelJsonObject = Record<string, unknown>;

export type PanelMatch = {
  panel: PanelJsonObject;
  path: string;
  depth: number;
};

export function panelNumberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

export function clonePanelJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function flattenPanels(input: unknown, prefix = "panels", depth = 0): PanelMatch[] {
  if (!Array.isArray(input)) return [];
  const result: PanelMatch[] = [];
  input.forEach((value, index) => {
    const panel = asObject(value);
    if (!panel) return;
    const panelPath = `${prefix}[${index}]`;
    result.push({ panel, path: panelPath, depth });
    result.push(...flattenPanels(panel.panels, `${panelPath}.panels`, depth + 1));
  });
  return result;
}

export function findPanel(dashboard: PanelJsonObject, panelId: number): PanelMatch {
  const match = flattenPanels(dashboard.panels).find(
    (candidate) => panelNumberValue(candidate.panel.id) === panelId,
  );
  if (!match) throw new Error(`No panel ${panelId} found in dashboard`);
  return match;
}

function replaceInPanelArray(value: unknown, panelId: number, nextPanel: PanelJsonObject): boolean {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const panel = asObject(value[index]);
    if (!panel) continue;
    if (panelNumberValue(panel.id) === panelId) {
      value[index] = nextPanel;
      return true;
    }
    if (replaceInPanelArray(panel.panels, panelId, nextPanel)) return true;
  }
  return false;
}

export function replacePanelInDashboard<T extends PanelJsonObject>(
  dashboard: T,
  panelId: number,
  nextPanel: PanelJsonObject,
): T {
  const updatedDashboard = clonePanelJson(dashboard);
  if (!replaceInPanelArray(updatedDashboard.panels, panelId, nextPanel)) {
    throw new Error(`No panel ${panelId} found in dashboard`);
  }
  return updatedDashboard;
}
