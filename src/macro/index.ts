export type MacroContext = {
  from?: Date | number | string;
  to?: Date | number | string;
  interval?: string;
  intervalMs?: number;
  rangeMs?: number;
  table?: string;
  column?: string;
  vars?: Record<string, string | string[]>;
};

export type MacroNode = {
  type: "Macro";
  raw: string;
  name: string;
  args: string[];
  rawArgs: string[];
  start: number;
  end: number;
  braced: boolean;
  format?: string;
};

export type MacroHandler = (ctx: MacroContext, macro: MacroNode) => string | undefined;
export type MacroRegistry = Record<string, MacroHandler>;

export type CommentStyle = "hash" | "line" | "block" | "slash";

export type MacroParseOptions = {
  prefix?: string;
  comments?: CommentStyle[];
};

export type MacroInterpolateOptions = MacroParseOptions & {
  onUnknown?: "keep" | "remove" | ((macro: MacroNode) => string | undefined);
};

const DEFAULT_PREFIX = "$__";

export function parseMacros(input: string, options: MacroParseOptions = {}): MacroNode[] {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  if (!prefix) throw new Error("Macro prefix cannot be empty");
  const source = options.comments?.length ? stripComments(input, options.comments) : input;
  const macros: MacroNode[] = [];
  let index = 0;
  while (index < source.length) {
    const prefixStart = source.indexOf(prefix, index);
    const bracedStart = source.indexOf("${", index);
    if (prefixStart < 0 && bracedStart < 0) break;
    if (bracedStart >= 0 && (prefixStart < 0 || bracedStart < prefixStart)) {
      const braced = parseBracedMacroAt(input, source, bracedStart);
      if (braced) {
        macros.push(braced);
        index = braced.end;
      } else {
        index = bracedStart + 2;
      }
      continue;
    }

    const start = prefixStart;
    const nameStart = start + prefix.length;
    const nameEnd = scanName(source, nameStart);
    if (nameEnd === nameStart) {
      index = nameStart;
      continue;
    }
    const name = source.slice(nameStart, nameEnd);
    let end = nameEnd;
    let rawArgs: string[] = [];
    if (source[end] === "(") {
      const close = findClosingParen(source, end);
      if (close >= 0) {
        rawArgs = splitMacroArgs(source.slice(end + 1, close));
        end = close + 1;
      }
    }
    macros.push({
      type: "Macro",
      raw: input.slice(start, end),
      name,
      args: rawArgs.map((arg) => arg.trim()),
      rawArgs,
      start,
      end,
      braced: false,
    });
    index = end;
  }
  return macros;
}

export function interpolateMacros(
  input: string,
  registry: MacroRegistry,
  context: MacroContext = {},
  options: MacroInterpolateOptions = {},
): string {
  const macros = parseMacros(input, options);
  if (macros.length === 0) return options.comments?.length ? stripComments(input, options.comments) : input;
  let output = "";
  let cursor = 0;
  for (const macro of macros) {
    output += input.slice(cursor, macro.start);
    const handler = registry[macro.name];
    const replacement = handler?.(context, macro) ?? resolveUnknownMacro(macro, options.onUnknown);
    output += replacement ?? macro.raw;
    cursor = macro.end;
  }
  output += input.slice(cursor);
  return output;
}

function parseBracedMacroAt(input: string, source: string, start: number): MacroNode | undefined {
  if (!source.startsWith("${", start)) return undefined;
  const end = source.indexOf("}", start + 2);
  if (end < 0) return undefined;
  const body = source.slice(start + 2, end);
  const match = /^([A-Za-z_][A-Za-z0-9_.]*)(?::(.+))?$/.exec(body);
  if (!match?.[1]) return undefined;
  return {
    type: "Macro",
    raw: input.slice(start, end + 1),
    name: match[1],
    format: match[2],
    args: [],
    rawArgs: [],
    start,
    end: end + 1,
    braced: true,
  };
}

function resolveUnknownMacro(
  macro: MacroNode,
  onUnknown: MacroInterpolateOptions["onUnknown"],
): string | undefined {
  if (!onUnknown || onUnknown === "keep") return macro.raw;
  if (onUnknown === "remove") return "";
  return onUnknown(macro);
}

