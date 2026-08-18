import { formatGrafanaTimeVariable } from "../utils/resolve-time-to-ms";
import { scanGrafanaPromQLTemplates } from "./grafana-template-scanner";
import {
  type GrafanaPromQLCustomAllValue,
  GrafanaPromQLMacroError,
  type GrafanaPromQLMacroMode,
  type GrafanaPromQLPreflightOptions,
  type GrafanaPromQLPreflightResult,
  type GrafanaPromQLTemplateToken,
  type GrafanaPromQLVariableValue,
  parseGrafanaPromQLMacroMode,
} from "./grafana-types";

export function prepareGrafanaPromQLExpression(
  expression: string,
  options: GrafanaPromQLPreflightOptions = {},
): GrafanaPromQLPreflightResult {
  const macroMode = normalizeMacroMode(options.macroMode);
  const tokens = scanGrafanaPromQLTemplates(expression);
  if (macroMode === "strict" && tokens.length > 0) {
    throw new GrafanaPromQLMacroError(formatStrictMacroError(tokens), tokens);
  }

  if (macroMode === "keep" || macroMode === "strict") {
    const canonicalTokens = tokens.filter(shouldCanonicalizeForKeep);
    const normalizedExpression =
      canonicalTokens.length > 0
        ? replaceTokens(expression, canonicalTokens, canonicalKeepReplacement)
        : expression;
    return { expression, normalizedExpression, macroMode, tokens, warnings: [] };
  }

  const warnings: string[] = [];
  const normalizedExpression = replaceTokens(expression, tokens, (token) =>
    replacementForToken(expression, token, options, macroMode, warnings),
  );
  return { expression, normalizedExpression, macroMode, tokens, warnings: dedupe(warnings) };
}

function normalizeMacroMode(mode: GrafanaPromQLMacroMode | undefined): GrafanaPromQLMacroMode {
  return parseGrafanaPromQLMacroMode(mode);
}

function shouldCanonicalizeForKeep(token: GrafanaPromQLTemplateToken): boolean {
  return (
    token.kind === "legacy" ||
    (token.kind === "braced" && (!isSimpleTemplateFormat(token.format) || Boolean(token.fieldPath)))
  );
}

function canonicalKeepReplacement(token: GrafanaPromQLTemplateToken): string {
  if (token.kind === "legacy") return token.format ? `\${${token.name}:${token.format}}` : `$${token.name}`;
  if (token.kind === "braced" && (!isSimpleTemplateFormat(token.format) || token.fieldPath))
    return `$${token.name}`;
  return token.raw;
}

function isSimpleTemplateFormat(format: string | undefined): boolean {
  return format === undefined || /^[A-Za-z0-9_]+$/.test(format);
}

function replacementForToken(
  expression: string,
  token: GrafanaPromQLTemplateToken,
  options: GrafanaPromQLPreflightOptions,
  mode: "preset" | "eval",
  warnings: string[],
): string {
  if (mode === "eval") {
    const evaluated = evalReplacement(token, options);
    if (evaluated !== undefined) return formatReplacementForContext(evaluated, token, expression, options);
    warnings.push(`using preset for unresolved Grafana macro/template ${token.raw}`);
  }
  return presetReplacement(token, expression, options);
}

function evalReplacement(
  token: GrafanaPromQLTemplateToken,
  options: GrafanaPromQLPreflightOptions,
): GrafanaPromQLVariableValue | undefined {
  const vars = options.vars || {};
  const direct = vars[token.raw] ?? vars[token.fullName] ?? vars[token.name];
  if (direct !== undefined) {
    if ((token.fullName === "__from" || token.fullName === "__to") && token.format) {
      const value = isCustomAllValue(direct) ? direct.value : direct;
      if (Array.isArray(value)) throw new Error(`${token.fullName} must resolve to one time value`);
      return formatGrafanaTimeVariable(value, token.format, options.timeZone);
    }
    return isCustomAllValue(direct) ? direct : formatVariableValue(direct, token.format);
  }

  const intervalMs = options.intervalMs ?? 60_000;
  const rangeMs =
    options.rangeMs ?? (Math.max(0, (options.toMs ?? 3_600_000) - (options.fromMs ?? 0)) || 3_600_000);
  const fromMs = options.fromMs ?? Date.now() - rangeMs;
  const toMs = options.toMs ?? fromMs + rangeMs;
  const rateInterval = options.rateInterval ?? msToPromQLDuration(Math.max(intervalMs * 4, 240_000));
  switch (token.fullName) {
    case "__interval":
      return options.interval ?? msToPromQLDuration(intervalMs);
    case "__interval_ms":
      return String(intervalMs);
    case "__rate_interval":
      return rateInterval;
    case "__range":
      return msToPromQLDuration(rangeMs);
    case "__range_ms":
      return String(rangeMs);
    case "__range_s":
      return String(Math.round(rangeMs / 1000));
    case "__from":
      return token.format
        ? formatGrafanaTimeVariable(fromMs, token.format, options.timeZone)
        : String(fromMs);
    case "__to":
      return token.format ? formatGrafanaTimeVariable(toMs, token.format, options.timeZone) : String(toMs);
    default:
      return undefined;
  }
}

