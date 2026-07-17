import { asObject, asString, getObjectField } from "../../lib/json-narrow";
import { type PanelJsonObject, panelNumberValue } from "../../lib/panel-tree";

export type PanelRef = {
  dashboard: string;
  panelId: number;
};

export function normalizeRefIds(input: unknown): string[] {
  const values = Array.isArray(input) ? input : [input];
  return Array.from(
    new Set(
      values.map((value) => asString(value)?.trim()).filter((value): value is string => Boolean(value)),
    ),
  );
}

export function targetHasValidationQuery(target: unknown): boolean {
  const obj = asObject(target);
  if (!obj) return false;
  const logServiceParams = getObjectField(obj, "logServiceParams");
  return Boolean(
    asString(obj.rawSql) || asString(obj.rawQuery) || asString(obj.expr) || asString(logServiceParams?.Query),
  );
}

export function parsePanelRef(ref: string): PanelRef {
  const text = String(ref || "").trim();
  const index = text.lastIndexOf("/");
  if (index <= 0 || index === text.length - 1) {
    throw new Error("Panel ref must be DASH/PANEL, for example example-dashboard/12");
  }
  const dashboard = text.slice(0, index).trim();
  const panelToken = text.slice(index + 1).trim();
  if (!dashboard) throw new Error("Panel ref is missing dashboard uid");
  if (!/^\d+$/.test(panelToken)) throw new Error("Panel ref PANEL must be a numeric panel id");
  return { dashboard, panelId: Number.parseInt(panelToken, 10) };
}

export function assertPanelObject(value: unknown): PanelJsonObject {
  const panel = asObject(value);
  if (!panel) throw new Error("Panel JSON must be an object");
  return panel;
}

export function assertPanelId(panel: PanelJsonObject, panelId: number): void {
  const id = panelNumberValue(panel.id);
  if (id !== panelId) throw new Error(`Edited panel id must remain ${panelId}`);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
