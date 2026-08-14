import moment from "moment-timezone";
import type { JsonObject } from "../core/json";
import { asObjectArray, asString, getObjectField } from "../lib/json-narrow";
import {
  findUnresolvedTemplateTokens,
  materializeTemplateVars,
  resolveTemplateString,
  type TemplateVars,
} from "../lib/template-vars";
import { extractPanelTimeFrom } from "./normalize";

export function extractDashboardVariableDefinitions(dashboard: JsonObject): JsonObject[] {
  const templating = getObjectField(dashboard, "templating");
  return [...(templating ? asObjectArray(templating.list) : []), ...asObjectArray(dashboard.variables)];
}

export type DashboardTimeSettings = {
  timeZone: string;
  fiscalYearStartMonth: number;
  weekStart: "saturday" | "monday" | "sunday";
};

export function extractDashboardTimeSettings(dashboard: JsonObject): DashboardTimeSettings {
  const timeSettings = getObjectField(dashboard, "timeSettings");
  const configuredTimeZone = asString(timeSettings?.timezone) || asString(dashboard.timezone) || "browser";
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const timeZone =
    configuredTimeZone === "browser"
      ? browserTimeZone
      : configuredTimeZone.toUpperCase() === "UTC"
        ? "UTC"
        : configuredTimeZone;
  if (!moment.tz.zone(timeZone)) throw new Error(`Unsupported dashboard timezone: ${configuredTimeZone}`);

  const rawFiscalMonth = timeSettings?.fiscalYearStartMonth ?? dashboard.fiscalYearStartMonth ?? 0;
  const fiscalYearStartMonth = Number(rawFiscalMonth);
  if (!Number.isInteger(fiscalYearStartMonth) || fiscalYearStartMonth < 0 || fiscalYearStartMonth > 11) {
    throw new Error(`Invalid dashboard fiscalYearStartMonth: ${String(rawFiscalMonth)}`);
  }

  const rawWeekStart = asString(timeSettings?.weekStart) || asString(dashboard.weekStart) || "sunday";
  if (rawWeekStart !== "saturday" && rawWeekStart !== "monday" && rawWeekStart !== "sunday") {
    throw new Error(`Invalid dashboard weekStart: ${rawWeekStart}`);
  }
  return { timeZone, fiscalYearStartMonth, weekStart: rawWeekStart };
}

function isRelativeDashboardTime(value: string): boolean {
  return value.includes("now");
}

function referencedTemplateVariables(value: string): string[] {
  const names = new Set<string>();
  for (const match of value.matchAll(/\$\{([A-Za-z0-9_]+)(?::[^}]+)?\}|\$([A-Za-z][A-Za-z0-9_]*)/g)) {
    const name = match[1] || match[2];
    if (name) names.add(name);
  }
  return Array.from(names);
}

function parseCustomVariableQuery(query: string): string[] {
  const options = query.match(/(?:\\,|[^,])+/g) ?? [];
  return options.map((option) => {
    const text = option.replace(/\\,/g, ",");
    const keyValue = /^(.+)\s:\s(.+)$/.exec(text);
    return keyValue ? String(keyValue[2]).trim() : text.trim();
  });
}

function declaredCustomVariableValues(
  variables: JsonObject[],
  name: string,
  vars: TemplateVars,
): string[] | undefined {
  const variable = [...variables].reverse().find((candidate) => {
    const source = getObjectField(candidate, "spec") || candidate;
    return asString(source.name) === name;
  });
  if (!variable) return undefined;
  const source = getObjectField(variable, "spec") || variable;
  const kind = asString(variable.kind) || asString(variable.type);
  if (kind !== "CustomVariable" && kind !== "custom") return undefined;
  if (source.allowCustomValue !== false) return undefined;

  if (typeof source.query === "string") {
    return Array.from(new Set(parseCustomVariableQuery(resolveTemplateString(source.query, vars))));
  }
  const values = [...asObjectArray(source.options), ...asObjectArray(source.staticOptions)]
    .flatMap((option) => {
      const value = option.value;
      if (typeof value === "string" || typeof value === "number") return [String(value)];
      if (Array.isArray(value)) return value.map(String);
      return [];
    })
    .filter((value) => value !== "$__all");
  return Array.from(new Set(values));
}

