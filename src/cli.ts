import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { GrafanaClient, mapLimit } from "./client";
import { createCommand } from "./command";
import { buildListAndRenderCommands } from "./commands/build-list-render";
import { buildMutateCommands } from "./commands/build-mutate";
import { buildPanelCommand } from "./commands/build-panel";
import { buildQueryCommand } from "./commands/build-query";
import { buildSyncCommands } from "./commands/build-sync";
import { buildValidateCommand } from "./commands/build-validate";
import type { CliRuntime, CommandAppContext } from "./commands/runtime";
import { calcClsInterval } from "./lib/cls-interval";
import { asObject, asObjectArray, asString, getObjectField } from "./lib/json-narrow";
import {
  extractTemplatingValues,
  findUnresolvedTemplateTokens,
  resolveDatasourceUid,
  resolveTemplateString,
  resolveTemplateValue,
  type TemplateVars,
} from "./lib/template-vars";
import { PromQLParseError, validatePromQLSyntax } from "./promql";
import {
  CliConfigSchema,
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
import {
  buildRenderPanelPath,
  msToInterval,
  parseRenderVar,
  parseSkipPanelIds,
  parseVarAssignments,
  resolveTimeToMs,
} from "./utils";

type JsonObject = Record<string, unknown>;
type MutableJson = Record<string, unknown> | unknown[];

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

function getConfigPath() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return path.resolve(".wode/wode-gf-cli.yaml");
  return path.join(home, ".wode", "wode-gf-cli.yaml");
}

function parseSimpleYamlConfig(content: string): {
  context: string;
  contexts: Array<Record<string, string>>;
} {
  const lines = content.split("\n");
  const contexts: Array<Record<string, string>> = [];
  let current: Record<string, string> | undefined;
  let activeContext = "default";
  let inContexts = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ").trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!rawLine.startsWith(" ") && trimmed.startsWith("context:")) {
      activeContext = trimmed.slice("context:".length).trim() || "default";
      inContexts = false;
      current = undefined;
      continue;
    }
    if (!rawLine.startsWith(" ") && trimmed === "contexts:") {
      inContexts = true;
      current = undefined;
      continue;
    }
    if (!inContexts) continue;

    if (trimmed.startsWith("- ")) {
      current = {};
      contexts.push(current);
      const rest = trimmed.slice(2).trim();
      if (rest) {
        const index = rest.indexOf(":");
        if (index > 0) current[rest.slice(0, index).trim()] = rest.slice(index + 1).trim();
      }
      continue;
    }

    if (!current) continue;
    const index = trimmed.indexOf(":");
    if (index <= 0) continue;
    current[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }

  return CliConfigSchema.parse({ context: activeContext, contexts });
}

function migrateLegacyConfig(content: string): string {
  return content.replace(/^profile:\s*/m, "context: ").replace(/^profiles:\s*$/m, "contexts:");
}

function readCliConfig() {
  const file = getConfigPath();
  try {
    const content = fs.readFileSync(file, "utf8");
    const migrated = migrateLegacyConfig(content);
    const parsed = parseSimpleYamlConfig(migrated);
    if (!parsed.contexts.some((ctx) => ctx.name === parsed.context)) {
      parsed.contexts.push({ name: parsed.context });
    }
    if (migrated !== content) {
      writeCliConfig(parsed);
    }
    return parsed;
  } catch {
    return CliConfigSchema.parse({ context: "default", contexts: [{ name: "default" }] });
  }
}

