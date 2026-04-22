import { asObjectArray, asString, getObjectField } from "./json-narrow";

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
