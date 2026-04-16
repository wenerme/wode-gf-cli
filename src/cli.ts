import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { GrafanaClient, mapLimit } from "./client";
import {
  CliName,
  DefaultResources,
  type DiffItem,
  type ExportBundle,
  type GrafanaCliContext,
  GrafanaCliContextSchema,
  type ResourceName,
  type ResourceSelector,
  ResourceSelectorSchema,
  SetExprSchema,
  WhereExprSchema,
} from "./schema";

type JsonObject = Record<string, unknown>;
type MutableJson = Record<string, unknown> | unknown[];

function asObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function asObjectArray(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JsonObject => Boolean(asObject(item)));
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getObjectField(obj: JsonObject, key: string): JsonObject | undefined {
  return asObject(obj[key]);
}

function createEmptyBundle(): ExportBundle {
  return {
    generatedAt: new Date().toISOString(),
    url: "",
    resources: [...DefaultResources],
  };
}

function addType<T>(value: T, type: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copied = { ...(value as Record<string, unknown>), __type: type };
  return copied as T;
}

function addTypeList<T>(items: T[] | undefined, type: string): T[] | undefined {
  if (!Array.isArray(items)) return items;
  return items.map((item) => addType(item, type));
}

function stripMeta<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripMeta(v)) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "__type") continue;
    out[k] = stripMeta(v);
  }
  return out as T;
}

function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const matched = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!matched) continue;

    const key = matched[1];
    if (!key) continue;
    let value = matched[2] ?? "";

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Remove inline comments from unquoted values.
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx);
      value = value.trim();
    }

    vars[key] = value;
  }
  return vars;
}

function loadEnvFile(filePath: string): Record<string, string> {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return parseEnvFile(content);
  } catch {
    return {};
  }
}

function loadEnv() {
  // Keep shell-provided env vars as highest priority.
  const shellEnvKeys = new Set(Object.keys(process.env));
  const merged = {
    ...loadEnvFile(".env"),
    ...loadEnvFile(".env.local"),
  };
  for (const [key, value] of Object.entries(merged)) {
    if (!shellEnvKeys.has(key)) process.env[key] = value;
  }
}

