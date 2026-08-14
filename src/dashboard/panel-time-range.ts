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

function shiftMonths(nowMs: number, months: number): number {
  const value = new Date(nowMs);
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  const finalDay = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
  value.setUTCDate(Math.min(day, finalDay));
  return value.getTime();
}

function shiftRelativeTime(nowMs: number, amount: number, unit: GrafanaRelativeUnit): number {
  if (unit === "M") return shiftMonths(nowMs, amount);
  if (unit === "Q" || unit === "fQ") return shiftMonths(nowMs, amount * 3);
  if (unit === "y" || unit === "fy") return shiftMonths(nowMs, amount * 12);
  const factor =
    unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : unit === "d"
            ? 86_400_000
            : 604_800_000;
  return nowMs + amount * factor;
}

function roundRelativeTime(valueMs: number, rawUnit: GrafanaRelativeUnit): number {
  const unit = rawUnit === "fQ" ? "Q" : rawUnit === "fy" ? "y" : rawUnit;
  const value = new Date(valueMs);
  if (unit === "y") {
    value.setUTCMonth(0, 1);
    value.setUTCHours(0, 0, 0, 0);
  } else if (unit === "Q") {
    value.setUTCMonth(Math.floor(value.getUTCMonth() / 3) * 3, 1);
    value.setUTCHours(0, 0, 0, 0);
  } else if (unit === "M") {
    value.setUTCDate(1);
    value.setUTCHours(0, 0, 0, 0);
  } else if (unit === "w") {
    value.setUTCDate(value.getUTCDate() - value.getUTCDay());
    value.setUTCHours(0, 0, 0, 0);
  } else if (unit === "d") {
    value.setUTCHours(0, 0, 0, 0);
  } else if (unit === "h") {
    value.setUTCMinutes(0, 0, 0);
  } else if (unit === "m") {
    value.setUTCSeconds(0, 0);
  } else {
    value.setUTCMilliseconds(0);
  }
  return value.getTime();
}

function resolveGrafanaRelativeRange(input: string, nowMs: number): { fromMs: number; toMs: number } {
  const value = input.trim();
  const expression = value.includes("now") ? value : value.startsWith("+") ? `now${value}` : `now-${value}`;
  const match = /^now(?:([+-])(\d+)(fQ|fy|[yMwdhmsQ]))?(?:\/(fQ|fy|[yMwdhmsQ]))?$/.exec(expression);
  if (!match) throw new Error(`Unsupported Panel timeFrom expression: ${value}`);

  const [, direction, rawAmount, unit, roundUnit] = match;
  let targetMs = nowMs;
  if (direction && rawAmount && unit) {
    const amount = Number.parseInt(rawAmount, 10) * (direction === "+" ? 1 : -1);
    targetMs = shiftRelativeTime(targetMs, amount, unit as GrafanaRelativeUnit);
  }
  if (roundUnit) targetMs = roundRelativeTime(targetMs, roundUnit as GrafanaRelativeUnit);

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
  return resolveGrafanaRelativeRange(resolved, options.nowMs);
}