function formatReplacementForContext(
  value: GrafanaPromQLVariableValue,
  token: GrafanaPromQLTemplateToken,
  expression: string,
  options: GrafanaPromQLPreflightOptions,
): string {
  if (isCustomAllValue(value)) {
    return Array.isArray(value.value) ? value.value.join(",") : value.value;
  }
  const formatted = Array.isArray(value) ? formatVariableValue(value, token.format) : value;
  if (token.inString) return escapeStringContent(formatted, token.quote || '"');
  if (looksLikeRangeContext(expression, token) && !isPromQLDuration(formatted)) {
    return presetDurationForToken(token, options);
  }
  return formatted;
}

function isCustomAllValue(value: GrafanaPromQLVariableValue): value is GrafanaPromQLCustomAllValue {
  return typeof value === "object" && !Array.isArray(value) && value.isCustomAll === true;
}

function presetReplacement(
  token: GrafanaPromQLTemplateToken,
  expression: string,
  options: GrafanaPromQLPreflightOptions,
): string {
  if (token.inString) {
    const value = token.format?.toLowerCase() === "regex" ? ".*" : "placeholder";
    return escapeStringContent(value, token.quote || '"');
  }

  if (looksLikeRangeContext(expression, token)) return presetDurationForToken(token, options);

  return "1";
}

function presetDurationForToken(
  token: GrafanaPromQLTemplateToken,
  options: GrafanaPromQLPreflightOptions,
): string {
  if (token.fullName === "__rate_interval") {
    return options.rateInterval ?? msToPromQLDuration(Math.max((options.intervalMs ?? 60_000) * 4, 240_000));
  }
  if (token.fullName === "__range") return msToPromQLDuration(options.rangeMs ?? 3_600_000);
  return options.interval ?? msToPromQLDuration(options.intervalMs ?? 60_000);
}

function formatVariableValue(value: string | string[], formatter?: string): string {
  const values = Array.isArray(value) ? value.map(String) : [String(value)];
  const format = String(formatter || "").toLowerCase();
  if (format === "regex") return values.map(escapeRegex).join("|");
  if (format === "pipe") return values.join("|");
  if (format === "csv") return values.join(",");
  if (format === "singlequote") return values.map((item) => `'${item.replaceAll("'", "''")}'`).join(",");
  if (format === "doublequote") return values.map((item) => `"${item.replaceAll('"', '\\"')}"`).join(",");
  if (format === "text") return values.join(" + ");
  return values[0] || "";
}

function replaceTokens(
  expression: string,
  tokens: GrafanaPromQLTemplateToken[],
  replace: (token: GrafanaPromQLTemplateToken) => string,
): string {
  let output = expression;
  for (const token of [...tokens].reverse()) {
    output = `${output.slice(0, token.start)}${replace(token)}${output.slice(token.end)}`;
  }
  return output;
}

function looksLikeRangeContext(expression: string, token: GrafanaPromQLTemplateToken): boolean {
  const before = previousNonWhitespace(expression, token.start);
  const after = nextNonWhitespace(expression, token.end);
  if (before === "[" || before === ":") return true;
  if (after === "]" || after === ":") return true;
  return false;
}

function previousNonWhitespace(input: string, index: number): string | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const char = input[i];
    if (char && !/\s/.test(char)) return char;
  }
  return undefined;
}

function nextNonWhitespace(input: string, index: number): string | undefined {
  for (let i = index; i < input.length; i += 1) {
    const char = input[i];
    if (char && !/\s/.test(char)) return char;
  }
  return undefined;
}

function isPromQLDuration(input: string): boolean {
  return /^(?:[0-9]+(?:ms|s|m|h|d|w|y))+$/.test(input.trim());
}

function msToPromQLDuration(ms: number): string {
  const units: Array<[string, number]> = [
    ["w", 604_800_000],
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ];
  for (const [unit, size] of units) {
    if (ms >= size && ms % size === 0) return `${Math.round(ms / size)}${unit}`;
  }
  return `${Math.max(1, Math.round(ms))}ms`;
}

function escapeStringContent(input: string, quote: "'" | '"'): string {
  return input.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatStrictMacroError(tokens: GrafanaPromQLTemplateToken[]) {
  const preview = tokens
    .slice(0, 5)
    .map((token) => token.raw)
    .join(", ");
  return `Grafana macro/template is not allowed in strict PromQL mode: ${preview}${tokens.length > 5 ? `, ... ${tokens.length - 5} more` : ""}`;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
