import { msToInterval } from "../utils/ms-to-interval";
import { formatGrafanaTimeVariable, resolveTimeToMs } from "../utils/resolve-time-to-ms";
import { calcClsIntervalSpec } from "./cls-interval";
import { asObjectArray, asString, getObjectField } from "./json-narrow";

type JsonObject = Record<string, unknown>;
export type TemplateVarValue = string | string[];
export type TemplateVarState = { value: TemplateVarValue; isCustomAll: true };
export type TemplateVars = Record<string, TemplateVarValue | TemplateVarState>;
export type PlainTemplateVars = Record<string, TemplateVarValue>;
export type TemplateResolveOptions = {
  timeZone?: string;
  datasourceType?: string;
};

function isTemplateVarState(value: TemplateVarValue | TemplateVarState): value is TemplateVarState {
  return typeof value === "object" && !Array.isArray(value) && value.isCustomAll === true;
}

export function materializeTemplateVars(vars: TemplateVars): PlainTemplateVars {
  return Object.fromEntries(
    Object.entries(vars).map(([name, value]) => [name, isTemplateVarState(value) ? value.value : value]),
  );
}

export function extractTemplatingValues(dashboard: JsonObject): TemplateVars {
  const values: TemplateVars = {};
  const templating = getObjectField(dashboard, "templating");
  const classicList = templating ? asObjectArray(templating.list) : [];
  const v2List = asObjectArray(dashboard.variables);
  const list = [...classicList, ...v2List];
  for (const variable of list) {
    const spec = getObjectField(variable, "spec");
    const source = spec || variable;
    const name = asString(source.name);
    if (!name) continue;
    const current = getObjectField(source, "current");
    const allValue = asString(source.allValue);
    const currentValue = current ? current.value : undefined;
    const isAll =
      currentValue === "$__all" ||
      (Array.isArray(currentValue) && currentValue.length > 0 && currentValue[0] === "$__all");
    if (isAll) {
      if (allValue) {
        values[name] = { value: allValue, isCustomAll: true };
        continue;
      }
      const options = asObjectArray(source.options);
      let optionValues = options
        .map((option) => option.value)
        .flatMap((value) => {
          if (typeof value === "string") return [value];
          if (typeof value === "number") return [String(value)];
          if (Array.isArray(value)) return value.map((v) => String(v));
          return [];
        })
        .filter((v) => v && v !== "$__all");

      if (
        optionValues.length === 0 &&
        (asString(variable.type) === "custom" || asString(variable.kind) === "CustomVariable")
      ) {
        const queryStr = asString(source.query);
        if (queryStr) {
          optionValues = queryStr
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
        }
      }

      values[name] = optionValues.length > 0 ? optionValues : "NULL";
      continue;
    }
    if (typeof currentValue === "string") {
      values[name] = currentValue;
      continue;
    }
    if (typeof currentValue === "number") {
      values[name] = String(currentValue);
      continue;
    }
    if (Array.isArray(currentValue) && currentValue.length > 0) {
      values[name] = currentValue.map((item) => String(item)).map((item) => item.trim());
      continue;
    }
    if (allValue) values[name] = allValue;
  }
  return values;
}

function formatTemplateValue(value: TemplateVarValue | TemplateVarState, formatter?: string): string {
  if (isTemplateVarState(value)) {
    return Array.isArray(value.value) ? value.value.join(",") : value.value;
  }
  const list = Array.isArray(value) ? value : [value];
  const normalized = list.map((item) => String(item));
  const format = String(formatter || "")
    .trim()
    .toLowerCase();
  if (!format) return normalized[0] || "";
  if (format === "pipe") return normalized.join("|");
  if (format === "csv") return normalized.join(",");
  if (format === "singlequote" || format === "sqlstring") {
    return normalized.map((item) => `'${item.replaceAll("'", "''")}'`).join(",");
  }
  if (format === "doublequote") {
    return normalized.map((item) => `"${item.replaceAll('"', '\\"')}"`).join(",");
  }
  return normalized[0] || "";
}

function splitTemplateToken(token: string): { name: string; formatter?: string } {
  const idx = token.indexOf(":");
  if (idx <= 0) return { name: token };
  return {
    name: token.slice(0, idx),
    formatter: token.slice(idx + 1),
  };
}

function scalarTemplateValue(value: TemplateVarValue | TemplateVarState | undefined): string | undefined {
  if (value === undefined) return undefined;
  const materialized = isTemplateVarState(value) ? value.value : value;
  return Array.isArray(materialized) ? materialized[0] : materialized;
}

function templateEpochSeconds(vars: TemplateVars, name: "__from" | "__to"): number | undefined {
  const value = Number(scalarTemplateValue(vars[name]));
  return Number.isFinite(value) ? Math.floor(value / 1000) : undefined;
}

