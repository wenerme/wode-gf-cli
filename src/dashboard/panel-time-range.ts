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
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new Error(`Unsupported dashboard timezone: ${configuredTimeZone}`);
  }

  const rawFiscalMonth = timeSettings?.fiscalYearStartMonth ?? dashboard.fiscalYearStartMonth ?? 0;
  const fiscalYearStartMonth = Number(rawFiscalMonth);
  if (!Number.isInteger(fiscalYearStartMonth) || fiscalYearStartMonth < 0 || fiscalYearStartMonth > 11) {
    throw new Error(`Invalid dashboard fiscalYearStartMonth: ${String(rawFiscalMonth)}`);
  }
  return { timeZone, fiscalYearStartMonth };
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

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedDateParts(valueMs: number, timeZone: string): ZonedDateParts {
  let formatter = dateTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US-u-nu-latn", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dateTimeFormatters.set(timeZone, formatter);
  }
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(valueMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    millisecond: new Date(valueMs).getUTCMilliseconds(),
  };
}

function wallClockValue(parts: ZonedDateParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
}

function zonedDateToEpoch(parts: ZonedDateParts, timeZone: string): number {
  const desired = wallClockValue(parts);
  let candidate = desired;
  let bestAfter: { distance: number; value: number } | undefined;
  let bestBefore: { distance: number; value: number } | undefined;
  for (let i = 0; i < 8; i += 1) {
    const actual = wallClockValue(zonedDateParts(candidate, timeZone));
    const delta = desired - actual;
    if (delta === 0) return candidate;
    const target = actual > desired ? "after" : "before";
    const best = target === "after" ? bestAfter : bestBefore;
    if (!best || Math.abs(delta) < best.distance) {
      const next = { distance: Math.abs(delta), value: candidate };
      if (target === "after") bestAfter = next;
      else bestBefore = next;
    }
    candidate += delta;
  }
  return bestAfter?.value ?? bestBefore?.value ?? candidate;
}

function shiftCivilMonths(parts: ZonedDateParts, months: number): ZonedDateParts {
  const totalMonths = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(totalMonths / 12);
  const monthIndex = ((totalMonths % 12) + 12) % 12;
  const finalDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return { ...parts, year, month: monthIndex + 1, day: Math.min(parts.day, finalDay) };
}

function shiftCivilDays(parts: ZonedDateParts, days: number): ZonedDateParts {
  const value = new Date(wallClockValue(parts));
  value.setUTCDate(value.getUTCDate() + days);
  return {
    ...parts,
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function shiftRelativeTime(
  nowMs: number,
  amount: number,
  unit: GrafanaRelativeUnit,
  timeZone: string,
): number {
  if (unit === "s") return nowMs + amount * 1_000;
  if (unit === "m") return nowMs + amount * 60_000;
  if (unit === "h") return nowMs + amount * 3_600_000;
  const parts = zonedDateParts(nowMs, timeZone);
  if (unit === "d") return zonedDateToEpoch(shiftCivilDays(parts, amount), timeZone);
  if (unit === "w") return zonedDateToEpoch(shiftCivilDays(parts, amount * 7), timeZone);
  const months = unit === "M" ? amount : unit === "Q" || unit === "fQ" ? amount * 3 : amount * 12;
  return zonedDateToEpoch(shiftCivilMonths(parts, months), timeZone);
}

function floorMonth(parts: ZonedDateParts, totalMonths: number): ZonedDateParts {
  return {
    ...parts,
    year: Math.floor(totalMonths / 12),
    month: (((totalMonths % 12) + 12) % 12) + 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  };
}

function roundRelativeTime(
  valueMs: number,
  unit: GrafanaRelativeUnit,
  timeZone: string,
  fiscalYearStartMonth: number,
): number {
  let parts = zonedDateParts(valueMs, timeZone);
  const monthIndex = parts.month - 1;
  const totalMonths = parts.year * 12 + monthIndex;
  if (unit === "fy") {
    const offset = (monthIndex - fiscalYearStartMonth + 12) % 12;
    parts = floorMonth(parts, totalMonths - offset);
  } else if (unit === "fQ") {
    const offset = (monthIndex - fiscalYearStartMonth + 12) % 12;
    parts = floorMonth(parts, totalMonths - (offset % 3));
  } else if (unit === "y") {
    parts = floorMonth(parts, parts.year * 12);
  } else if (unit === "Q") {
    parts = floorMonth(parts, parts.year * 12 + Math.floor(monthIndex / 3) * 3);
  } else if (unit === "M") {
    parts = floorMonth(parts, totalMonths);
  } else if (unit === "w") {
    const weekDay = new Date(Date.UTC(parts.year, monthIndex, parts.day)).getUTCDay();
    parts = shiftCivilDays({ ...parts, hour: 0, minute: 0, second: 0, millisecond: 0 }, -weekDay);
  } else if (unit === "d") {
    parts = { ...parts, hour: 0, minute: 0, second: 0, millisecond: 0 };
  } else if (unit === "h") {
    parts = { ...parts, minute: 0, second: 0, millisecond: 0 };
  } else if (unit === "m") {
    parts = { ...parts, second: 0, millisecond: 0 };
  } else {
    parts = { ...parts, millisecond: 0 };
  }
  return zonedDateToEpoch(parts, timeZone);
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

  const [, direction, rawAmount, unit, roundUnit] = match;
  let targetMs = nowMs;
  if (direction && rawAmount && unit) {
    const amount = Number.parseInt(rawAmount, 10) * (direction === "+" ? 1 : -1);
    targetMs = shiftRelativeTime(targetMs, amount, unit as GrafanaRelativeUnit, settings.timeZone);
  }
  if (roundUnit) {
    targetMs = roundRelativeTime(
      targetMs,
      roundUnit as GrafanaRelativeUnit,
      settings.timeZone,
      settings.fiscalYearStartMonth,
    );
  }

  const range = expression.startsWith("now+")
    ? { fromMs: nowMs, toMs: targetMs }
    : { fromMs: targetMs, toMs: nowMs };
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
    const value = plainVars[name];
    if (Array.isArray(value)) {
      throw new Error(`Panel timeFrom variable ${name} must resolve to one value`);
    }
    const allowedValues = declaredCustomVariableValues(variableDefinitions, name, vars);
    if (allowedValues && value !== undefined && !allowedValues.includes(value)) {
      throw new Error(`Panel timeFrom variable ${name} value ${value} is outside declared options`);
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
