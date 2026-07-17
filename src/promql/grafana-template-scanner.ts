import type { GrafanaPromQLTemplateToken, GrafanaPromQLTemplateTokenKind } from "./grafana-types";

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