function sqlDialect(datasourceType: string | undefined): "mysql" | "postgres" | "other" {
  const type = String(datasourceType || "").toLowerCase();
  if (type === "mysql") return "mysql";
  if (type === "postgres" || type.includes("postgresql")) return "postgres";
  return "other";
}

function intervalSeconds(raw: string, vars: TemplateVars): number {
  const resolved = raw
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^\$\{__interval\}$|^\$__interval$/, scalarTemplateValue(vars.__interval) || "");
  const match = /^([0-9]+)(ms|s|m|h|d|w)$/.exec(resolved);
  if (!match) throw new Error(`Unsupported Grafana SQL interval: ${raw}`);
  const amount = Number.parseInt(match[1] || "0", 10);
  const unit = match[2];
  const milliseconds =
    amount *
    (unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : unit === "d"
              ? 86_400_000
              : 604_800_000);
  if (milliseconds < 1000 || milliseconds % 1000 !== 0) {
    throw new Error(`Grafana SQL interval must resolve to whole seconds: ${raw}`);
  }
  return milliseconds / 1000;
}

function interpolateSqlMacroFunctions(
  input: string,
  vars: TemplateVars,
  datasourceType: string | undefined,
): string {
  const dialect = sqlDialect(datasourceType);
  const from = templateEpochSeconds(vars, "__from");
  const to = templateEpochSeconds(vars, "__to");
  return input.replace(
    /\$__(timeFilter|timeGroupAlias)\(([^)]*)\)/g,
    (matched, macro: string, rawArgs: string) => {
      const args = rawArgs.split(",").map((arg) => arg.trim());
      const column = args[0];
      if (!column) throw new Error(`Grafana SQL macro $__${macro} requires a column argument`);
      if (macro === "timeFilter") {
        if (from === undefined || to === undefined) {
          const fromExpression = scalarTemplateValue(vars.__timeFrom);
          const toExpression = scalarTemplateValue(vars.__timeTo);
          if (!fromExpression || !toExpression) return matched;
          const unquoted = column.replace(/^"|"$/g, "");
          return `"${unquoted}" BETWEEN ${fromExpression} AND ${toExpression}`;
        }
        if (dialect === "mysql") {
          return `${column} BETWEEN FROM_UNIXTIME(${from}) AND FROM_UNIXTIME(${to})`;
        }
        if (dialect === "postgres") {
          return `${column} BETWEEN to_timestamp(${from}) AND to_timestamp(${to})`;
        }
        const unquoted = column.replace(/^"|"$/g, "");
        return `"${unquoted}" BETWEEN to_timestamp(${from}) AND to_timestamp(${to})`;
      }
      if (dialect === "other") return matched;
      if (!args[1]) throw new Error("Grafana SQL macro $__timeGroupAlias requires an interval argument");
      const seconds = intervalSeconds(args[1], vars);
      const grouped =
        dialect === "mysql"
          ? `UNIX_TIMESTAMP(${column}) DIV ${seconds} * ${seconds}`
          : `floor(extract(epoch from ${column})/${seconds})*${seconds}`;
      return `${grouped} AS "time"`;
    },
  );
}

export function resolveTemplateString(
  input: string,
  vars: TemplateVars,
  options: TemplateResolveOptions = {},
): string {
  let output = input;
  output = interpolateSqlMacroFunctions(output, vars, options.datasourceType);

  for (const macro of ["__timeFrom", "__timeTo", "__timeFilter", "__unixEpochFrom", "__unixEpochTo"]) {
    const value = vars[macro];
    if (!value) continue;
    output = output.replaceAll(`$${macro}()`, formatTemplateValue(value));
  }

  return output.replace(/\$\{([A-Za-z0-9_:-]+)\}|\$([A-Za-z0-9_]+)/g, (matched, a: string, b: string) => {
    const token = a || b;
    if (!token) return matched;
    const { name, formatter } = splitTemplateToken(token);
    const value = vars[token] ?? vars[name];
    if (value !== undefined) {
      if ((name === "__from" || name === "__to") && formatter) {
        const scalar = scalarTemplateValue(value);
        if (scalar === undefined) throw new Error(`Grafana time variable ${name} has no scalar value`);
        return formatGrafanaTimeVariable(scalar, formatter, options.timeZone);
      }
      const formatted = formatTemplateValue(value, formatter);
      if (formatted.startsWith("$")) return matched;
      return formatted;
    }
    if (name === "__from" || name === "__to") return matched;
    return matched;
  });
}

