import { addType, hashObject, type JsonObject } from "../core/json";
import { getPathValue, parseWhereExpr, valueEqual } from "../core/json-values";
import {
  dashboardResourceV2Name,
  dashboardResourceV2Title,
  isDashboardResourceV2,
  sanitizeDashboardResourceV2,
} from "../dashboard/model";
import { asObject, getObjectField } from "../lib/json-narrow";
import {
  DefaultResources,
  type DiffItem,
  type ExportBundle,
  type ResourceName,
  type ResourceSelector,
} from "../schema";

export function createEmptyBundle(): ExportBundle {
  return {
    generatedAt: new Date().toISOString(),
    url: "",
    resources: [...DefaultResources],
  };
}

export function parseResources(value?: string): ResourceName[] {
  if (!value) return [...DefaultResources];
  const list = value
    .split(",")
    .map((item) => item.trim())
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

export function dedupeResources(resources: ResourceName[]): ResourceName[] {
  return Array.from(new Set(resources));
}

export function resourceFromType(type: string | undefined): ResourceName | undefined {
  switch (type) {
    case "dashboard":
    case "dashboard-v2":
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

export function parseResourceAlias(value: string | undefined): ResourceName | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["dashboard", "dashboards", "dash", "d"].includes(normalized)) return "dashboards";
  if (["connection", "connections", "conn", "datasource", "datasources"].includes(normalized))
    return "datasources";
  if (normalized === "folder" || normalized === "folders") return "folders";
  if (["alert-rule", "alert-rules", "alertrule", "alertrules"].includes(normalized)) return "alert-rules";
  if (["contact-point", "contact-points", "contactpoint", "contactpoints"].includes(normalized))
    return "contact-points";
  if (normalized === "policy" || normalized === "policies") return "policies";
  return undefined;
}

export function inferResourceFromObject(value: JsonObject): ResourceName | undefined {
  if (value.__type === "dashboard-meta" || value.__type === "grafana-manifest") return undefined;
  if (isDashboardResourceV2(value)) return "dashboards";
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

export function appendEntry(bundle: ExportBundle, resource: ResourceName, value: unknown): void {
  if (resource === "policies") {
    bundle.policies = value;
    return;
  }
  const values = Array.isArray(value) ? value : [value];
  if (resource === "dashboards") bundle.dashboards = [...(bundle.dashboards || []), ...values];
  if (resource === "datasources") bundle.datasources = [...(bundle.datasources || []), ...values];
  if (resource === "folders") bundle.folders = [...(bundle.folders || []), ...values];
  if (resource === "alert-rules") bundle["alert-rules"] = [...(bundle["alert-rules"] || []), ...values];
  if (resource === "contact-points")
    bundle["contact-points"] = [...(bundle["contact-points"] || []), ...values];
}

export function mergeBundle(target: ExportBundle, source: ExportBundle): void {
  if (source.folders) appendEntry(target, "folders", source.folders);
  if (source.dashboards) appendEntry(target, "dashboards", source.dashboards);
  if (source.datasources) appendEntry(target, "datasources", source.datasources);
  if (source["alert-rules"]) appendEntry(target, "alert-rules", source["alert-rules"]);
  if (source["contact-points"]) appendEntry(target, "contact-points", source["contact-points"]);
  if (source.policies !== undefined) appendEntry(target, "policies", source.policies);
}

export function resourceItems(bundle: ExportBundle, resource: ResourceName): unknown[] {
  if (resource === "policies") return bundle.policies === undefined ? [] : [bundle.policies];
  if (resource === "dashboards") return Array.isArray(bundle.dashboards) ? bundle.dashboards : [];
  if (resource === "datasources") return Array.isArray(bundle.datasources) ? bundle.datasources : [];
  if (resource === "folders") return Array.isArray(bundle.folders) ? bundle.folders : [];
  if (resource === "alert-rules") return Array.isArray(bundle["alert-rules"]) ? bundle["alert-rules"] : [];
  if (resource === "contact-points")
    return Array.isArray(bundle["contact-points"]) ? bundle["contact-points"] : [];
  return [];
}

export function setSingleResource(bundle: ExportBundle, resource: ResourceName, item: unknown): void {
  if (resource === "policies") bundle.policies = item;
  else if (resource === "dashboards") bundle.dashboards = [item];
  else if (resource === "datasources") bundle.datasources = [item];
  else if (resource === "folders") bundle.folders = [item];
  else if (resource === "alert-rules") bundle["alert-rules"] = [item];
  else if (resource === "contact-points") bundle["contact-points"] = [item];
}

export function keyFor(resource: ResourceName, item: unknown): string {
  const obj = asObject(item);
  const dashboard = obj ? getObjectField(obj, "dashboard") : undefined;
  if (resource === "dashboards")
    return String(
      (obj && isDashboardResourceV2(obj) ? dashboardResourceV2Name(obj) : undefined) ||
        obj?.uid ||
        dashboard?.uid ||
        obj?.title ||
        hashObject(item),
    );
  if (resource === "datasources") return String(obj?.uid || obj?.name || hashObject(item));
  if (resource === "folders") return String(obj?.uid || obj?.title || hashObject(item));
  if (resource === "alert-rules") return String(obj?.title || obj?.name || obj?.uid || hashObject(item));
  if (resource === "contact-points") return String(obj?.uid || obj?.name || hashObject(item));
  return hashObject(item);
}

function canonicalDiffItem(resource: ResourceName, item: unknown): unknown {
  const object = asObject(item);
  if (resource === "dashboards" && object && isDashboardResourceV2(object)) {
    return addType(sanitizeDashboardResourceV2(object), "dashboard-v2");
  }
  return item;
}

export function diffArray(
  resource: ResourceName,
  localData: unknown[] = [],
  remoteData: unknown[] = [],
  options: { localOnly?: boolean } = {},
): DiffItem[] {
  const localMap = new Map<string, string>();
  const remoteMap = new Map<string, string>();
  for (const item of localData)
    localMap.set(keyFor(resource, item), hashObject(canonicalDiffItem(resource, item)));
  for (const item of remoteData)
    remoteMap.set(keyFor(resource, item), hashObject(canonicalDiffItem(resource, item)));

  const allKeys = new Set(options.localOnly ? localMap.keys() : [...localMap.keys(), ...remoteMap.keys()]);
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

export function selectedResourceChanged(
  resource: ResourceName,
  localItem: unknown,
  remoteItem: unknown,
  pathExpr?: string,
): boolean {
  if (localItem === undefined || remoteItem === undefined) return localItem !== remoteItem;
  if (pathExpr) return !valueEqual(getPathValue(localItem, pathExpr), getPathValue(remoteItem, pathExpr));
  return diffArray(resource, [localItem], [remoteItem]).length > 0;
}

export function selectResource(
  items: unknown[],
  resource: ResourceName,
  selector: ResourceSelector,
  allowMissing = false,
): unknown | undefined {
  let found = [...items];
  if (selector.id) {
    found = found.filter((item) => {
      const obj = asObject(item);
      const dashboard = obj ? getObjectField(obj, "dashboard") : undefined;
      return [obj?.id, dashboard?.id]
        .filter((value) => value !== undefined && value !== null)
        .some((value) => String(value) === selector.id);
    });
  }
  if (selector.uid) {
    found = found.filter((item) => {
      const obj = asObject(item);
      const dashboard = obj ? getObjectField(obj, "dashboard") : undefined;
      return (
        String(
          (obj && isDashboardResourceV2(obj) ? dashboardResourceV2Name(obj) : undefined) ||
            obj?.uid ||
            dashboard?.uid ||
            "",
        ) === selector.uid
      );
    });
  }
  if (selector.name) {
    found = found.filter((item) => {
      const obj = asObject(item);
      const name =
        (obj && isDashboardResourceV2(obj) ? dashboardResourceV2Name(obj) : undefined) || obj?.name;
      return String(name || "") === selector.name;
    });
  }
  if (selector.title) {
    found = found.filter((item) => {
      const obj = asObject(item);
      const dashboard = obj ? getObjectField(obj, "dashboard") : undefined;
      return (
        String(
          (obj && isDashboardResourceV2(obj) ? dashboardResourceV2Title(obj) : undefined) ||
            obj?.title ||
            dashboard?.title ||
            "",
        ) === selector.title
      );
    });
  }
  for (const whereExpr of selector.where) {
    const { path, value } = parseWhereExpr(whereExpr);
    found = found.filter((item) => valueEqual(getPathValue(item, path), value));
  }

  const hasSelector =
    Boolean(selector.id || selector.uid || selector.name || selector.title) || selector.where.length > 0;
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    if (allowMissing) return undefined;
    throw new Error(`No ${resource} matched selector`);
  }
  if (hasSelector) throw new Error(`Selector matched multiple ${resource}: ${found.length}`);
  if (found.length > 1) {
    throw new Error(
      `Multiple ${resource} found (${found.length}), use --uid/--name/--title/--where to select one`,
    );
  }
  return found[0];
}
