import { asObjectArray, asString, getObjectField } from "./json-narrow";
import { calcClsInterval } from "./cls-interval";
import { msToInterval } from "../utils/ms-to-interval";
import { resolveTimeToMs } from "../utils/resolve-time-to-ms";

type JsonObject = Record<string, unknown>;
export type TemplateVars = Record<string, string | string[]>;

export function extractTemplatingValues(dashboard: JsonObject): TemplateVars {
  const values: TemplateVars = {};
  const templating = getObjectField(dashboard, "templating");
  const list = templating ? asObjectArray(templating.list) : [];
  for (const variable of list) {
    const name = asString(variable.name);
    if (!name) continue;
    const current = getObjectField(variable, "current");
    const allValue = asString(variable.allValue);
    const currentValue = current ? current.value : undefined;
    if (typeof currentValue === "string" && currentValue) {
      if (currentValue === "$__all") {
        if (allValue) {
          values[name] = allValue;
          continue;
        }
        const options = asObjectArray(variable.options);
        let optionValues = options
          .map((option) => option.value)
          .flatMap((value) => {
            if (typeof value === "string") return [value];
            if (typeof value === "number") return [String(value)];
            if (Array.isArray(value)) return value.map((v) => String(v));
            return [];
          })
          .filter((v) => v && v !== "$__all");

        if (optionValues.length === 0 && asString(variable.type) === "custom") {
          const queryStr = asString(variable.query);
          if (queryStr) {
            optionValues = queryStr
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean);
          }
        }

        if (optionValues.length > 0) {
          values[name] = optionValues;
          continue;
        }

        values[name] = "NULL";
        continue;
      }
      values[name] = currentValue;
      continue;
    }
    if (typeof currentValue === "number") {
      values[name] = String(currentValue);
      continue;
    }
    if (Array.isArray(currentValue) && currentValue.length > 0) {
      values[name] = currentValue
        .map((item) => String(item))
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    if (allValue) values[name] = allValue;
  }
  return values;
}

function formatTemplateValue(value: string | string[], formatter?: string): string {
  const list = Array.isArray(value) ? value : [value];
  const normalized = list.map((item) => String(item));
  const format = String(formatter || "")
    .trim()
    .toLowerCase();
  if (!format) return normalized[0] || "";
  if (format === "pipe") return normalized.join("|");
  if (format === "csv") return normalized.join(",");
  if (format === "singlequote") {
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

export function resolveTemplateString(input: string, vars: TemplateVars): string {
  let output = input;

  output = output.replace(/\$__timeFilter\(([^)]+)\)/g, (_matched, rawColumn: string) => {
    const column = rawColumn.trim().replace(/^"|"$/g, "");
    if (!column) return _matched;
    const fromExpr = vars.__timeFrom;
    const toExpr = vars.__timeTo;
    if (!fromExpr || !toExpr) return _matched;
    return `"${column}" BETWEEN ${fromExpr} AND ${toExpr}`;
  });

  for (const macro of ["__timeFrom", "__timeTo", "__timeFilter"]) {
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

export function resolveTemplateValue(value: unknown, vars: TemplateVars): unknown {
  if (typeof value === "string") return resolveTemplateString(value, vars);
  if (Array.isArray(value)) return value.map((v) => resolveTemplateValue(v, vars));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = resolveTemplateValue(v, vars);
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
  from?: string | number;   // time expression, epoch ms number, or epoch ms string
  to?: string | number;
  nowMs?: number;
  intervalMs?: number;      // panel interval in ms, default 60000
  maxDataPoints?: number;   // used to calculate $__cls_interval step, default 150
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
  const toMs   = typeof opts.to   === "number" ? opts.to   : resolveTimeToMs(opts.to   || "now",    nowMs);
  const rangeMs = Math.max(0, toMs - fromMs);
  const rangeS = Math.floor(rangeMs / 1000);
  const intervalMs = opts.intervalMs ?? 60_000;
  const maxDataPoints = opts.maxDataPoints ?? 150;

  return {
    __from: String(fromMs),
    __to: String(toMs),
    __timeFrom: `to_timestamp(${fromMs / 1000})`,
    __timeTo: `to_timestamp(${toMs / 1000})`,
    __timeFilter: `"time" BETWEEN to_timestamp(${fromMs / 1000}) AND to_timestamp(${toMs / 1000})`,
    __interval_ms: String(intervalMs),
    __interval: msToInterval(intervalMs),
    __cls_interval: calcClsInterval(fromMs, toMs, maxDataPoints),
    __rate_interval: msToInterval(Math.max(intervalMs * 4, 240_000)),
    __range: `${rangeS}s`,
    __range_ms: String(rangeMs),
    __range_s: String(rangeS),
    __all: "ALL",
    __user_login: "",
    __org_name: "",
  };
}