export function splitMacroArgs(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "'" || char === '"') {
      index = scanString(raw, index) - 1;
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

export function stripComments(input: string, styles: CommentStyle[]): string {
  if (styles.length === 0) return input;
  const enabled = new Set(styles);
  let output = "";
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (char === "'" || char === '"') {
      const end = scanString(input, index);
      output += input.slice(index, end);
      index = end;
      continue;
    }
    if (enabled.has("hash") && char === "#") {
      const end = scanLineEnd(input, index);
      output += " ".repeat(end - index);
      index = end;
      continue;
    }
    if (enabled.has("line") && char === "-" && input[index + 1] === "-") {
      const end = scanLineEnd(input, index);
      output += " ".repeat(end - index);
      index = end;
      continue;
    }
    if (enabled.has("slash") && char === "/" && input[index + 1] === "/") {
      const end = scanLineEnd(input, index);
      output += " ".repeat(end - index);
      index = end;
      continue;
    }
    if (enabled.has("block") && char === "/" && input[index + 1] === "*") {
      const end = scanBlockCommentEnd(input, index);
      output += " ".repeat(end - index);
      index = end;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

export function createDefaultGrafanaMacroRegistry(): MacroRegistry {
  return {
    __timeFrom: (ctx, macro) => formatInfinityTime(ctx.from, macro.format),
    __timeTo: (ctx, macro) => formatInfinityTime(ctx.to, macro.format),
    "__ds.name": (ctx) => stringVar(ctx, "__ds.name"),
    "__ds.uid": (ctx) => stringVar(ctx, "__ds.uid"),
    "__org.id": (ctx) => stringVar(ctx, "__org.id"),
    "__plugin.id": (ctx) => stringVar(ctx, "__plugin.id"),
    "__plugin.version": (ctx) => stringVar(ctx, "__plugin.version"),
    "__user.email": (ctx) => stringVar(ctx, "__user.email"),
    "__user.login": (ctx) => stringVar(ctx, "__user.login"),
    "__user.name": (ctx) => stringVar(ctx, "__user.name"),
    combineValues: (_ctx, macro) => combineValues(macro),
    customInterval: (ctx, macro) => customInterval(ctx.rangeMs, macro.args),
    interval: (ctx) => ctx.interval,
    interval_ms: (ctx) => (ctx.intervalMs === undefined ? undefined : String(ctx.intervalMs)),
    range_ms: (ctx) => (ctx.rangeMs === undefined ? undefined : String(ctx.rangeMs)),
    range_s: (ctx) => (ctx.rangeMs === undefined ? undefined : String(Math.round(ctx.rangeMs / 1000))),
    timeFrom: (ctx) => formatTime(ctx.from),
    timeTo: (ctx) => formatTime(ctx.to),
    timeFilter: (ctx, macro) => {
      const column = macro.args[0]?.trim();
      const from = formatTime(ctx.from);
      const to = formatTime(ctx.to);
      if (!column || !from || !to) return undefined;
      return `${column} >= '${from}' AND ${column} <= '${to}'`;
    },
    timeGroup: (_ctx, macro) => {
      const column = macro.args[0]?.trim();
      const interval = macro.args[1]?.trim();
      if (!column || !interval) return undefined;
      return `${column} $__timeGroup_interval_${interval}`;
    },
    table: (ctx) => ctx.table,
    column: (ctx) => ctx.column,
  };
}

function formatTime(value: MacroContext["from"]): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return value;
}

function formatInfinityTime(value: MacroContext["from"], format: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : undefined;
  if (!format) return String(date.getTime());
  const parts = format.split(":");
  if (parts[0]?.toLowerCase() !== "date") return String(date.getTime());
  const dateFormat = parts.slice(1).join(":");
  if (!dateFormat || dateFormat === "iso") return date.toISOString();
  if (dateFormat === "seconds") return String(Math.floor(date.getTime() / 1000));
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

function customInterval(rangeMs: number | undefined, args: string[]): string | undefined {
  if (args.length < 3 || args.length % 2 === 0) return undefined;
  if (rangeMs === undefined) return args.at(-1);
  for (let index = 0; index < args.length - 1; index += 2) {
    const durationMs = parseDurationMs(args[index] || "");
    if (durationMs !== undefined && rangeMs <= durationMs) return args[index + 1];
  }
  return args.at(-1);
}

function combineValues(macro: MacroNode): string | undefined {
  const args = macro.args;
  if (args.length < 4) return undefined;
  if (args.length === 4 && args[3] === "*") return "";
  const rawArgs = macro.rawArgs.length === args.length ? macro.rawArgs : args;
  const prefix = decodeInfinityEscape(args[0] || "");
  const suffix = decodeInfinityEscape(args[1] || "");
  const separator = decodeInfinityEscape(rawArgs[2] || "");
  return args
    .slice(3)
    .map((value) => `${prefix}${value.trim()}${suffix}`)
    .join(separator);
}

function decodeInfinityEscape(value: string): string {
  return value
    .replaceAll("__comma", ",")
    .replaceAll("__space", " ")
    .replaceAll("__open", "(")
    .replaceAll("__close", ")");
}

function stringVar(ctx: MacroContext, key: string): string | undefined {
  const value = ctx.vars?.[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseDurationMs(input: string): number | undefined {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)$/i);
  if (!match?.[1] || !match[2]) return undefined;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : unit === "d"
              ? 86_400_000
              : unit === "w"
                ? 604_800_000
                : 31_536_000_000;
  return value * multiplier;
}

function scanName(input: string, start: number): number {
  let index = start;
  while (index < input.length && /[A-Za-z0-9_]/.test(input[index] || "")) index += 1;
  return index;
}

function findClosingParen(input: string, open: number): number {
  let depth = 0;
  for (let index = open; index < input.length; index += 1) {
    const char = input[index];
    if (char === "'" || char === '"') {
      index = scanString(input, index) - 1;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function scanString(input: string, start: number): number {
  const quote = input[start];
  let index = start + 1;
  while (index < input.length) {
    if (input[index] === "\\") {
      index += 2;
      continue;
    }
    if (input[index] === quote) return index + 1;
    index += 1;
  }
  return input.length;
}

function scanLineEnd(input: string, start: number): number {
  let index = start;
  while (index < input.length && input[index] !== "\n" && input[index] !== "\r") index += 1;
  return index;
}

function scanBlockCommentEnd(input: string, start: number): number {
  const end = input.indexOf("*/", start + 2);
  return end < 0 ? input.length : end + 2;
}
