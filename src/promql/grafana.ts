import type { PromQLExpression } from "./ast";
import { parsePromQL, validatePromQLSyntax } from "./index";

export const GrafanaPromQLMacroModes = ["keep", "preset", "eval", "strict"] as const;
export type GrafanaPromQLMacroMode = (typeof GrafanaPromQLMacroModes)[number];

export type GrafanaPromQLTemplateTokenKind = "short" | "braced" | "legacy" | "call";

export type GrafanaPromQLTemplateToken = {
  kind: GrafanaPromQLTemplateTokenKind;
  raw: string;
  name: string;
  fullName: string;
  args: string[];
  format?: string;
  fieldPath?: string;
  start: number;
  end: number;
  inString: boolean;
  quote?: "'" | '"';
};

export type GrafanaPromQLPreflightOptions = {
  macroMode?: GrafanaPromQLMacroMode;
  vars?: Record<string, string | string[]>;
  fromMs?: number;
  toMs?: number;
  interval?: string;
  intervalMs?: number;
  rateInterval?: string;
  rangeMs?: number;
};

export type GrafanaPromQLPreflightResult = {
  expression: string;
  normalizedExpression: string;
  macroMode: GrafanaPromQLMacroMode;
  tokens: GrafanaPromQLTemplateToken[];
  warnings: string[];
};

export function parseGrafanaPromQLMacroMode(input: string | undefined): GrafanaPromQLMacroMode {
  const mode = String(input || "keep")
    .trim()
    .toLowerCase();
  if (GrafanaPromQLMacroModes.includes(mode as GrafanaPromQLMacroMode)) return mode as GrafanaPromQLMacroMode;
  throw new Error(`Unsupported PromQL macro mode: ${input}. Expected keep|preset|eval|strict`);
}

export class GrafanaPromQLMacroError extends Error {
  readonly tokens: GrafanaPromQLTemplateToken[];

  constructor(message: string, tokens: GrafanaPromQLTemplateToken[]) {
    super(message);
    this.name = "GrafanaPromQLMacroError";
    this.tokens = tokens;
  }
}

export function parseGrafanaPromQL(
  expression: string,
  options: GrafanaPromQLPreflightOptions = {},
): PromQLExpression {
  const preflight = prepareGrafanaPromQLExpression(expression, options);
  return parsePromQL(preflight.normalizedExpression);
}

export function validateGrafanaPromQLSyntax(
  expression: string,
  options: GrafanaPromQLPreflightOptions = {},
): GrafanaPromQLPreflightResult {
  const preflight = prepareGrafanaPromQLExpression(expression, options);
  validatePromQLSyntax(preflight.normalizedExpression);
  return preflight;
}

export function normalizeGrafanaPromQLTemplates(
  expression: string,
  options: GrafanaPromQLPreflightOptions = {},
): GrafanaPromQLPreflightResult {
  return prepareGrafanaPromQLExpression(expression, options);
}

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

export function scanGrafanaPromQLTemplates(expression: string): GrafanaPromQLTemplateToken[] {
  const tokens: GrafanaPromQLTemplateToken[] = [];
  let index = 0;
  let quote: "'" | '"' | undefined;

  while (index < expression.length) {
    const char = expression[index];

    if (quote) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        index += 1;
        continue;
      }
    } else {
      if (char === "#") {
        index = scanLineEnd(expression, index);
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        index += 1;
        continue;
      }
      if (char === "[" && expression[index + 1] === "[") {
        const token = scanLegacyTemplate(expression, index, quote);
        if (token) {
          tokens.push(token);
          index = token.end;
          continue;
        }
      }
    }

    if (char === "[" && expression[index + 1] === "[") {
      const token = scanLegacyTemplate(expression, index, quote);
      if (token) {
        tokens.push(token);
        index = token.end;
        continue;
      }
    }

    if (char === "$") {
      const token =
        expression[index + 1] === "{"
          ? scanBracedTemplate(expression, index, quote)
          : scanDollarTemplate(expression, index, quote);
      if (token) {
        tokens.push(token);
        index = token.end;
        continue;
      }
    }

    index += 1;
  }

  return tokens;
}

function normalizeMacroMode(mode: GrafanaPromQLMacroMode | undefined): GrafanaPromQLMacroMode {
  return parseGrafanaPromQLMacroMode(mode);
}

