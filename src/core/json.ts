import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;

export function addType<T>(value: T, type: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copied = { ...(value as Record<string, unknown>), __type: type };
  return copied as T;
}

export function addTypeList<T>(items: T[] | undefined, type: string): T[] | undefined {
  if (!Array.isArray(items)) return items;
  return items.map((item) => addType(item, type));
}

export function stripMeta<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripMeta(v)) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__type") continue;
    out[key] = stripMeta(nested);
  }
  return out as T;
}

export function stableStringify(input: unknown): string {
  const seen = new WeakSet<object>();
  function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (!value || typeof value !== "object") return value;
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return JSON.stringify(normalize(input));
}

export function hashObject(input: unknown): string {
  return createHash("sha1").update(stableStringify(input)).digest("hex");
}

export function removeKeys<T extends Record<string, unknown>>(input: T, keys: string[]): T {
  const clone = JSON.parse(JSON.stringify(input)) as T;
  for (const key of keys) delete clone[key];
  return clone;
}
