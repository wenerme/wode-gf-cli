import fs from "node:fs";
import path from "node:path";
import type { JsonObject } from "../core/json";
import { attachSourceFile, sourceFileOf } from "../core/source-file";
import { isDashboardResourceV2 } from "../dashboard/model";
import { asObject, asString } from "../lib/json-narrow";
import type { ExportBundle, ResourceName } from "../schema";
import {
  appendEntry,
  createEmptyBundle,
  inferResourceFromObject,
  keyFor,
  mergeBundle,
  resourceFromType,
} from "./model";

function resourceFromFilePath(filePath: string): ResourceName | undefined {
  const directory = path.basename(path.dirname(filePath)).toLowerCase();
  if (directory === "dashboard" || directory === "dashboard-v2") return "dashboards";
  if (directory === "connection") return "datasources";
  if (directory === "folder") return "folders";
  if (directory === "alert-rule") return "alert-rules";
  if (directory === "contact-point") return "contact-points";
  if (directory === "policy") return "policies";
  return undefined;
}

function loadJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function metadataForJsonFile(filePath: string): JsonObject | undefined {
  const parsed = path.parse(filePath);
  const metaFile = path.join(parsed.dir, `${parsed.name}.meta.json`);
  if (!fs.existsSync(metaFile)) return undefined;
  const meta = asObject(loadJsonFile(metaFile));
  return meta?.__type === "dashboard-meta" ? meta : undefined;
}

function folderMetaForDir(directory: string): JsonObject | undefined {
  const file = path.join(directory, "_folder.json");
  return fs.existsSync(file) ? asObject(loadJsonFile(file)) : undefined;
}

function withDashboardMetadata(filePath: string, value: JsonObject): JsonObject {
  if (isDashboardResourceV2(value)) return value;
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
): void {
  const basename = path.basename(filePath);
  if (basename === "grafana.manifest.json" || basename.endsWith(".meta.json")) return;
  const fallback = forcedResource || resourceFromFilePath(filePath);

  if (Array.isArray(value)) {
    const typed = value as Array<Record<string, unknown>>;
    const fromType = resourceFromType(
      typeof typed[0]?.__type === "string" ? String(typed[0].__type) : undefined,
    );
    const inferred = typed[0] ? inferResourceFromObject(typed[0]) : undefined;
    const resource = fromType || fallback || inferred;
    if (resource)
      appendEntry(
        bundle,
        resource,
        typed.map((item) => attachSourceFile(item, filePath)),
      );
    return;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const byType = resourceFromType(typeof obj.__type === "string" ? String(obj.__type) : undefined);
    const resource = byType || fallback || inferResourceFromObject(obj);
    if (!resource) return;
    const item = resource === "dashboards" ? withDashboardMetadata(filePath, obj) : obj;
    appendEntry(bundle, resource, attachSourceFile(item, filePath));
  }
}

function loadImportTarget(targetPath: string, forcedResource?: ResourceName): ExportBundle {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) throw new Error(`Import target not found: ${resolved}`);

  if (fs.statSync(resolved).isFile()) {
    const bundle = createEmptyBundle();
    applyJsonFileToBundle(bundle, resolved, loadJsonFile(resolved), forcedResource);
    return bundle;
  }

  const bundle = createEmptyBundle();
  const queue = [resolved];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!stat.isFile() || !name.toLowerCase().endsWith(".json")) continue;
      if (
        name === "bundle.meta.json" ||
        name === "grafana.manifest.json" ||
        name === "_folder.json" ||
        name.endsWith(".meta.json")
      )
        continue;
      try {
        applyJsonFileToBundle(bundle, full, loadJsonFile(full), forcedResource);
      } catch {
        // Mixed source directories may contain unrelated invalid JSON.
      }
    }
  }
  return bundle;
}

function dedupeByKey(resource: ResourceName, items: unknown[] | undefined): unknown[] | undefined {
  if (!Array.isArray(items)) return items;
  const map = new Map<string, unknown>();
  for (const item of items) {
    const key = keyFor(resource, item);
    const previous = map.get(key);
    if (previous && resource === "dashboards") {
      const files = [sourceFileOf(previous), sourceFileOf(item)].filter(Boolean);
      const fileHint = files.length > 0 ? ` Files: ${files.join(", ")}` : "";
      throw new Error(`Duplicate dashboard key "${key}" in import sources.${fileHint}`);
    }
    map.set(key, item);
  }
  return Array.from(map.values());
}

function dedupeBundleEntries(bundle: ExportBundle): void {
  bundle.dashboards = dedupeByKey("dashboards", bundle.dashboards);
  bundle.datasources = dedupeByKey("datasources", bundle.datasources);
  bundle.folders = dedupeByKey("folders", bundle.folders);
  bundle["alert-rules"] = dedupeByKey("alert-rules", bundle["alert-rules"]);
  bundle["contact-points"] = dedupeByKey("contact-points", bundle["contact-points"]);
}

export function collectBundle(sources: string[], forcedResource?: ResourceName): ExportBundle {
  const merged = createEmptyBundle();
  for (const source of sources) mergeBundle(merged, loadImportTarget(source, forcedResource));
  dedupeBundleEntries(merged);
  return merged;
}