function normalizePrefix(name: string) {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function envValue(keys: string[]) {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
}

function parseResources(value?: string): ResourceName[] {
  if (!value) return [...DefaultResources];
  const list = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const result: ResourceName[] = [];
  for (const item of list) {
    if (!DefaultResources.includes(item as ResourceName)) {
      throw new Error(`Unsupported resource: ${item}. Valid: ${DefaultResources.join(",")}`);
    }
    result.push(item as ResourceName);
  }
  return Array.from(new Set(result));
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file: string, data: unknown, pretty = true) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, pretty ? 2 : 0)}\n`, "utf8");
}

function safeName(value: string, options?: { lower?: boolean }) {
  const lower = Boolean(options?.lower);
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  const cleaned = normalized
    .trim()
    .replace(/[\s/\\:*?"<>|]+/g, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/\.+/g, ".")
    .replace(/_+/g, "_")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");

  const finalName = (lower ? cleaned.toLowerCase() : cleaned).slice(0, 120);
  return finalName || "item";
}

function uniqueBaseName(base: string, used: Set<string>) {
  const normalized = base || "item";
  if (!used.has(normalized)) {
    used.add(normalized);
    return normalized;
  }
  let idx = 2;
  while (used.has(`${normalized}-${idx}`)) idx += 1;
  const next = `${normalized}-${idx}`;
  used.add(next);
  return next;
}

function resetDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function stableStringify(input: unknown): string {
  const seen = new WeakSet<object>();
  function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => normalize(v));
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

function hashObject(input: unknown): string {
  return createHash("sha1").update(stableStringify(input)).digest("hex");
}

function removeKeys<T extends Record<string, unknown>>(input: T, keys: string[]): T {
  const clone = JSON.parse(JSON.stringify(input)) as T;
  for (const key of keys) delete clone[key];
  return clone;
}

async function fetchResources(client: GrafanaClient, resources: ResourceName[]): Promise<ExportBundle> {
  const bundle: ExportBundle = {
    generatedAt: new Date().toISOString(),
    url: client.url,
    resources,
  };

  for (const resource of resources) {
    try {
      if (resource === "folders") {
        bundle.folders = addTypeList(
          await client.request<unknown[]>("GET", "/api/folders?limit=1000&page=1"),
          "folder",
        );
        continue;
      }

      if (resource === "dashboards") {
        const list = asObjectArray(
          await client.request<unknown[]>("GET", "/api/search?type=dash-db&limit=5000"),
        );
        const dashboards = await mapLimit(list, 8, async (item) => {
          const uid = asString(item.uid);
          if (!uid) return item;
          const full = asObject(
            await client.request<unknown>("GET", `/api/dashboards/uid/${encodeURIComponent(uid)}`),
          );
          const meta = full ? getObjectField(full, "meta") : undefined;
          return addType(
            {
              uid,
              title: asString(item.title),
              folderUid: asString(meta?.folderUid) ?? null,
              dashboard: full?.dashboard,
            },
            "dashboard",
          );
        });
        bundle.dashboards = dashboards;
        continue;
      }

      if (resource === "datasources") {
        bundle.datasources = addTypeList(
          await client.request<unknown[]>("GET", "/api/datasources"),
          "connection",
        );
        continue;
      }

      if (resource === "alert-rules") {
        bundle["alert-rules"] = addTypeList(
          await client.request<unknown[]>("GET", "/api/v1/provisioning/alert-rules"),
          "alert-rule",
        );
        continue;
      }

      if (resource === "contact-points") {
        bundle["contact-points"] = addTypeList(
          await client.request<unknown[]>("GET", "/api/v1/provisioning/contact-points"),
          "contact-point",
        );
        continue;
      }

      if (resource === "policies") {
        bundle.policies = addType(
          await client.request<unknown>("GET", "/api/v1/provisioning/policies"),
          "policy",
        );
      }
    } catch (error) {
      console.warn(`[WARN] skip ${resource}: ${(error as Error).message}`);
    }
  }

  return bundle;
}

function bundleToFiles(outDir: string, bundle: ExportBundle, pretty: boolean) {
  ensureDir(outDir);
  // Remove legacy aggregate outputs. Export only split resource files.
  for (const file of [
    "bundle.meta.json",
    "folders.json",
    "dashboards.json",
    "datasources.json",
    "alert-rules.json",
    "contact-points.json",
    "policies.json",
  ]) {
    fs.rmSync(path.join(outDir, file), { force: true });
  }

  writeJson(
    path.join(outDir, "grafana.manifest.json"),
    {
      __type: "grafana-manifest",
      schemaVersion: 1,
      generatedAt: bundle.generatedAt,
      profile: bundle.profile,
      url: bundle.url,
      resources: bundle.resources,
      counts: {
        folders: Array.isArray(bundle.folders) ? bundle.folders.length : 0,
        dashboards: Array.isArray(bundle.dashboards) ? bundle.dashboards.length : 0,
        datasources: Array.isArray(bundle.datasources) ? bundle.datasources.length : 0,
        "alert-rules": Array.isArray(bundle["alert-rules"]) ? bundle["alert-rules"].length : 0,
        "contact-points": Array.isArray(bundle["contact-points"]) ? bundle["contact-points"].length : 0,
        policies: bundle.policies === undefined ? 0 : 1,
      },
    },
    pretty,
  );

  // Split dump for easier review and git diff.
  if (Array.isArray(bundle.dashboards)) {
    const dir = path.join(outDir, "dashboard");
    resetDir(dir);
    const used = new Set<string>();
    for (const item of asObjectArray(bundle.dashboards)) {
      const dashboard = getObjectField(item, "dashboard");
      const uid = String(item.uid || dashboard?.uid || "");
      const title = String(item.title || dashboard?.title || uid || "dashboard");
      const filename = uniqueBaseName(safeName(title), used);
      const file = path.join(dir, `${filename}.json`);
      writeJson(file, item, pretty);
    }
  }

  if (Array.isArray(bundle.datasources)) {
    const dir = path.join(outDir, "connection");
    resetDir(dir);
    const used = new Set<string>();
    for (const item of asObjectArray(bundle.datasources)) {
      const uid = String(item.uid || "");
      const name = String(item.name || uid || "datasource");
      const filename = uniqueBaseName(safeName(name), used);
      const file = path.join(dir, `${filename}.json`);
      writeJson(file, item, pretty);
    }
  }

  if (Array.isArray(bundle.folders)) {
    const dir = path.join(outDir, "folder");
    resetDir(dir);
    const used = new Set<string>();
    for (const item of asObjectArray(bundle.folders)) {
      const title = String(item.title || "folder");
      const file = path.join(dir, `${uniqueBaseName(safeName(title), used)}.json`);
      writeJson(file, item, pretty);
    }
  }

  if (Array.isArray(bundle["alert-rules"])) {
    const dir = path.join(outDir, "alert-rule");
    resetDir(dir);
    const used = new Set<string>();
    for (const item of asObjectArray(bundle["alert-rules"])) {
      const uid = String(item.uid || "");
      const title = String(item.title || item.name || uid || "alert-rule");
      const base = uid ? `${safeName(title)}-${safeName(uid)}` : safeName(title);
      const file = path.join(dir, `${uniqueBaseName(base, used)}.json`);
      writeJson(file, item, pretty);
    }
  }

  if (Array.isArray(bundle["contact-points"])) {
    const dir = path.join(outDir, "contact-point");
    resetDir(dir);
    const used = new Set<string>();
    for (const item of asObjectArray(bundle["contact-points"])) {
      const uid = String(item.uid || "");
      const name = String(item.name || item.title || uid || "contact-point");
      const base = uid ? `${safeName(name)}-${safeName(uid)}` : safeName(name);
      const file = path.join(dir, `${uniqueBaseName(base, used)}.json`);
      writeJson(file, item, pretty);
    }
  }

  if (bundle.policies !== undefined) {
    const dir = path.join(outDir, "policy");
    resetDir(dir);
    writeJson(path.join(dir, "root.json"), bundle.policies, pretty);
  }
}

function dedupeResources(resources: ResourceName[]): ResourceName[] {
  return Array.from(new Set(resources));
}

function resourceFromType(type: string | undefined): ResourceName | undefined {
  switch (type) {
    case "dashboard":
      return "dashboards";
    case "connection":
    case "datasource":
      return "datasources";
    case "folder":
      return "folders";
    case "alert-rule":
      return "alert-rules";
    case "contact-point":
      return "contact-points";
    case "policy":
      return "policies";
    default:
      return undefined;
  }
}

function parseResourceAlias(value: string | undefined): ResourceName | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "dashboard" || v === "dashboards") return "dashboards";
  if (v === "connection" || v === "connections" || v === "datasource" || v === "datasources")
    return "datasources";
  if (v === "folder" || v === "folders") return "folders";
  if (v === "alert-rule" || v === "alert-rules" || v === "alertrule" || v === "alertrules")
    return "alert-rules";
  if (v === "contact-point" || v === "contact-points" || v === "contactpoint" || v === "contactpoints")
    return "contact-points";
  if (v === "policy" || v === "policies") return "policies";
  return undefined;
}

function resourceFromFilePath(filePath: string): ResourceName | undefined {
  // Collect should not rely on file name patterns, only location and JSON type.
  const dir = path.basename(path.dirname(filePath)).toLowerCase();
  if (dir === "dashboard") return "dashboards";
  if (dir === "connection") return "datasources";
  if (dir === "folder") return "folders";
  if (dir === "alert-rule") return "alert-rules";
  if (dir === "contact-point") return "contact-points";
  if (dir === "policy") return "policies";
  return undefined;
}

function inferResourceFromObject(value: JsonObject): ResourceName | undefined {
  if (value.dashboard && typeof value.dashboard === "object") return "dashboards";
  if (value.title && value.uid && value.dashboard === undefined && value.schemaVersion === undefined)
    return "folders";
  if (value.type && (value.url !== undefined || value.access !== undefined || value.database !== undefined))
    return "datasources";
  if (value.ruleGroup && value.data && value.condition) return "alert-rules";
  if (value.settings && value.type && (value.name || value.uid)) return "contact-points";
  if (value.receiver || value.group_by || value.routes) return "policies";
  return undefined;
}

function appendEntry(bundle: ExportBundle, resource: ResourceName, value: unknown) {
  if (resource === "policies") {
    bundle.policies = value;
    return;
  }

  if (resource === "dashboards") {
    bundle.dashboards = [...(bundle.dashboards || []), ...(Array.isArray(value) ? value : [value])];
    return;
  }
  if (resource === "datasources") {
    bundle.datasources = [...(bundle.datasources || []), ...(Array.isArray(value) ? value : [value])];
    return;
  }
  if (resource === "folders") {
    bundle.folders = [...(bundle.folders || []), ...(Array.isArray(value) ? value : [value])];
    return;
  }
  if (resource === "alert-rules") {
    bundle["alert-rules"] = [...(bundle["alert-rules"] || []), ...(Array.isArray(value) ? value : [value])];
    return;
  }
  if (resource === "contact-points") {
    bundle["contact-points"] = [
      ...(bundle["contact-points"] || []),
      ...(Array.isArray(value) ? value : [value]),
    ];
  }
}

function mergeBundle(target: ExportBundle, from: ExportBundle) {
  if (from.folders) appendEntry(target, "folders", from.folders);
  if (from.dashboards) appendEntry(target, "dashboards", from.dashboards);
  if (from.datasources) appendEntry(target, "datasources", from.datasources);
  if (from["alert-rules"]) appendEntry(target, "alert-rules", from["alert-rules"]);
  if (from["contact-points"]) appendEntry(target, "contact-points", from["contact-points"]);
  if (from.policies !== undefined) appendEntry(target, "policies", from.policies);
}

function applyJsonFileToBundle(
  bundle: ExportBundle,
  filePath: string,
  value: unknown,
  forcedResource?: ResourceName,
) {
  const fileResource = resourceFromFilePath(filePath);
  const fallback = forcedResource || fileResource;

  if (Array.isArray(value)) {
    const typed = value as Array<Record<string, unknown>>;
    const fromType = resourceFromType(
      typeof typed[0]?.__type === "string" ? String(typed[0].__type) : undefined,
    );
    const inferred = typed[0] ? inferResourceFromObject(typed[0]) : undefined;
    const resource = fromType || fallback || inferred;
    if (resource) appendEntry(bundle, resource, typed);
    return;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const byType = resourceFromType(typeof obj.__type === "string" ? String(obj.__type) : undefined);
    const inferred = inferResourceFromObject(obj);
    const resource = byType || fallback || inferred;
    if (!resource) return;
    appendEntry(bundle, resource, obj);
  }
}

function loadImportTarget(targetPath: string, forcedResource?: ResourceName): ExportBundle {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Import target not found: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
    const bundle = createEmptyBundle();
    applyJsonFileToBundle(bundle, resolved, value, forcedResource);
    return bundle;
  }

  // Directory with scattered JSON files.
  const bundle = createEmptyBundle();
  const queue = [resolved];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!st.isFile() || !name.toLowerCase().endsWith(".json")) continue;
      if (name === "bundle.meta.json") continue;
      try {
        const value = JSON.parse(fs.readFileSync(full, "utf8"));
        applyJsonFileToBundle(bundle, full, value, forcedResource);
      } catch {
        // Ignore invalid JSON files in mixed directories.
      }
    }
  }
  return bundle;
}

function collectBundle(sources: string[], forcedResource?: ResourceName): ExportBundle {
  const merged = createEmptyBundle();
  for (const source of sources) {
    const loaded = loadImportTarget(source, forcedResource);
    mergeBundle(merged, loaded);
  }
  dedupeBundleEntries(merged);
  return merged;
}

function dedupeByKey(resource: ResourceName, items: unknown[] | undefined): unknown[] | undefined {
  if (!Array.isArray(items)) return items;
  const map = new Map<string, unknown>();
  for (const item of items) {
    map.set(keyFor(resource, item), item);
  }
  return Array.from(map.values());
}

function dedupeBundleEntries(bundle: ExportBundle) {
  bundle.dashboards = dedupeByKey("dashboards", bundle.dashboards);
  bundle.datasources = dedupeByKey("datasources", bundle.datasources);
  bundle.folders = dedupeByKey("folders", bundle.folders);
  bundle["alert-rules"] = dedupeByKey("alert-rules", bundle["alert-rules"]);
  bundle["contact-points"] = dedupeByKey("contact-points", bundle["contact-points"]);
}

function keyFor(resource: ResourceName, item: unknown): string {
  const obj = asObject(item);
  const dashboard = obj ? getObjectField(obj, "dashboard") : undefined;
  if (resource === "dashboards") return String(obj?.uid || dashboard?.uid || obj?.title || hashObject(item));
  if (resource === "datasources") return String(obj?.uid || obj?.name || hashObject(item));
  if (resource === "folders") return String(obj?.uid || obj?.title || hashObject(item));
  if (resource === "alert-rules") return String(obj?.title || obj?.name || obj?.uid || hashObject(item));
  if (resource === "contact-points") return String(obj?.uid || obj?.name || hashObject(item));
  return hashObject(item);
}

function diffArray(
  resource: ResourceName,
  localData: unknown[] = [],
  remoteData: unknown[] = [],
): DiffItem[] {
  const localMap = new Map<string, string>();
  const remoteMap = new Map<string, string>();

  for (const item of localData) {
    const key = keyFor(resource, item);
    localMap.set(key, hashObject(item));
  }
  for (const item of remoteData) {
    const key = keyFor(resource, item);
    remoteMap.set(key, hashObject(item));
  }

  const allKeys = new Set([...localMap.keys(), ...remoteMap.keys()]);
  const diff: DiffItem[] = [];

  for (const key of Array.from(allKeys).sort()) {
    const localHash = localMap.get(key);
    const remoteHash = remoteMap.get(key);
    if (!localHash && remoteHash) diff.push({ key, change: "removed" });
    else if (localHash && !remoteHash) diff.push({ key, change: "added" });
    else if (localHash !== remoteHash) diff.push({ key, change: "changed" });
  }

  return diff;
}

function parseJsonLike(value: string): unknown {
  const text = value.trim();
  if (!text.length) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pathSegments(pathExpr: string): Array<string | number> {
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

function getPathValue(input: unknown, pathExpr?: string): unknown {
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

function setPathValue(target: Record<string, unknown>, pathExpr: string, value: unknown) {
  const parts = pathSegments(pathExpr);
  if (!parts.length) throw new Error("Invalid --path");

  let cursor: MutableJson = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const next = parts[i + 1];
    if (key === undefined || next === undefined) {
      throw new Error("Invalid --path");
    }
    if (typeof key === "number") {
      if (!Array.isArray(cursor)) throw new Error(`Path requires array at segment [${key}]`);
      if (cursor[key] === undefined) cursor[key] = typeof next === "number" ? [] : {};
      cursor = cursor[key];
      continue;
    }
    if (Array.isArray(cursor)) throw new Error(`Path requires object at segment ${key}`);
    if (!cursor[key] || typeof cursor[key] !== "object") {
      cursor[key] = typeof next === "number" ? [] : {};
    }
    cursor = cursor[key] as MutableJson;
  }

  const leaf = parts[parts.length - 1];
  if (leaf === undefined) {
    throw new Error("Invalid --path");
  }
  if (typeof leaf === "number") {
    if (!Array.isArray(cursor)) throw new Error(`Path requires array at segment [${leaf}]`);
    cursor[leaf] = value;
  } else {
    if (Array.isArray(cursor)) throw new Error(`Path requires object at segment ${leaf}`);
    cursor[leaf] = value;
  }
}

function deepMerge(base: unknown, extra: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(extra)) return extra;
  if (!base || typeof base !== "object") return extra;
  if (!extra || typeof extra !== "object") return extra;

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

function parseWhereExpr(expr: string): { path: string; value: unknown } {
  const index = expr.indexOf("=");
  if (index <= 0) throw new Error(`Invalid --where expression: ${expr}. Expect path=value`);
  const left = expr.slice(0, index).trim();
  const right = expr.slice(index + 1);
  if (!left) throw new Error(`Invalid --where expression: ${expr}. Missing path`);
  return WhereExprSchema.parse({ path: left, value: parseJsonLike(right) });
}

function valueEqual(a: unknown, b: unknown) {
  return stableStringify(a) === stableStringify(b);
}

function resourceItems(bundle: ExportBundle, resource: ResourceName): unknown[] {
  if (resource === "policies") return bundle.policies === undefined ? [] : [bundle.policies];
  if (resource === "dashboards") return Array.isArray(bundle.dashboards) ? bundle.dashboards : [];
  if (resource === "datasources") return Array.isArray(bundle.datasources) ? bundle.datasources : [];
  if (resource === "folders") return Array.isArray(bundle.folders) ? bundle.folders : [];
  if (resource === "alert-rules") return Array.isArray(bundle["alert-rules"]) ? bundle["alert-rules"] : [];
  if (resource === "contact-points")
    return Array.isArray(bundle["contact-points"]) ? bundle["contact-points"] : [];
  return [];
}

function setSingleResource(bundle: ExportBundle, resource: ResourceName, item: unknown) {
  if (resource === "policies") {
    bundle.policies = item;
    return;
  }
  if (resource === "dashboards") {
    bundle.dashboards = [item];
    return;
  }
  if (resource === "datasources") {
    bundle.datasources = [item];
    return;
  }
  if (resource === "folders") {
    bundle.folders = [item];
    return;
  }
  if (resource === "alert-rules") {
    bundle["alert-rules"] = [item];
    return;
  }
  if (resource === "contact-points") {
    bundle["contact-points"] = [item];
  }
}

function selectResource(
  items: unknown[],
  resource: ResourceName,
  selector: ResourceSelector,
  allowMissing = false,
): unknown | undefined {
  let found = [...items];

  if (selector.id) {
    const id = selector.id;
    found = found.filter((item) => {
      const obj = asObject(item);
      const dashboard = obj ? getObjectField(obj, "dashboard") : undefined;
      const ids = [obj?.id, dashboard?.id].filter((v) => v !== undefined && v !== null);
      return ids.some((v) => String(v) === id);
    });
  }
  if (selector.uid) {
    const uid = selector.uid;
    found = found.filter((item) => {
      const obj = asObject(item);
      const dashboard = obj ? getObjectField(obj, "dashboard") : undefined;
      return String(obj?.uid || dashboard?.uid || "") === uid;
    });
  }
  if (selector.name) {
    const name = selector.name;
    found = found.filter((item) => String(asObject(item)?.name || "") === name);
  }
  if (selector.title) {
    const title = selector.title;
    found = found.filter((item) => {
      const obj = asObject(item);
      const dashboard = obj ? getObjectField(obj, "dashboard") : undefined;
      return String(obj?.title || dashboard?.title || "") === title;
    });
  }
  for (const whereExpr of selector.where) {
    const { path, value } = parseWhereExpr(whereExpr);
    found = found.filter((item) => valueEqual(getPathValue(item, path), value));
  }

  const hasSelector =
    Boolean(selector.id) ||
    Boolean(selector.uid) ||
    Boolean(selector.name) ||
    Boolean(selector.title) ||
    selector.where.length > 0;

  if (found.length === 1) return found[0];
  if (found.length === 0) {
    if (allowMissing) return undefined;
    throw new Error(`No ${resource} matched selector`);
  }
  if (hasSelector) {
    throw new Error(`Selector matched multiple ${resource}: ${found.length}`);
  }
  if (found.length > 1) {
    throw new Error(
      `Multiple ${resource} found (${found.length}), use --uid/--name/--title/--where to select one`,
    );
  }
  return found[0];
}

function parseSetExpr(expr: string, defaultPath?: string): { path: string; value: unknown } {
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

type OutputFormat = "text" | "json";
type RuntimeContext = GrafanaCliContext & { output: OutputFormat; quiet: boolean };

function printMessage(ctx: RuntimeContext, message: string) {
  if (ctx.output === "json") {
    console.log(JSON.stringify({ type: "message", message }));
    return;
  }
  if (!ctx.quiet) console.log(message);
}

function printData(ctx: RuntimeContext, type: string, data: Record<string, unknown>) {
  if (ctx.output === "json") {
    console.log(JSON.stringify({ type, ...data }));
    return;
  }
  if (!ctx.quiet && data.message && typeof data.message === "string") {
    console.log(data.message);
  }
}

function parseCommonOptions(cmd: Command, cfg?: { requireUrl?: boolean }): RuntimeContext {
  const options = cmd.optsWithGlobals() as {
    name?: string;
    url?: string;
    serviceAccountToken?: string;
    timeout?: string;
    dryRun?: boolean;
    debug?: boolean;
    output?: string;
    quiet?: boolean;
  };

  const profile = options.name?.trim();
  const prefix = profile ? normalizePrefix(profile) : undefined;

  const url =
    options.url ||
    envValue(
      [prefix ? `${prefix}_GRAFANA_URL` : "", profile ? `${profile}_GRAFANA_URL` : "", "GRAFANA_URL"].filter(
        Boolean,
      ),
    );

  const apiKey =
    options.serviceAccountToken ||
    envValue(
      [
        prefix ? `${prefix}_GRAFANA_SERVICE_ACCOUNT_TOKEN` : "",
        profile ? `${profile}_GRAFANA_SERVICE_ACCOUNT_TOKEN` : "",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN",
      ].filter(Boolean),
    );

  const requireUrl = cfg?.requireUrl !== false;
  if (requireUrl && !url) {
    throw new Error("Missing Grafana URL. Set GRAFANA_URL or NAME_GRAFANA_URL, or pass --url");
  }

  const timeoutMs = Math.max(1000, Number.parseInt(options.timeout || "20000", 10) || 20000);

  const output: OutputFormat = options.output === "json" ? "json" : "text";

  const parsed = GrafanaCliContextSchema.parse({
    profile,
    url: url || "",
    apiKey,
    timeoutMs,
    dryRun: Boolean(options.dryRun),
    debug: Boolean(options.debug),
  });

  return {
    ...parsed,
    output,
    quiet: Boolean(options.quiet),
  };
}

async function importResources(ctx: RuntimeContext, bundle: ExportBundle, resources: ResourceName[]) {
  const client = new GrafanaClient(ctx);

  const has = (resource: ResourceName) => resources.includes(resource);

  if (has("folders") && Array.isArray(bundle.folders)) {
    printData(ctx, "import-folders-start", {
      count: bundle.folders.length,
      message: `Import folders: ${bundle.folders.length}`,
    });
    for (const folder of asObjectArray(bundle.folders)) {
      if (!folder.uid || !folder.title) continue;
      const body = {
        uid: folder.uid,
        title: folder.title,
      };
      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "folders",
          action: "upsert",
          uid: folder.uid,
          message: `[DRY-RUN] folder upsert ${String(folder.uid)}`,
        });
      } else {
        try {
          await client.request("PUT", `/api/folders/${encodeURIComponent(folder.uid)}`, body, [200]);
        } catch {
          await client.request("POST", "/api/folders", body, [200]);
        }
      }
    }
  }

  if (has("datasources") && Array.isArray(bundle.datasources)) {
    printData(ctx, "import-datasources-start", {
      count: bundle.datasources.length,
      message: `Import datasources: ${bundle.datasources.length}`,
    });
    const existing = asObjectArray(await client.request<unknown[]>("GET", "/api/datasources"));
    const byUid = new Map(existing.map((v) => [String(v.uid), v]));
    const byName = new Map(existing.map((v) => [String(v.name), v]));

    for (const raw of asObjectArray(bundle.datasources)) {
      const source = stripMeta(raw);
      const datasource = removeKeys(source, [
        "id",
        "orgId",
        "version",
        "readOnly",
        "created",
        "updated",
        "typeLogoUrl",
        "secureJsonFields",
      ]);

      const keyUid = datasource.uid ? String(datasource.uid) : undefined;
      const keyName = datasource.name ? String(datasource.name) : undefined;
      const existingDs = (keyUid && byUid.get(keyUid)) || (keyName && byName.get(keyName));

      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "datasources",
          action: existingDs ? "update" : "create",
          key: keyUid || keyName || "(unknown)",
          message: `[DRY-RUN] datasource ${existingDs ? "update" : "create"} ${keyUid || keyName || "(unknown)"}`,
        });
        continue;
      }

      if (existingDs?.uid) {
        await client.request(
          "PUT",
          `/api/datasources/uid/${encodeURIComponent(existingDs.uid)}`,
          datasource,
          [200],
        );
      } else {
        await client.request("POST", "/api/datasources", datasource, [200]);
      }
    }
  }

  if (has("dashboards") && Array.isArray(bundle.dashboards)) {
    printData(ctx, "import-dashboards-start", {
      count: bundle.dashboards.length,
      message: `Import dashboards: ${bundle.dashboards.length}`,
    });
    for (const item of asObjectArray(bundle.dashboards)) {
      const cleanItem = stripMeta(item);
      const dashboard = cleanItem.dashboard || cleanItem;
      if (!dashboard?.uid && !dashboard?.title) continue;

      const cleaned = removeKeys(dashboard, ["id"]);
      const body = {
        dashboard: { ...cleaned, id: null },
        folderUid: cleanItem.folderUid || undefined,
        overwrite: true,
        message: `imported by ${CliName}`,
      };

      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "dashboards",
          action: "upsert",
          key: String(dashboard.uid || dashboard.title || "(unknown)"),
          message: `[DRY-RUN] dashboard upsert ${String(dashboard.uid || dashboard.title || "(unknown)")}`,
        });
      } else {
        await client.request("POST", "/api/dashboards/db", body, [200]);
      }
    }
  }

  if (has("alert-rules") && Array.isArray(bundle["alert-rules"])) {
    printData(ctx, "import-alert-rules-start", {
      count: bundle["alert-rules"].length,
      message: `Import alert-rules: ${bundle["alert-rules"].length}`,
    });
    for (const rule of asObjectArray(bundle["alert-rules"])) {
      const cleanRule = stripMeta(rule);
      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "alert-rules",
          action: "upsert",
          key: String(cleanRule.uid || cleanRule.title || "(unknown)"),
          message: `[DRY-RUN] alert-rule upsert ${String(cleanRule.uid || cleanRule.title || "(unknown)")}`,
        });
        continue;
      }
      if (cleanRule.uid) {
        try {
          await client.request(
            "PUT",
            `/api/v1/provisioning/alert-rules/${encodeURIComponent(cleanRule.uid)}`,
            cleanRule,
            [200],
          );
        } catch {
          await client.request("POST", "/api/v1/provisioning/alert-rules", cleanRule, [201]);
        }
      } else {
        await client.request("POST", "/api/v1/provisioning/alert-rules", cleanRule, [201]);
      }
    }
  }

  if (has("contact-points") && Array.isArray(bundle["contact-points"])) {
    printData(ctx, "import-contact-points-start", {
      count: bundle["contact-points"].length,
      message: `Import contact-points: ${bundle["contact-points"].length}`,
    });
    for (const cp of asObjectArray(bundle["contact-points"])) {
      const cleanCp = stripMeta(cp);
      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "contact-points",
          action: "upsert",
          key: String(cleanCp.uid || cleanCp.name || "(unknown)"),
          message: `[DRY-RUN] contact-point upsert ${String(cleanCp.uid || cleanCp.name || "(unknown)")}`,
        });
        continue;
      }
      if (cleanCp.uid) {
        try {
          await client.request(
            "PUT",
            `/api/v1/provisioning/contact-points/${encodeURIComponent(cleanCp.uid)}`,
            cleanCp,
            [202],
          );
        } catch {
          await client.request("POST", "/api/v1/provisioning/contact-points", cleanCp, [202]);
        }
      } else {
        await client.request("POST", "/api/v1/provisioning/contact-points", cleanCp, [202]);
      }
    }
  }

  if (has("policies") && bundle.policies !== undefined) {
    printData(ctx, "import-policies-start", { count: 1, message: "Import policies: 1" });
    if (ctx.dryRun) {
      printData(ctx, "dry-run", {
        resource: "policies",
        action: "replace",
        message: "[DRY-RUN] policy tree replace",
      });
    } else {
      await client.request("PUT", "/api/v1/provisioning/policies", stripMeta(bundle.policies), [202]);
    }
  }
}

async function deleteSingleResource(ctx: RuntimeContext, resource: ResourceName, selector: ResourceSelector) {
  if (resource === "policies") {
    throw new Error("Delete is not supported for policies");
  }

  const client = new GrafanaClient(ctx);
  const remote = await fetchResources(client, [resource]);
  const selected = selectResource(resourceItems(remote, resource), resource, selector, false);

  const selectedObj = asObject(selected);
  const selectedDashboard = selectedObj ? getObjectField(selectedObj, "dashboard") : undefined;
  const uid = String(selectedObj?.uid || selectedDashboard?.uid || "");
  const name = String(selectedObj?.name || selectedObj?.title || selectedDashboard?.title || "");

  if (
    !uid &&
    (resource === "datasources" ||
      resource === "dashboards" ||
      resource === "folders" ||
      resource === "alert-rules")
  ) {
    throw new Error(`Selected ${resource} has no uid, cannot delete`);
  }

  if (ctx.dryRun) {
    printData(ctx, "dry-run", {
      resource,
      action: "delete",
      key: uid || name || "(unknown)",
      message: `[DRY-RUN] delete ${resource} ${uid || name || "(unknown)"}`,
    });
    return selected;
  }

  if (resource === "datasources") {
    await client.request("DELETE", `/api/datasources/uid/${encodeURIComponent(uid)}`, undefined, [200]);
    return selected;
  }
  if (resource === "dashboards") {
    await client.request("DELETE", `/api/dashboards/uid/${encodeURIComponent(uid)}`, undefined, [200]);
    return selected;
  }
  if (resource === "folders") {
    await client.request("DELETE", `/api/folders/${encodeURIComponent(uid)}`, undefined, [200]);
    return selected;
  }
  if (resource === "alert-rules") {
    await client.request(
      "DELETE",
      `/api/v1/provisioning/alert-rules/${encodeURIComponent(uid)}`,
      undefined,
      [204, 200],
    );
    return selected;
  }
  if (resource === "contact-points") {
    await client.request(
      "DELETE",
      `/api/v1/provisioning/contact-points/${encodeURIComponent(uid)}`,
      undefined,
      [204, 200],
    );
    return selected;
  }

  throw new Error(`Delete for ${resource} is not implemented yet`);
}

function parseIdOrUidSelector(idOrUid: string): ResourceSelector {
  const token = String(idOrUid || "").trim();
  if (!token) throw new Error("Missing id-or-uid");
  if (/^\d+$/.test(token)) return ResourceSelectorSchema.parse({ id: token, uid: token, where: [] });
  return ResourceSelectorSchema.parse({ uid: token, where: [] });
}

export async function run() {
  loadEnv();

  const program = new Command(CliName);
  const collectList = (value: string, prev: string[]) => {
    prev.push(value);
    return prev;
  };
  program
    .description("Grafana resource tool (export/import/diff/query/patch/delete)")
    .option("-n, --name <name>", "profile name, e.g. ppio -> PPIO_GRAFANA_URL/SERVICE_ACCOUNT_TOKEN")
    .option("--url <url>", "Grafana URL")
    .option("--service-account-token <token>", "Grafana service account token")
    .option("--timeout <ms>", "request timeout in milliseconds", "20000")
    .option("--dry-run", "show planned changes without writing")
    .option("--output <format>", "output format: text|json", "text")
    .option("-q, --quiet", "hide text progress logs")
    .option("--debug", "debug HTTP requests");

  program.addHelpText(
    "after",
    `