function scanBracedTemplate(
  expression: string,
  start: number,
  quote: "'" | '"' | undefined,
): GrafanaPromQLTemplateToken | undefined {
  const end = expression.indexOf("}", start + 2);
  if (end < 0) return undefined;
  const body = expression.slice(start + 2, end);
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.([^:}]+))?(?::([^}]+))?$/.exec(body);
  if (!match?.[1]) return undefined;
  const fieldPath = match[2];
  const format = match[3];
  const name = match[1];
  const fullName = fieldPath ? `${name}.${fieldPath}` : name;
  return {
    kind: "braced",
    raw: expression.slice(start, end + 1),
    name,
    fullName,
    fieldPath,
    format,
    args: [],
    start,
    end: end + 1,
    inString: Boolean(quote),
    quote,
  };
}

function scanDollarTemplate(
  expression: string,
  start: number,
  quote: "'" | '"' | undefined,
): GrafanaPromQLTemplateToken | undefined {
  const nameMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(expression.slice(start));
  const name = nameMatch?.[1];
  if (!name) return undefined;
  let end = start + 1 + name.length;
  let args: string[] = [];
  let kind: GrafanaPromQLTemplateTokenKind = "short";
  if (name.startsWith("__") && expression[end] === "(") {
    const close = findClosingParen(expression, end);
    if (close >= 0) {
      args = splitMacroArgs(expression.slice(end + 1, close)).map((arg) => arg.trim());
      end = close + 1;
      kind = "call";
    }
  }
  return {
    kind,
    raw: expression.slice(start, end),
    name,
    fullName: name,
    args,
    start,
    end,
    inString: Boolean(quote),
    quote,
  };
}

function scanLegacyTemplate(
  expression: string,
  start: number,
  quote: "'" | '"' | undefined,
): GrafanaPromQLTemplateToken | undefined {
  const end = expression.indexOf("]]", start + 2);
  if (end < 0) return undefined;
  const body = expression.slice(start + 2, end);
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?::([^\]]+))?$/.exec(body);
  if (!match?.[1]) return undefined;
  return {
    kind: "legacy",
    raw: expression.slice(start, end + 2),
    name: match[1],
    fullName: match[1],
    format: match[2],
    args: [],
    start,
    end: end + 2,
    inString: Boolean(quote),
    quote,
  };
}

function shouldCanonicalizeForKeep(token: GrafanaPromQLTemplateToken): boolean {
  return (
    token.kind === "legacy" ||
    (token.kind === "braced" && (!isSimpleTemplateFormat(token.format) || token.fieldPath))
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
): string | string[] | undefined {
  const vars = options.vars || {};
  const direct = vars[token.raw] ?? vars[token.fullName] ?? vars[token.name];
  if (direct !== undefined) return formatVariableValue(direct, token.format);

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
      return formatTimeMacro(fromMs, token.format);
    case "__to":
      return formatTimeMacro(toMs, token.format);
    default:
      return undefined;
  }
}

function formatReplacementForContext(
  value: string | string[],
  token: GrafanaPromQLTemplateToken,
  expression: string,
  options: GrafanaPromQLPreflightOptions,
): string {
  const formatted = Array.isArray(value) ? formatVariableValue(value, token.format) : value;
  if (token.inString) return escapeStringContent(formatted, token.quote || '"');
  if (looksLikeRangeContext(expression, token) && !isPromQLDuration(formatted)) {
    return presetDurationForToken(token, options);
  }
  return formatted;
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

function formatTimeMacro(ms: number, format: string | undefined): string {
  if (!format) return String(ms);
  const parts = format.split(":");
  if (parts[0]?.toLowerCase() !== "date") return String(ms);
  const date = new Date(ms);
  const dateFormat = parts.slice(1).join(":");
  if (!dateFormat || dateFormat === "iso") return date.toISOString();
  if (dateFormat === "seconds") return String(Math.floor(ms / 1000));
  return formatDatePattern(date, dateFormat);
}

function formatDatePattern(date: Date, pattern: string): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return pattern
    .replaceAll("YYYY", String(date.getUTCFullYear()))
    .replaceAll("MM", pad(date.getUTCMonth() + 1))
    .replaceAll("DD", pad(date.getUTCDate()))
    .replaceAll("HH", pad(date.getUTCHours()))
    .replaceAll("hh", pad(date.getUTCHours()))
    .replaceAll("mm", pad(date.getUTCMinutes()))
    .replaceAll("ss", pad(date.getUTCSeconds()))
    .replaceAll("SSS", pad(date.getUTCMilliseconds(), 3));
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

function splitMacroArgs(raw: string): string[] {
  if (!raw.trim()) return [];
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
    else if (char === "," && depth === 0) {
      args.push(raw.slice(start, index));
      start = index + 1;
    }
  }
  args.push(raw.slice(start));
  return args;
}

function findClosingParen(input: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let index = open; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function scanLineEnd(input: string, start: number): number {
  let index = start;
  while (index < input.length && input[index] !== "\n" && input[index] !== "\r") index += 1;
  return index;
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