function serializeCliConfig(config: { context: string; contexts: Array<Record<string, string>> }) {
  const lines = [`context: ${config.context}`, "contexts:"];
  const seen = new Set<string>();
  for (const rawCtx of config.contexts) {
    const name = String(rawCtx.name || "default").trim() || "default";
    if (seen.has(name)) continue;
    seen.add(name);
    const ctx: Record<string, string> = { ...rawCtx, name };
    lines.push(`  - name: ${name}`);
    for (const [key, value] of Object.entries(ctx)) {
      if (key === "name") continue;
      if (value === undefined || value === "") continue;
      lines.push(`    ${key}: ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function contextAuthType(ctx: Record<string, string>) {
  const hasToken = Boolean(ctx.serviceAccountToken?.trim());
  const hasBasic = Boolean(ctx.username?.trim()) || Boolean(ctx.password?.trim());
  if (hasToken && hasBasic) return "token+basic";
  if (hasToken) return "token";
  if (hasBasic) return "basic";
  return "none";
}

function formatContextView(
  config: { context: string; contexts: Array<Record<string, string>> },
  name: string,
) {
  const context = config.contexts.find((ctx) => ctx.name === name) || { name };
  return {
    name,
    current: config.context === name,
    baseUrl: context.baseUrl || null,
    authType: contextAuthType(context),
    serviceAccountTokenConfigured: Boolean(context.serviceAccountToken?.trim()),
    username: context.username || null,
    passwordConfigured: Boolean(context.password?.trim()),
  };
}

function writeCliConfig(config: { context: string; contexts: Array<Record<string, string>> }) {
  const file = getConfigPath();
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, serializeCliConfig(config), "utf8");
}

function getNamedContext(name: string | undefined) {
  const config = readCliConfig();
  const selectedName = name || config.context || "default";
  const context = config.contexts.find((ctx) => ctx.name === selectedName);
  return { config, context: context || { name: selectedName } };
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

function dashboardFileName(item: JsonObject, used: Set<string>) {
  const dashboard = getObjectField(item, "dashboard") || item;
  const uid = asString(item.uid) || asString(dashboard.uid);
  const title = asString(item.title) || asString(dashboard.title) || uid || "dashboard";
  const base = uid ? safeName(uid) : safeName(title);
  return `${uniqueBaseName(base, used)}.json`;
}

function folderTitleByUid(bundle: ExportBundle) {
  const map = new Map<string, string>();
  for (const folder of asObjectArray(bundle.folders)) {
    const uid = asString(folder.uid);
    const title = asString(folder.title);
    if (uid && title) map.set(uid, title);
  }
  return map;
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
      context: bundle.context,
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
    const folderMap = folderTitleByUid(bundle);
    const usedByDir = new Map<string, Set<string>>();
    for (const item of asObjectArray(bundle.dashboards)) {
      const dashboard = getObjectField(item, "dashboard") || item;
      const folderUid = asString(item.folderUid);
      const folderTitle = folderUid ? folderMap.get(folderUid) || folderUid : undefined;
      const targetDir = folderUid ? path.join(dir, safeName(folderTitle || folderUid)) : dir;
      ensureDir(targetDir);
      if (folderUid) {
        writeJson(
          path.join(targetDir, "_folder.json"),
          { __type: "folder", uid: folderUid, title: folderTitle || folderUid },
          pretty,
        );
      }
      const used = usedByDir.get(targetDir) || new Set<string>();
      usedByDir.set(targetDir, used);
      const filename = dashboardFileName(item, used);
      const file = path.join(targetDir, filename);
      writeJson(file, dashboard, pretty);
      writeJson(
        path.join(targetDir, `${path.basename(filename, ".json")}.meta.json`),
        {
          __type: "dashboard-meta",
          uid: asString(item.uid) || asString(dashboard.uid),
          title: asString(item.title) || asString(dashboard.title),
          folderUid: folderUid || undefined,
        },
        pretty,
      );
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
  if (v === "dashboard" || v === "dashboards" || v === "dash" || v === "d") return "dashboards";
  if (v === "connection" || v === "connections" || v === "conn" || v === "datasource" || v === "datasources")
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
  if (value.__type === "dashboard-meta" || value.__type === "grafana-manifest") return undefined;
  if (value.dashboard && typeof value.dashboard === "object") return "dashboards";
  if (value.panels || value.schemaVersion !== undefined || value.templating || value.time)
    return "dashboards";
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

function loadJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function metadataForJsonFile(filePath: string): JsonObject | undefined {
  const parsed = path.parse(filePath);
  const metaFile = path.join(parsed.dir, `${parsed.name}.meta.json`);
  if (!fs.existsSync(metaFile)) return undefined;
  const meta = asObject(loadJsonFile(metaFile));
  if (meta?.__type !== "dashboard-meta") return undefined;
  return meta;
}

function folderMetaForDir(dir: string): JsonObject | undefined {
  const file = path.join(dir, "_folder.json");
  if (!fs.existsSync(file)) return undefined;
  return asObject(loadJsonFile(file));
}

function withDashboardMetadata(filePath: string, value: JsonObject): JsonObject {
  if (value.dashboard && typeof value.dashboard === "object") return value;
  const meta = metadataForJsonFile(filePath);
  const folderMeta = folderMetaForDir(path.dirname(filePath));
  const folderUid = asString(meta?.folderUid) || asString(folderMeta?.uid);
  return {
    __type: "dashboard",
    uid: asString(meta?.uid) || asString(value.uid),
    title: asString(meta?.title) || asString(value.title),
    folderUid: folderUid || undefined,
    dashboard: value,
  };
}

function applyJsonFileToBundle(
  bundle: ExportBundle,
  filePath: string,
  value: unknown,
  forcedResource?: ResourceName,
) {
  const basename = path.basename(filePath);
  if (basename === "grafana.manifest.json" || basename.endsWith(".meta.json")) return;

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
    appendEntry(bundle, resource, resource === "dashboards" ? withDashboardMetadata(filePath, obj) : obj);
  }
}

function loadImportTarget(targetPath: string, forcedResource?: ResourceName): ExportBundle {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Import target not found: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    const value = loadJsonFile(resolved);
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
      if (
        name === "bundle.meta.json" ||
        name === "grafana.manifest.json" ||
        name === "_folder.json" ||
        name.endsWith(".meta.json")
      )
        continue;
      try {
        const value = loadJsonFile(full);
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

type ValidateIssueBase = {
  dashboardTitle: string;
  panelTitle: string;
  panelId: number;
  refId: string;
  message: string;
  datasourceUid?: string;
  datasourceType?: string;
  kind?: "query-error" | "promql-syntax" | "no-data" | "skip";
};

type ValidateWarning = ValidateIssueBase;

type ValidateError = ValidateIssueBase;

type DashboardTarget = {
  refId: string;
  raw: JsonObject;
};

type QueryModeFlags = {
  resourceAlias: ResourceName | undefined;
  isDsKeyword: boolean;
  isQuickQueryMode: boolean;
};

function detectQueryMode(
  resourceArg: string,
  options: {
    sql?: string;
    expr?: string;
    queryJson?: string;
    queryFile?: string;
    query?: string[];
  },
): QueryModeFlags {
  const resourceAlias = parseResourceAlias(resourceArg);
  const isDsKeyword = resourceArg === "ds" || resourceArg === "datasource";
  const isQuickQueryMode =
    Boolean(
      options.sql || options.expr || options.queryJson || options.queryFile || (options.query || []).length,
    ) || isDsKeyword;
  return { resourceAlias, isDsKeyword, isQuickQueryMode };
}

function resolveQueryDatasourceIdentifier(
  resourceArg: string,
  options: { uid?: string },
  flags: QueryModeFlags,
): string {
  if (flags.resourceAlias && !flags.isDsKeyword && !options.uid) {
    throw new Error(`Resource '${resourceArg}' conflicts with datasource query mode; pass --uid explicitly`);
  }

  let datasourceIdentifier = String(options.uid || "").trim();
  if (!datasourceIdentifier && !flags.isDsKeyword && !flags.resourceAlias) {
    datasourceIdentifier = resourceArg;
  }
  if (!datasourceIdentifier) {
    throw new Error("query datasource requires identifier: use query <uid|name> --sql ... or --uid ...");
  }
  return datasourceIdentifier;
}

function normalizeRenderTarget(target: string): "panel" | "dashboard" {
  const normalized = String(target || "")
    .trim()
    .toLowerCase();
  if (normalized === "panel" || normalized === "dashboard") return normalized;
  throw new Error(`Unsupported render target: ${target}. Use panel|dashboard`);
}

function parseQueryAssignment(expr: string): { path: string; value: unknown } {
  const index = expr.indexOf("=");
  if (index <= 0) {
    throw new Error(`Invalid --query expression: ${expr}. Expect path=value`);
  }
  const pathExpr = expr.slice(0, index).trim();
  const rawValue = expr.slice(index + 1);
  if (!pathExpr) {
    throw new Error(`Invalid --query expression: ${expr}. Missing path`);
  }
  return { path: pathExpr, value: parseJsonLike(rawValue) };
}

function parseJsonObjectOrThrow(input: string, sourceLabel: string): JsonObject {
  const value = parseJsonLike(input);
  const obj = asObject(value);
  if (!obj) throw new Error(`${sourceLabel} must be a JSON object`);
  return obj;
}

type ResolvedDatasource = {
  uid: string;
  name?: string;
  type?: string;
  jsonData?: JsonObject;
};

async function resolveDatasourceByIdentifier(
  client: GrafanaClient,
  identifier: string,
  vars: TemplateVars,
): Promise<ResolvedDatasource> {
  const resolved = resolveTemplateString(identifier.trim(), vars);
  if (!resolved) throw new Error("Datasource identifier is empty");
  const datasources = asObjectArray(await client.request<unknown[]>("GET", "/api/datasources"));
  const matched = datasources.find((ds) => asString(ds.uid) === resolved || asString(ds.name) === resolved);
  if (!matched) {
    throw new Error(`Datasource not found by uid/name: ${resolved}`);
  }
  const uid = asString(matched.uid);
  if (!uid) throw new Error(`Datasource has no uid: ${resolved}`);
  return {
    uid,
    name: asString(matched.name),
    type: asString(matched.type),
    jsonData: getObjectField(matched, "jsonData"),
  };
}

function dashboardTitleOf(item: JsonObject): string {
  const title = asString(item.title);
  const dashboard = getObjectField(item, "dashboard");
  return title || asString(dashboard?.title) || asString(item.uid) || "(untitled dashboard)";
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function renderTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return "";
  const widths = headers.map((h, i) => {
    const rowMax = rows.reduce((max, row) => Math.max(max, (row[i] || "").length), 0);
    return Math.max(h.length, rowMax);
  });

  const line = headers.map((h, i) => h.padEnd(widths[i] || h.length)).join(" | ");
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  const body = rows.map((row) =>
    row.map((cell, i) => (cell || "").padEnd(widths[i] || cell.length)).join(" | "),
  );
  return [line, sep, ...body].join("\n");
}

function renderFramesText(data: unknown, refId: string): string | undefined {
  const body = asObject(data);
  const results = body ? getObjectField(body, "results") : undefined;
  const result = results ? getObjectField(results, refId) : undefined;
  const frames = result ? asObjectArray(result.frames) : [];
  if (frames.length === 0) return undefined;

  const blocks: string[] = [];
  for (const frame of frames) {
    const schema = getObjectField(frame, "schema");
    const fields = schema ? asObjectArray(schema.fields) : [];
    let headers = fields.map((field, index) => asString(field.name) || `col_${index + 1}`);
    const dataObject = getObjectField(frame, "data");
    const columns = Array.isArray(dataObject?.values) ? (dataObject.values as unknown[]) : [];
    const arrayColumns = columns.filter((col): col is unknown[] => Array.isArray(col));
    if (headers.length === 0 && columns.length > 0) {
      headers = Array.from({ length: columns.length }, (_, i) => `col_${i + 1}`);
    }
    const rowCount = arrayColumns.reduce((max, col) => Math.max(max, col.length), 0);

    const rows: string[][] = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row: string[] = [];
      for (let colIndex = 0; colIndex < headers.length; colIndex += 1) {
        const col = columns[colIndex];
        const value = Array.isArray(col) ? col[rowIndex] : undefined;
        row.push(formatCell(value));
      }
      rows.push(row);
    }

    blocks.push(renderTable(headers, rows));
  }
  return blocks.filter(Boolean).join("\n\n");
}

type ListRow = {
  uid: string;
  label: string;
  folder?: string;
  raw: JsonObject;
};

function rowsToTable(rows: ListRow[]): string {
  const headers = ["uid", "title / name", "folder"];
  const body = rows.map((row) => [row.uid, row.label, row.folder || ""]);
  return renderTable(headers, body);
}

function extractPanelTargets(panel: JsonObject): DashboardTarget[] {
  const targets = asObjectArray(panel.targets);
  return targets.map((target, index) => ({
    refId: asString(target.refId) || String.fromCharCode(65 + index),
    raw: target,
  }));
}

function collectPanels(input: unknown): JsonObject[] {
  const panels: JsonObject[] = [];
  for (const panel of asObjectArray(input)) {
    panels.push(panel);
    panels.push(...collectPanels(panel.panels));
  }
  return panels;
}

function collectDashboards(bundle: ExportBundle): JsonObject[] {
  return asObjectArray(bundle.dashboards)
    .map((entry) => {
      const dashboard = getObjectField(entry, "dashboard") || entry;
      const title = asString(entry.title) || asString(dashboard.title);
      const uid = asString(entry.uid) || asString(dashboard.uid);
      return {
        ...entry,
        title,
        uid,
        dashboard,
      } as JsonObject;
    })
    .filter((v): v is JsonObject => Boolean(v));
}

function isPrometheusDatasourceType(value: string | undefined) {
  return String(value || "").toLowerCase() === "prometheus";
}

function promQLSyntaxIssue(
  dashboardTitle: string,
  panel: JsonObject,
  target: DashboardTarget,
  message: string,
  datasourceUid?: string,
  datasourceType?: string,
): ValidateError {
  return {
    dashboardTitle,
    panelTitle: asString(panel.title) || "(untitled panel)",
    panelId: Number.parseInt(String(panel.id || "0"), 10) || 0,
    refId: target.refId,
    datasourceUid,
    datasourceType,
    kind: "promql-syntax",
    message,
  };
}

function validatePanelTargetPromQLSyntax(
  dashboardTitle: string,
  panel: JsonObject,
  target: DashboardTarget,
  datasourceUid?: string,
  datasourceType?: string,
): ValidateError | undefined {
  const expr = asString(target.raw.expr);
  if (!expr) return undefined;
  try {
    validatePromQLSyntax(expr);
    return undefined;
  } catch (error) {
    const message = error instanceof PromQLParseError ? error.message : String(error);
    return promQLSyntaxIssue(dashboardTitle, panel, target, message, datasourceUid, datasourceType);
  }
}

function validateDashboardPromQLSyntax(dashboards: JsonObject[]): ValidateIssueBase[] {
  const errors: ValidateIssueBase[] = [];
  for (const dashboardEntry of dashboards) {
    const dashboard = getObjectField(dashboardEntry, "dashboard") || dashboardEntry;
    const dashboardTitle = dashboardTitleOf(dashboardEntry);
    for (const panel of collectPanels(dashboard.panels)) {
      for (const target of extractPanelTargets(panel)) {
        const issue = validatePanelTargetPromQLSyntax(dashboardTitle, panel, target, undefined, "prometheus");
        if (issue) errors.push(issue);
      }
    }
  }
  return errors;
}

async function validateDashboards(
  ctx: RuntimeContext,
  dashboards: JsonObject[],
  options: {
    from: string;
    to: string;
    timeoutMs: number;
    intervalMs: number;
    concurrency: number;
    failFast: boolean;
    syntaxOnly?: boolean;
    skipPanelIds: number[];
    onlyPanelIds?: number[];
    vars: Record<string, string>;
  },
) {
  const warnings: ValidateWarning[] = [];
  const errors: ValidateError[] = [];
  const client = new GrafanaClient({ ...ctx, timeoutMs: options.timeoutMs });
  const skipSet = new Set(options.skipPanelIds);
  const onlySet = new Set(options.onlyPanelIds || []);
  const onlyDatasourceTypes = new Set(options.datasourceTypes || []);
  const skipDatasourceTypes = new Set(options.skipTypes || []);
  const nowMs = Date.now();
  const fromMs = resolveTimeToMs(options.from, nowMs);
  const toMs = resolveTimeToMs(options.to, nowMs);
  const rangeMs = Math.max(0, toMs - fromMs);
  const rangeS = Math.round(rangeMs / 1000);
  const datasourceTypeByUid = new Map<string, string>();
  if (onlyDatasourceTypes.size > 0 || skipDatasourceTypes.size > 0) {
    for (const datasource of asObjectArray(await client.request<unknown[]>("GET", "/api/datasources"))) {
      const uid = asString(datasource.uid);
      const type = asString(datasource.type);
      if (uid && type) datasourceTypeByUid.set(uid, type);
    }
  }

  for (const dashboardEntry of dashboards) {
    const dashboard = getObjectField(dashboardEntry, "dashboard");
    if (!dashboard) continue;
    const dashboardTitle = dashboardTitleOf(dashboardEntry);
    const dashboardVars = {
      ...extractTemplatingValues(dashboard),
      ...options.vars,
      __from: String(fromMs),
      __to: String(toMs),
      __timeFrom: `to_timestamp(${fromMs / 1000})`,
      __timeTo: `to_timestamp(${toMs / 1000})`,
      __timeFilter: `"time" BETWEEN to_timestamp(${fromMs / 1000}) AND to_timestamp(${toMs / 1000})`,
      __interval_ms: String(options.intervalMs),
      __interval: msToInterval(options.intervalMs),
      __cls_interval: calcClsInterval(fromMs, toMs),
      __rate_interval: msToInterval(Math.max(options.intervalMs * 4, 240_000)),
      __range: `${rangeS}s`,
      __range_ms: String(rangeMs),
      __range_s: String(rangeS),
      __all: "ALL",
      __user_login: "",
      __org_name: "",
    };

    const panels = collectPanels(dashboard.panels);
    const tasks: Array<{ panel: JsonObject; target: DashboardTarget }> = [];
    for (const panel of panels) {
      for (const target of extractPanelTargets(panel)) {
        tasks.push({ panel, target });
      }
    }

    await mapLimit(tasks, options.concurrency, async ({ panel, target }) => {
      const panelId = Number.parseInt(String(panel.id || "0"), 10) || 0;
      if (onlySet.size > 0 && !onlySet.has(panelId)) return;
      if (skipSet.has(panelId)) return;

      const panelDatasource = getObjectField(panel, "datasource");
      const targetDatasource = getObjectField(target.raw, "datasource");
      const datasourceUid = resolveDatasourceUid(
        asString(panelDatasource?.uid),
        asString(targetDatasource?.uid),
        dashboardVars,
      );

      const targetDatasourceType = asString(targetDatasource?.type) || asString(panelDatasource?.type);
      const datasourceType = datasourceUid
        ? datasourceTypeByUid.get(datasourceUid) || targetDatasourceType
        : targetDatasourceType;
      if (datasourceType && onlyDatasourceTypes.size > 0 && !onlyDatasourceTypes.has(datasourceType)) return;
      if (datasourceType && skipDatasourceTypes.has(datasourceType)) return;

      const expr = asString(target.raw.expr);
      if (isPrometheusDatasourceType(datasourceType)) {
        const syntaxIssue = validatePanelTargetPromQLSyntax(
          dashboardTitle,
          panel,
          target,
          datasourceUid,
          datasourceType,
        );
        if (syntaxIssue) {
          errors.push(syntaxIssue);
          if (options.failFast) {
            throw new Error(
              `PromQL syntax validation failed at ${dashboardTitle} / ${String(panel.title || panelId)} / ${target.refId}`,
            );
          }
          return;
        }
      }
      if (options.syntaxOnly) return;

      if (!datasourceUid) {
        warnings.push({
          dashboardTitle,
          panelTitle: asString(panel.title) || "(untitled panel)",
          panelId,
          refId: target.refId,
          message: "Skip target: datasource uid unresolved",
          kind: "skip",
        });
        return;
      }

      const rawSql = asString(target.raw.rawSql) || asString(target.raw.rawQuery);
      if (!rawSql && !expr) return;

      const maxDataPoints = Number.parseInt(String(target.raw.maxDataPoints || "1000"), 10) || 1000;
      const queryVars = {
        ...dashboardVars,
        __cls_interval: calcClsInterval(fromMs, toMs, maxDataPoints),
      };
      const queryBody = resolveTemplateValue(
        {
          refId: target.refId,
          datasource: { uid: datasourceUid },
          rawSql,
          rawQuery: rawSql,
          expr,
          format: asString(target.raw.format) || "table",
          intervalMs: options.intervalMs,
          maxDataPoints,
        },
        queryVars,
      ) as JsonObject;
      const unresolvedTokens = findUnresolvedTemplateTokens(queryBody);
      if (unresolvedTokens.length > 0) {
        warnings.push({
          dashboardTitle,
          panelTitle: asString(panel.title) || "(untitled panel)",
          panelId,
          refId: target.refId,
          datasourceUid,
          datasourceType,
          kind: "skip",
          message: `unresolved template tokens: ${unresolvedTokens.join(", ")}`,
        });
      }

      const payload = {
        from: String(fromMs),
        to: String(toMs),
        queries: [queryBody],
      };

      const response = await client.requestWithStatus<JsonObject>("POST", "/api/ds/query", payload);
      const data = asObject(response.data);
      const results = data ? getObjectField(data, "results") : undefined;
      const result = results ? getObjectField(results, target.refId) : undefined;
      const error = result
        ? asString(result.error) || asString(result.errorMessage) || asString(result.message)
        : undefined;
      if (error) {
        errors.push({
          dashboardTitle,
          panelTitle: asString(panel.title) || "(untitled panel)",
          panelId,
          refId: target.refId,
          datasourceUid,
          datasourceType,
          kind: "query-error",
          message: error,
        });
        if (options.failFast) {
          throw new Error(
            `Validation failed at ${dashboardTitle} / ${String(panel.title || panelId)} / ${target.refId}`,
          );
        }
        return;
      }

      if (response.status !== 200) {
        const message =
          error || (typeof response.data === "string" ? response.data : JSON.stringify(response.data));
        errors.push({
          dashboardTitle,
          panelTitle: asString(panel.title) || "(untitled panel)",
          panelId,
          refId: target.refId,
          datasourceUid,
          datasourceType,
          kind: "query-error",
          message: `HTTP ${response.status}: ${message}`,
        });
        return;
      }

      if (!renderFramesText(response.data, target.refId)) {
        warnings.push({
          dashboardTitle,
          panelTitle: asString(panel.title) || "(untitled panel)",
          panelId,
          refId: target.refId,
          datasourceUid,
          datasourceType,
          kind: "no-data",
          message: "no data returned",
        });
      }
    });
  }

  return { errors, warnings };
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
    context?: string;
    url?: string;
    serviceAccountToken?: string;
    username?: string;
    password?: string;
    timeout?: string;
    dryRun?: boolean;
    debug?: boolean;
    output?: string;
    quiet?: boolean;
  };

  const contextName =
    options.context?.trim() || options.name?.trim() || envValue(["WODE_GF_CLI_CONTEXT", "WODE_GF_CLI_NAME"]);
  if (options.name?.trim()) {
    console.warn("[WARN] --name is deprecated; prefer --context");
  }
  if (!options.context?.trim() && !options.name?.trim() && process.env.WODE_GF_CLI_NAME?.trim()) {
    console.warn("[WARN] WODE_GF_CLI_NAME is deprecated; prefer WODE_GF_CLI_CONTEXT");
  }
  const prefix = contextName ? normalizePrefix(contextName) : undefined;
  const { context } = getNamedContext(contextName);

  const url =
    options.url ||
    context.baseUrl ||
    envValue(
      [
        prefix ? `${prefix}_GRAFANA_URL` : "",
        contextName ? `${contextName}_GRAFANA_URL` : "",
        "GRAFANA_URL",
      ].filter(Boolean),
    );

  const apiKey =
    options.serviceAccountToken ||
    context.serviceAccountToken ||
    envValue(
      [
        prefix ? `${prefix}_GRAFANA_SERVICE_ACCOUNT_TOKEN` : "",
        contextName ? `${contextName}_GRAFANA_SERVICE_ACCOUNT_TOKEN` : "",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN",
      ].filter(Boolean),
    );

  const username =
    options.username ||
    context.username ||
    envValue(
      [
        prefix ? `${prefix}_GRAFANA_USERNAME` : "",
        contextName ? `${contextName}_GRAFANA_USERNAME` : "",
        "GRAFANA_USERNAME",
      ].filter(Boolean),
    );
  const password =
    options.password ||
    context.password ||
    envValue(
      [
        prefix ? `${prefix}_GRAFANA_PASSWORD` : "",
        contextName ? `${contextName}_GRAFANA_PASSWORD` : "",
        "GRAFANA_PASSWORD",
      ].filter(Boolean),
    );

  const requireUrl = cfg?.requireUrl !== false;
  if (requireUrl && !url) {
    throw new Error("Missing Grafana URL. Set config/env/--url before running Grafana commands");
  }

  const timeoutMs = Math.max(1000, Number.parseInt(options.timeout || "20000", 10) || 20000);

  const output: OutputFormat = options.output === "json" ? "json" : "text";

  const parsed = GrafanaCliContextSchema.parse({
    contextName,
    url: url || "",
    apiKey,
    username,
    password,
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

async function importResources(
  ctx: RuntimeContext,
  bundle: ExportBundle,
  resources: ResourceName[],
  options: { overwrite?: boolean } = {},
) {
  const overwrite = options.overwrite !== false;
  const client = new GrafanaClient(ctx);

  const has = (resource: ResourceName) => resources.includes(resource);

  if (has("folders") && Array.isArray(bundle.folders)) {
    printData(ctx, "import-folders-start", {
      count: bundle.folders.length,
      message: `Import folders: ${bundle.folders.length}`,
    });
    for (const folder of asObjectArray(bundle.folders)) {
      const folderUid = asString(folder.uid);
      const folderTitle = asString(folder.title);
      if (!folderUid || !folderTitle) continue;
      const body = {
        uid: folderUid,
        title: folderTitle,
      };
      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "folders",
          action: "upsert",
          uid: folderUid,
          message: `[DRY-RUN] folder upsert ${folderUid}`,
        });
      } else {
        try {
          await client.request("PUT", `/api/folders/${encodeURIComponent(folderUid)}`, body, [200]);
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
      const source = asObject(stripMeta(raw));
      if (!source) continue;
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

      const existingUid = existingDs ? asString(existingDs.uid) : undefined;
      if (existingUid) {
        await client.request(
          "PUT",
          `/api/datasources/uid/${encodeURIComponent(existingUid)}`,
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
      const cleanItem = asObject(stripMeta(item));
      if (!cleanItem) continue;
      const dashboard = getObjectField(cleanItem, "dashboard") || cleanItem;
      const dashboardUid = asString(dashboard.uid);
      const dashboardTitle = asString(dashboard.title);
      if (!dashboardUid && !dashboardTitle) continue;

      const cleaned = removeKeys(dashboard, ["id"]);
      const body = {
        dashboard: { ...cleaned, id: null },
        folderUid: asString(cleanItem.folderUid) || undefined,
        overwrite,
        message: `imported by ${CliName}`,
      };

      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "dashboards",
          action: "upsert",
          key: dashboardUid || dashboardTitle || "(unknown)",
          message: `[DRY-RUN] dashboard upsert ${dashboardUid || dashboardTitle || "(unknown)"}`,
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
      const cleanRule = asObject(stripMeta(rule));
      if (!cleanRule) continue;
      const ruleUid = asString(cleanRule.uid);
      const ruleTitle = asString(cleanRule.title);
      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "alert-rules",
          action: "upsert",
          key: ruleUid || ruleTitle || "(unknown)",
          message: `[DRY-RUN] alert-rule upsert ${ruleUid || ruleTitle || "(unknown)"}`,
        });
        continue;
      }
      if (ruleUid) {
        try {
          await client.request(
            "PUT",
            `/api/v1/provisioning/alert-rules/${encodeURIComponent(ruleUid)}`,
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
      const cleanCp = asObject(stripMeta(cp));
      if (!cleanCp) continue;
      const cpUid = asString(cleanCp.uid);
      const cpName = asString(cleanCp.name);
      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "contact-points",
          action: "upsert",
          key: cpUid || cpName || "(unknown)",
          message: `[DRY-RUN] contact-point upsert ${cpUid || cpName || "(unknown)"}`,
        });
        continue;
      }
      if (cpUid) {
        try {
          await client.request(
            "PUT",
            `/api/v1/provisioning/contact-points/${encodeURIComponent(cpUid)}`,
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

  const { program, collectList } = createCommand(CliName);
  const runtime: CliRuntime = {
    parseCommonOptions,
    getConfigPath,
    readCliConfig,
    parseResources,
    parseResourceAlias,
    dedupeResources,
    collectBundle,
    fetchResources,
    bundleToFiles,
    importResources,
    resourceItems,
    selectResource,
    getPathValue,
    valueEqual,
    hashObject,
    diffArray,
    printMessage,
    printData,
    rowsToTable,
    renderTable,
    normalizeRenderTarget,
    ensureDir,
    detectQueryMode,
    resolveQueryDatasourceIdentifier,
    resolveDatasourceByIdentifier,
    parseJsonObjectOrThrow,
    parseQueryAssignment,
    setPathValue,
    renderFramesText,
    collectDashboards,
    validateDashboards,
    validateDashboardPromQLSyntax,
    parseJsonLike,
    deepMerge,
    parseSetExpr,
    createEmptyBundle,
    setSingleResource,
    writeJson,
    deleteSingleResource,
    parseIdOrUidSelector,
  };
  const app: CommandAppContext = { collectList, runtime };

  const contextCommand = new Command("context").description("show and manage named contexts");
  contextCommand
    .command("list")
    .description("List contexts")
    .option("--json", "print contexts as json")
    .action(function contextListAction(options) {
      const config = readCliConfig();
      const contexts = config.contexts.map((ctx) => ({
        current: ctx.name === config.context,
        name: ctx.name || "default",
        baseUrl: ctx.baseUrl || null,
        authType: contextAuthType(ctx),
      }));
      if (options.json) {
        console.log(JSON.stringify({ context: config.context, contexts }, null, 2));
        return;
      }
      const rows = contexts.map((ctx) => [ctx.current ? "*" : "", ctx.name, ctx.baseUrl || "", ctx.authType]);
      console.log(renderTable(["*", "name", "baseUrl", "auth"], rows));
    });
  contextCommand
    .command("current")
    .description("Show current context")
    .option("--json", "print current context as json")
    .action(function contextCurrentAction(options) {
      const config = readCliConfig();
      const view = formatContextView(config, config.context || "default");
      if (options.json) {
        console.log(JSON.stringify(view, null, 2));
        return;
      }
      console.log(
        [
          `Name: ${view.name}`,
          `Current: ${view.current ? "yes" : "no"}`,
          `Base URL: ${view.baseUrl || "<none>"}`,
          `Auth Type: ${view.authType}`,
          `Service Account Token: ${view.serviceAccountTokenConfigured ? "<configured>" : "<none>"}`,
          `Username: ${view.username || "<none>"}`,
          `Password: ${view.passwordConfigured ? "<configured>" : "<none>"}`,
        ].join("\n"),
      );
    });
  contextCommand
    .command("use <NAME>")
    .description("Switch current context")
    .action(function contextUseAction(name: string) {
      const config = readCliConfig();
      if (!config.contexts.some((ctx) => ctx.name === name)) {
        config.contexts.push({ name });
      }
      config.context = name;
      writeCliConfig(config);
      console.log(`Using context ${name}`);
    });
  contextCommand
    .command("set <EXPR>")
    .description("Set context field, e.g. baseUrl=http://127.0.0.1:3300")
    .option("--context <NAME>", "target context name")
    .action(function contextSetAction(expr: string, options) {
      const index = expr.indexOf("=");
      if (index <= 0) throw new Error("Invalid context set expression, expect KEY=VALUE");
      const key = expr.slice(0, index).trim();
      const value = expr.slice(index + 1);
      const config = readCliConfig();
      const globalOptions = (this as unknown as Command).optsWithGlobals() as { context?: string };
      const requestedName = String(
        options.context || globalOptions.context || config.context || "default",
      ).trim();
      const name = requestedName || "default";
      let ctx = config.contexts.find((item) => item.name === name);
      if (!ctx) {
        ctx = { name };
        config.contexts.push(ctx);
      }
      ctx[key] = value;
      writeCliConfig(config);
      console.log(`Updated context ${name}: ${key}`);
    });

  const authCommand = new Command("auth").description("manage Grafana authentication");
  authCommand
    .command("login")
    .description("Store auth credentials into a context")
    .option("-c, --context <NAME>", "context name")
    .option("--url <url>", "Grafana URL")
    .option("--username <username>", "Grafana username")
    .option("--password <password>", "Grafana password")
    .option("--service-account-token <token>", "Grafana service account token")
    .action(function authLoginAction(options) {
      const config = readCliConfig();
      const mergedOptions = (this as unknown as Command).optsWithGlobals() as {
        context?: string;
        url?: string;
        username?: string;
        password?: string;
        serviceAccountToken?: string;
      };
      const requestedName = String(
        options.context || mergedOptions.context || config.context || "default",
      ).trim();
      const name = requestedName || "default";
      let ctx = config.contexts.find((item) => item.name === name);
      if (!ctx) {
        ctx = { name };
        config.contexts.push(ctx);
      }
      const url = options.url ?? mergedOptions.url;
      const username = options.username ?? mergedOptions.username;
      const password = options.password ?? mergedOptions.password;
      const token = options.serviceAccountToken ?? mergedOptions.serviceAccountToken;

      if (url) ctx.baseUrl = String(url).trim();
      if (username) ctx.username = String(username).trim();
      if (password !== undefined) ctx.password = String(password);
      if (token !== undefined) {
        ctx.serviceAccountToken = String(token).trim();
      }
      config.context = name;
      writeCliConfig(config);
      console.log(`Saved auth context ${name}`);
    });
  authCommand
    .command("whoami")
    .description("Show current Grafana identity")
    .option("--json", "print json")
    .action(async function authWhoamiAction(options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const client = new GrafanaClient(ctx);
      const me = await client.request<unknown>("GET", "/api/user", undefined, [200]);
      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify(me, null, 2));
        return;
      }
      console.log(JSON.stringify(me, null, 2));
    });

  program.addCommand(contextCommand);
  program.addCommand(authCommand);

  for (const command of buildSyncCommands(app)) {
    program.addCommand(command);
  }

  program.addCommand(buildValidateCommand(app));

  for (const command of buildListAndRenderCommands(app)) {
    program.addCommand(command);
  }

  program.addCommand(buildQueryCommand(app));
  program.addCommand(buildPanelCommand(app));

  for (const command of buildMutateCommands(app)) {
    program.addCommand(command);
  }

  await program.parseAsync(process.argv);
}

export const __test__ = {
  parseEnvFile,
  migrateLegacyConfig,
  parseSimpleYamlConfig,
  parseResources,
  parseResourceAlias,
  resourceFromType,
  inferResourceFromObject,
  parseWhereExpr,
  parseSetExpr,
  parseRenderVar,
  buildRenderPanelPath,
  parseSkipPanelIds,
  parseVarAssignments,
  parseQueryAssignment,
  detectQueryMode,
  resolveQueryDatasourceIdentifier,
  normalizeRenderTarget,
  resolveTimeToMs,
  msToInterval,
  extractTemplatingValues,
  findUnresolvedTemplateTokens,
  resolveTemplateString,
  resolveDatasourceUid,
  pathSegments,
  getPathValue,
  setPathValue,
  deepMerge,
  validateDashboardPromQLSyntax,
  writeJson,
};
