import { JSONPath } from "jsonpath-plus";

type JsonPathMatch = {
  value: unknown;
  parent: unknown;
  parentProperty: string | number;
};

export type JsonPathPatchResult = {
  matched: number;
  changed: number;
};

function queryMatches(root: unknown, path: string): JsonPathMatch[] {
  return JSONPath({ path, json: root, resultType: "all" }) as JsonPathMatch[];
}

function applyToParent(match: JsonPathMatch, nextValue: unknown) {
  if (Array.isArray(match.parent) && typeof match.parentProperty === "number") {
    match.parent[match.parentProperty] = nextValue;
    return;
  }
  if (match.parent && typeof match.parent === "object") {
    (match.parent as Record<string, unknown>)[String(match.parentProperty)] = nextValue;
    return;
  }
  throw new Error("JSONPath match has no mutable parent");
}

function valuesEqual(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function setLeafByParentPath(root: unknown, path: string, value: unknown): JsonPathPatchResult | undefined {
  const index = path.lastIndexOf(".");
  if (index < 0) return undefined;
  const parentPath = path.slice(0, index);
  const leaf = path.slice(index + 1).trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(leaf)) return undefined;

  const parents = queryMatches(root, parentPath)
    .map((match) => match.value)
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    );
  if (parents.length === 0) return undefined;

  let changed = 0;
  for (const parent of parents) {
    if (!valuesEqual(parent[leaf], value)) changed += 1;
    parent[leaf] = value;
  }
  return { matched: parents.length, changed };
}

export function jsonPathSet(root: unknown, path: string, value: unknown): JsonPathPatchResult {
  const matches = queryMatches(root, path);
  if (matches.length === 0) {
    const created = setLeafByParentPath(root, path, value);
    if (created) return created;
  }

  let changed = 0;
  for (const match of matches) {
    if (!valuesEqual(match.value, value)) changed += 1;
    applyToParent(match, value);
  }
  return { matched: matches.length, changed };
}

export function jsonPathRegex(
  root: unknown,
  path: string,
  pattern: string,
  replacement: string,
): JsonPathPatchResult {
  const matches = queryMatches(root, path);
  const regex = new RegExp(pattern, "g");
  let matched = 0;
  let changed = 0;

  for (const match of matches) {
    if (typeof match.value !== "string") continue;
    matched += 1;
    const next = match.value.replace(regex, replacement);
    if (next !== match.value) changed += 1;
    applyToParent(match, next);
  }

  return { matched, changed };
}