export function findUnresolvedTemplateTokens(value: unknown): string[] {
  const tokens = new Set<string>();
  const visit = (input: unknown) => {
    if (typeof input === "string") {
      for (const match of input.matchAll(
        /\$\{[A-Za-z0-9_:-]+\}|\$__[A-Za-z0-9_]+|\$[A-Za-z][A-Za-z0-9_]*/g,
      )) {
        tokens.add(match[0]);
      }
      return;
    }
    if (Array.isArray(input)) {
      for (const item of input) visit(item);
      return;
    }
    if (!input || typeof input !== "object") return;
    for (const item of Object.values(input as Record<string, unknown>)) visit(item);
  };
  visit(value);
  return Array.from(tokens).sort();
}

export function resolveTemplateValue(
  value: unknown,
  vars: TemplateVars,
  options: TemplateResolveOptions = {},
): unknown {
  if (typeof value === "string") return resolveTemplateString(value, vars, options);
  if (Array.isArray(value)) return value.map((v) => resolveTemplateValue(v, vars, options));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = resolveTemplateValue(v, vars, options);
  }
  return out;
}

function isMixedDatasourceUid(uid: string): boolean {
  const normalized = uid.trim().toLowerCase();
  return normalized === "-- mixed --" || normalized === "mixed";
}

export function resolveDatasourceUid(
  panelDatasourceUid: string | undefined,
  targetDatasourceUid: string | undefined,
  vars: TemplateVars,
): string | undefined {
  const panelResolved = panelDatasourceUid ? resolveTemplateString(panelDatasourceUid, vars) : undefined;
  if (panelResolved && !isMixedDatasourceUid(panelResolved)) return panelResolved;
  const targetResolved = targetDatasourceUid ? resolveTemplateString(targetDatasourceUid, vars) : undefined;
  if (targetResolved && !isMixedDatasourceUid(targetResolved)) return targetResolved;
  return undefined;
}

// ── Grafana built-in macros ─────────────────────────────────────────────────
// Macros are Grafana-internal placeholders expanded before query execution,
// distinct from dashboard Variables (user-configurable, appear in the UI).
// Examples: $__from, $__to, $__interval, $__cls_interval, $__timeFilter
// Variables: ${model}, ${provider}, ${cls_ds} etc.
// Both are resolved via the same string-replace mechanism in wode-gf-cli.

export type GrafanaMacroOptions = {
  from?: string | number; // time expression, epoch ms number, or epoch ms string
  to?: string | number;
  nowMs?: number;
  intervalMs?: number; // panel interval in ms, default 60000
  maxDataPoints?: number; // used to calculate $__cls_interval step, default 150
  datasourceType?: string;
};

/**
 * Build Grafana built-in macro values ($__from, $__to, $__interval,
 * $__cls_interval, $__rate_interval, $__range, $__timeFilter, etc.)
 * from time range options.
 *
 * These are Grafana macros (server-side expanded), not dashboard variables.
 * wode-gf-cli pre-expands them client-side so queries work in query/validate.
 *
 * User-provided variable overrides should be merged on top of the result.
 */
export function buildGrafanaMacros(opts: GrafanaMacroOptions = {}): TemplateVars {
  const nowMs = opts.nowMs ?? Date.now();
  const fromMs = typeof opts.from === "number" ? opts.from : resolveTimeToMs(opts.from || "now-1h", nowMs);
  const toMs = typeof opts.to === "number" ? opts.to : resolveTimeToMs(opts.to || "now", nowMs);
  const rangeMs = Math.max(0, toMs - fromMs);
  const rangeS = Math.floor(rangeMs / 1000);
  const intervalMs = opts.intervalMs ?? 60_000;
  const maxDataPoints = opts.maxDataPoints ?? 150;
  const clsInterval = calcClsIntervalSpec(fromMs, toMs, maxDataPoints);
  const dialect = sqlDialect(opts.datasourceType);
  const fromSeconds = Math.floor(fromMs / 1000);
  const toSeconds = Math.floor(toMs / 1000);
  const timeFrom = dialect === "mysql" ? `FROM_UNIXTIME(${fromSeconds})` : `to_timestamp(${fromSeconds})`;
  const timeTo = dialect === "mysql" ? `FROM_UNIXTIME(${toSeconds})` : `to_timestamp(${toSeconds})`;

  return {
    __from: String(fromMs),
    __to: String(toMs),
    __timeFrom: timeFrom,
    __timeTo: timeTo,
    __timeFilter: `"time" BETWEEN ${timeFrom} AND ${timeTo}`,
    __unixEpochFrom: String(fromSeconds),
    __unixEpochTo: String(toSeconds),
    __interval_ms: String(intervalMs),
    __interval: msToInterval(intervalMs),
    __cls_interval: clsInterval.sql,
    __cls_interval_ms: String(clsInterval.milliseconds),
    __rate_interval: msToInterval(Math.max(intervalMs * 4, 240_000)),
    __range: `${rangeS}s`,
    __range_ms: String(rangeMs),
    __range_s: String(rangeS),
    __all: "ALL",
    __user_login: "",
    __org_name: "",
  };
}
