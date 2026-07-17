import { asObject } from "../lib/json-narrow";
import { SetExprSchema, WhereExprSchema } from "../schema";
import { type JsonObject, stableStringify } from "./json";

type MutableJson = Record<string, unknown> | unknown[];

export function parseJsonLike(value: string): unknown {
  const text = value.trim();
  if (!text.length) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function pathSegments(pathExpr: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const regex = /[^.[\]]+|\[(\d+)\]/g;
  while (true) {
    const matched = regex.exec(pathExpr);
    if (!matched) break;
    if (matched[1] !== undefined) segments.push(Number.parseInt(matched[1], 10));
    else segments.push(matched[0]);
  }
  return segments;
}

export function getPathValue(input: unknown, pathExpr?: string): unknown {
  if (!pathExpr?.trim()) return input;
  let current: unknown = input;
  for (const segment of pathSegments(pathExpr)) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function setPathValue(target: Record<string, unknown>, pathExpr: string, value: unknown): void {
  const parts = pathSegments(pathExpr);
  if (!parts.length) throw new Error("Invalid --path");

  let cursor: MutableJson = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const next = parts[index + 1];
    if (key === undefined || next === undefined) throw new Error("Invalid --path");
    if (typeof key === "number") {
      if (!Array.isArray(cursor)) throw new Error(`Path requires array at segment [${key}]`);
      if (cursor[key] === undefined) cursor[key] = typeof next === "number" ? [] : {};
      const nextCursor = cursor[key];
      if (!nextCursor || typeof nextCursor !== "object") {
        throw new Error(`Path requires object/array at segment [${key}]`);
      }
      cursor = nextCursor as MutableJson;
      continue;
    }
    if (Array.isArray(cursor)) throw new Error(`Path requires object at segment ${key}`);
    if (!cursor[key] || typeof cursor[key] !== "object") {
      cursor[key] = typeof next === "number" ? [] : {};
    }
    cursor = cursor[key] as MutableJson;
  }

  const leaf = parts[parts.length - 1];
  if (leaf === undefined) throw new Error("Invalid --path");
  if (typeof leaf === "number") {
    if (!Array.isArray(cursor)) throw new Error(`Path requires array at segment [${leaf}]`);
    cursor[leaf] = value;
  } else {
    if (Array.isArray(cursor)) throw new Error(`Path requires object at segment ${leaf}`);
    cursor[leaf] = value;
  }
}

export function deepMerge(base: unknown, extra: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(extra)) return extra;
  if (!base || typeof base !== "object") return extra;
  if (!extra || typeof extra !== "object") return extra;

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(extra as Record<string, unknown>)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

export function parseWhereExpr(expr: string): { path: string; value: unknown } {
  const index = expr.indexOf("=");
  if (index <= 0) throw new Error(`Invalid --where expression: ${expr}. Expect path=value`);
  const left = expr.slice(0, index).trim();
  const right = expr.slice(index + 1);
  if (!left) throw new Error(`Invalid --where expression: ${expr}. Missing path`);
  return WhereExprSchema.parse({ path: left, value: parseJsonLike(right) });
}

export function parseSetExpr(expr: string, defaultPath?: string): { path: string; value: unknown } {
  const index = expr.indexOf("=");
  if (index > 0) {
    return SetExprSchema.parse({
      path: expr.slice(0, index).trim(),
      value: parseJsonLike(expr.slice(index + 1)),
    });
  }
  if (!defaultPath) {
    throw new Error(
      `Invalid --set expression: ${expr}. Expect path=value or use --path with value-only --set`,
    );
  }
  return SetExprSchema.parse({ path: defaultPath, value: parseJsonLike(expr) });
}

export function valueEqual(first: unknown, second: unknown): boolean {
  return stableStringify(first) === stableStringify(second);
}

export function parseQueryAssignment(expr: string): { path: string; value: unknown } {
  const index = expr.indexOf("=");
  if (index <= 0) throw new Error(`Invalid --query expression: ${expr}. Expect path=value`);
  const pathExpr = expr.slice(0, index).trim();
  if (!pathExpr) throw new Error(`Invalid --query expression: ${expr}. Missing path`);
  return { path: pathExpr, value: parseJsonLike(expr.slice(index + 1)) };
}

export function parseJsonObjectOrThrow(input: string, sourceLabel: string): JsonObject {
  const value = parseJsonLike(input);
  const obj = asObject(value);
  if (!obj) throw new Error(`${sourceLabel} must be a JSON object`);
  return obj;
}