type GrafanaRelativeUnit = "s" | "m" | "h" | "d" | "w" | "M" | "Q" | "y" | "fQ" | "fy";

function roundRelativeTime(
  value: moment.Moment,
  unit: GrafanaRelativeUnit,
  settings: DashboardTimeSettings,
): void {
  if (unit === "fy") {
    value.subtract((value.month() - settings.fiscalYearStartMonth + 12) % 12, "M").startOf("M");
    return;
  }
  if (unit === "fQ") {
    value.subtract((value.month() - settings.fiscalYearStartMonth + 12) % 3, "M").startOf("M");
    return;
  }
  if (unit === "w") {
    const firstDay = settings.weekStart === "monday" ? 1 : settings.weekStart === "saturday" ? 6 : 0;
    value.subtract((value.day() - firstDay + 7) % 7, "d").startOf("d");
    return;
  }
  value.startOf(unit);
}

function resolveGrafanaRelativeRange(
  input: string,
  nowMs: number,
  settings: DashboardTimeSettings,
): { fromMs: number; toMs: number } {
  const value = input.trim();
  const expression = value.includes("now") ? value : value.startsWith("+") ? `now${value}` : `now-${value}`;
  const match = /^now(?:([+-])(\d+)(fQ|fy|[yMwdhmsQ]))?(?:\/(fQ|fy|[yMwdhmsQ]))?$/.exec(expression);
  if (!match) throw new Error(`Unsupported Panel timeFrom expression: ${value}`);

  const [, direction, rawAmount, rawUnit, rawRoundUnit] = match;
  const target = moment.tz(nowMs, settings.timeZone);
  if (direction && rawAmount && rawUnit) {
    const amount = Number.parseInt(rawAmount, 10) * (direction === "+" ? 1 : -1);
    const unit = rawUnit === "fQ" ? "Q" : rawUnit === "fy" ? "y" : rawUnit;
    target.add(amount, unit as moment.unitOfTime.DurationConstructor);
  }
  if (rawRoundUnit) roundRelativeTime(target, rawRoundUnit as GrafanaRelativeUnit, settings);

  const range = expression.startsWith("now+")
    ? { fromMs: nowMs, toMs: target.valueOf() }
    : { fromMs: target.valueOf(), toMs: nowMs };
  if (range.fromMs >= range.toMs) {
    throw new Error(`Panel timeFrom must produce a positive range: ${value}`);
  }
  return range;
}

export function resolvePanelTimeRange(
  panel: JsonObject,
  vars: TemplateVars,
  variableDefinitions: JsonObject[],
  options: {
    defaultFromMs: number;
    defaultToMs: number;
    dashboardFrom: string;
    dashboardTo: string;
    nowMs: number;
    timeSettings: DashboardTimeSettings;
  },
): { fromMs: number; toMs: number } {
  const timeFrom = extractPanelTimeFrom(panel);
  if (
    !timeFrom ||
    (!isRelativeDashboardTime(options.dashboardFrom) && !isRelativeDashboardTime(options.dashboardTo))
  ) {
    return { fromMs: options.defaultFromMs, toMs: options.defaultToMs };
  }

  const plainVars = materializeTemplateVars(vars);
  for (const name of referencedTemplateVariables(timeFrom)) {
    const variableValue = plainVars[name];
    if (Array.isArray(variableValue)) {
      throw new Error(`Panel timeFrom variable ${name} must resolve to one value`);
    }
    const allowedValues = declaredCustomVariableValues(variableDefinitions, name, vars);
    if (allowedValues && variableValue !== undefined && !allowedValues.includes(variableValue)) {
      throw new Error(`Panel timeFrom variable ${name} value ${variableValue} is outside declared options`);
    }
  }

  const resolved = resolveTemplateString(timeFrom, vars).trim();
  const unresolved = findUnresolvedTemplateTokens(resolved);
  if (unresolved.length > 0) {
    throw new Error(`Panel timeFrom has unresolved template tokens: ${unresolved.join(", ")}`);
  }
  if (!resolved) throw new Error("Panel timeFrom resolved to an empty value");
  return resolveGrafanaRelativeRange(resolved, options.nowMs, options.timeSettings);
}