Common workflows:

  # dump/pull from remote to local workspace
  ${CliName} --name local export -o local/grafana-export

  # local edit a single resource file
  ${CliName} query dashboard --uid <uid> --json > local/dashboard.json
  $EDITOR local/dashboard.json

  # import a single json file (auto infer by payload, or set --type)
  ${CliName} --name local import local/dashboard.json
  ${CliName} --name local import local/resource.json --type dashboard

  # diff local workspace against remote
  ${CliName} --name local --output json diff -i local/grafana-export

  # push workflow: apply local changes to remote (use dry-run first)
  ${CliName} --name local --dry-run import local/grafana-export
  ${CliName} --name local import local/grafana-export
`,
  );

  program
    .command("export")
    .description("Export Grafana resources to local json files")
    .option("-o, --out <dir>", "output directory", "./grafana-export")
    .option("-r, --resources <list>", `comma-separated resources: ${DefaultResources.join(",")}`)
    .option("--compact", "write compact json")
    .action(async function exportAction(options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resources = parseResources(options.resources);
      const outDir = path.resolve(options.out);

      const client = new GrafanaClient(ctx);
      const bundle = await fetchResources(client, resources);
      bundle.profile = ctx.profile;

      bundleToFiles(outDir, bundle, !options.compact);
      printData(ctx, "export-complete", {
        resources,
        outputDir: outDir,
        message: `Exported resources: ${resources.join(",")}\nOutput directory: ${outDir}`,
      });
    });

  program
    .command("import [sources...]")
    .description("Import resources from local json files/directories to Grafana")
    .option("-r, --resources <list>", `comma-separated resources: ${DefaultResources.join(",")}`)
    .option(
      "-t, --type <type>",
      "fallback type when JSON has no __type (dashboard|connection|folder|alert-rule|contact-point|policy)",
    )
    .action(async function importAction(sources: string[] | undefined, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resources = parseResources(options.resources);
      const fallbackType = parseResourceAlias(options.type);
      if (options.type && !fallbackType) {
        throw new Error(`Unsupported --type: ${options.type}`);
      }
      const sourceList = sources && sources.length > 0 ? sources : ["./grafana-export"];
      const resolvedSources = sourceList.map((source) => path.resolve(source));
      printData(ctx, "collect-sources", {
        sources: resolvedSources,
        message: `Collect sources: ${resolvedSources.join(", ")}`,
      });
      const merged = collectBundle(resolvedSources, fallbackType);
      merged.resources = dedupeResources(resources);

      await importResources(ctx, merged, resources);
      printData(ctx, "import-complete", {
        resources,
        input: resolvedSources,
        dryRun: ctx.dryRun,
        message: `Imported resources: ${resources.join(",")}\nInput: ${resolvedSources.join(", ")}`,
      });
      if (ctx.dryRun) printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
    });

  program
    .command("diff")
    .description("Diff local exported resources against current Grafana")
    .option("-i, --in <dir>", "input directory", "./grafana-export")
    .option("-r, --resources <list>", `comma-separated resources: ${DefaultResources.join(",")}`)
    .option(
      "--resource <resource>",
      "single resource mode (dashboard|connection|folder|alert-rule|contact-point|policy)",
    )
    .option("--id <id>", "resource id selector")
    .option("--uid <uid>", "resource uid selector")
    .option("--match-name <name>", "resource name selector")
    .option("--title <title>", "resource title selector")
    .option("-w, --where <expr>", "filter path=value, repeatable", collectList, [])
    .option("--path <path>", "only compare value at this path")
    .option("--json", "print full diff as JSON")
    .action(async function diffAction(options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resources = parseResources(options.resources);
      const inPath = path.resolve(options.in);

      if (options.resource) {
        const resource = parseResourceAlias(options.resource);
        if (!resource) throw new Error(`Unsupported --resource: ${options.resource}`);

        const selector: ResourceSelector = ResourceSelectorSchema.parse({
          id: options.id,
          uid: options.uid,
          name: options.matchName,
          title: options.title,
          where: options.where || [],
        });
        const localBundle = collectBundle([inPath], resource);
        const remoteBundle = await fetchResources(new GrafanaClient(ctx), [resource]);

        const localItem = selectResource(resourceItems(localBundle, resource), resource, selector, true);
        const remoteItem = selectResource(resourceItems(remoteBundle, resource), resource, selector, true);
        const localValue = getPathValue(localItem, options.path);
        const remoteValue = getPathValue(remoteItem, options.path);
        const changed = !valueEqual(localValue, remoteValue);

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                resource,
                selector,
                path: options.path || null,
                changed,
                local: localValue,
                remote: remoteValue,
              },
              null,
              2,
            ),
          );
        } else {
          printMessage(ctx, `resource: ${resource}`);
          printMessage(ctx, `path: ${options.path || "(root)"}`);
          printMessage(ctx, `status: ${changed ? "changed" : "equal"}`);
          if (changed) {
            printMessage(ctx, `local: ${hashObject(localValue)}`);
            printMessage(ctx, `remote: ${hashObject(remoteValue)}`);
          }
        }

        if (changed) process.exitCode = 2;
        return;
      }

      const local = collectBundle([inPath]);
      const remote = await fetchResources(new GrafanaClient(ctx), resources);
      const result: Record<string, DiffItem[]> = {};

      for (const resource of resources) {
        if (resource === "policies") {
          const localHash = hashObject(local.policies || {});
          const remoteHash = hashObject(remote.policies || {});
          result[resource] = localHash === remoteHash ? [] : [{ key: "policies", change: "changed" }];
          continue;
        }

        const localData = resourceItems(local, resource);
        const remoteData = resourceItems(remote, resource);
        result[resource] = diffArray(resource, localData || [], remoteData || []);
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      let total = 0;
      for (const resource of resources) {
        const items = result[resource] || [];
        total += items.length;
        const added = items.filter((v) => v.change === "added").length;
        const removed = items.filter((v) => v.change === "removed").length;
        const changed = items.filter((v) => v.change === "changed").length;
        printMessage(ctx, `${resource}: +${added} -${removed} ~${changed} (total ${items.length})`);
        for (const line of items.slice(0, 20)) {
          printMessage(ctx, `  ${line.change.padEnd(7)} ${line.key}`);
        }
        if (items.length > 20) {
          printMessage(ctx, `  ... ${items.length - 20} more`);
        }
      }

      if (total === 0) printMessage(ctx, "No diff.");
      else process.exitCode = 2;
    });

  program
    .command("query <resource>")
    .description("Query a single resource from remote Grafana or local export")
    .option("-i, --in <target>", "optional local source path (directory or json file), default is remote")
    .option("--id <id>", "resource id selector")
    .option("--uid <uid>", "resource uid selector")
    .option("--match-name <name>", "resource name selector")
    .option("--title <title>", "resource title selector")
    .option("-w, --where <expr>", "filter path=value, repeatable", collectList, [])
    .option("--path <path>", "value path (dot / [index])")
    .option("--json", "print as json (default for objects)")
    .action(async function queryAction(resourceArg: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command, { requireUrl: !options.in });
      const resource = parseResourceAlias(resourceArg);
      if (!resource) throw new Error(`Unsupported resource: ${resourceArg}`);

      const selector: ResourceSelector = ResourceSelectorSchema.parse({
        id: options.id,
        uid: options.uid,
        name: options.matchName,
        title: options.title,
        where: options.where || [],
      });

      let items: unknown[] = [];
      if (options.in) {
        const localBundle = collectBundle([path.resolve(options.in)], resource);
        items = resourceItems(localBundle, resource);
      } else {
        const remoteBundle = await fetchResources(new GrafanaClient(ctx), [resource]);
        items = resourceItems(remoteBundle, resource);
      }

      const item = selectResource(items, resource, selector, false);
      const value = getPathValue(item, options.path);
      if (options.json || typeof value === "object") {
        console.log(JSON.stringify(value, null, 2));
      } else {
        console.log(String(value ?? ""));
      }
    });

  program
    .command("patch <resource>")
    .description("Patch a single remote resource with path/value updates")
    .option("--id <id>", "resource id selector")
    .option("--uid <uid>", "resource uid selector")
    .option("--match-name <name>", "resource name selector")
    .option("--title <title>", "resource title selector")
    .option("-w, --where <expr>", "filter path=value, repeatable", collectList, [])
    .option("--path <path>", "default path for value-only --set")
    .option("-s, --set <expr>", "patch expression path=value, repeatable", collectList, [])
    .option("--merge <json>", "deep merge JSON object into selected resource")
    .option("--from <file>", "replace selected resource with this JSON file content")
    .option("--json", "print patched json")
    .action(async function patchAction(resourceArg: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resource = parseResourceAlias(resourceArg);
      if (!resource) throw new Error(`Unsupported resource: ${resourceArg}`);

      const selector: ResourceSelector = ResourceSelectorSchema.parse({
        id: options.id,
        uid: options.uid,
        name: options.matchName,
        title: options.title,
        where: options.where || [],
      });

      const remoteBundle = await fetchResources(new GrafanaClient(ctx), [resource]);
      const current = selectResource(resourceItems(remoteBundle, resource), resource, selector, false);
      let updated: unknown = JSON.parse(JSON.stringify(current));

      if (options.from) {
        const fromFile = path.resolve(options.from);
        updated = JSON.parse(fs.readFileSync(fromFile, "utf8"));
      }

      if (options.merge) {
        const patchObj = parseJsonLike(options.merge);
        if (!patchObj || typeof patchObj !== "object" || Array.isArray(patchObj)) {
          throw new Error("--merge requires a JSON object");
        }
        updated = deepMerge(updated, patchObj);
      }

      const setExprs = options.set || [];
      for (const expr of setExprs) {
        const { path: setPath, value } = parseSetExpr(expr, options.path);
        if (!setPath) throw new Error(`Invalid --set expression: ${expr}`);
        if (!updated || typeof updated !== "object" || Array.isArray(updated)) {
          throw new Error("Patch target must be a JSON object");
        }
        setPathValue(updated as Record<string, unknown>, setPath, value);
      }

      if (setExprs.length === 0 && !options.merge && !options.from) {
        throw new Error("No patch operation provided. Use --set, --merge, or --from.");
      }

      const out = createEmptyBundle();
      out.resources = [resource];
      setSingleResource(out, resource, updated);
      await importResources(ctx, out, [resource]);

      if (options.json || ctx.dryRun) {
        console.log(JSON.stringify(updated, null, 2));
      }
      printMessage(ctx, `Patched ${resource}.`);
      if (ctx.dryRun) printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
    });

  program
    .command("delete <resource>")
    .description("Delete a single remote resource")
    .option("--id <id>", "resource id selector")
    .option("--uid <uid>", "resource uid selector")
    .option("--match-name <name>", "resource name selector")
    .option("--title <title>", "resource title selector")
    .option("-w, --where <expr>", "filter path=value, repeatable", collectList, [])
    .option("--json", "print selected resource json")
    .action(async function deleteAction(resourceArg: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resource = parseResourceAlias(resourceArg);
      if (!resource) throw new Error(`Unsupported resource: ${resourceArg}`);

      const selector: ResourceSelector = ResourceSelectorSchema.parse({
        id: options.id,
        uid: options.uid,
        name: options.matchName,
        title: options.title,
        where: options.where || [],
      });

      const selected = await deleteSingleResource(ctx, resource, selector);
      if (options.json || ctx.dryRun) {
        console.log(JSON.stringify(selected, null, 2));
      }
      printMessage(ctx, `Deleted ${resource}.`);
      if (ctx.dryRun) printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
    });

  const scopedResources: Array<{ cmd: string; resource: ResourceName }> = [
    { cmd: "dashboard", resource: "dashboards" },
    { cmd: "connection", resource: "datasources" },
    { cmd: "folder", resource: "folders" },
    { cmd: "alert-rule", resource: "alert-rules" },
    { cmd: "contact-point", resource: "contact-points" },
    { cmd: "policy", resource: "policies" },
  ];

  for (const entry of scopedResources) {
    const scoped = program.command(entry.cmd).description(`Resource scoped operations for ${entry.cmd}`);
    scoped
      .command("delete <idOrUid>")
      .description(`Delete ${entry.cmd} by id or uid`)
      .option("--json", "print selected resource json")
      .action(async function scopedDeleteAction(idOrUid: string, options) {
        const ctx = parseCommonOptions(this as unknown as Command);
        const selector = parseIdOrUidSelector(idOrUid);
        const selected = await deleteSingleResource(ctx, entry.resource, selector);
        if (options.json || ctx.dryRun) {
          console.log(JSON.stringify(selected, null, 2));
        }
        printMessage(ctx, `Deleted ${entry.resource}.`);
        if (ctx.dryRun) printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
      });
  }

  await program.parseAsync(process.argv);
}
