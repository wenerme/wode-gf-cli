import { type GrafanaClient, mapLimit } from "../client";
import { addType, addTypeList } from "../core/json";
import {
  type DashboardApiMode,
  DashboardResourceApiBase,
  isDashboardResourceV2,
  sanitizeDashboardResourceV2,
} from "../dashboard/model";
import { asObject, asString, getObjectField } from "../lib/json-narrow";
import type { ExportBundle, ResourceName } from "../schema";

function expectObject(value: unknown, label: string): Record<string, unknown> {
  const object = asObject(value);
  if (!object) throw new Error(`${label} response must be an object`);
  return object;
}

function expectObjectArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} response must be an array`);
  return value.map((item, index) => {
    const object = asObject(item);
    if (!object) throw new Error(`${label} response item[${index}] must be an object`);
    return object;
  });
}

export async function fetchResources(
  client: GrafanaClient,
  resources: ResourceName[],
  options: { dashboardApi?: DashboardApiMode; allowPartial?: boolean } = {},
): Promise<ExportBundle> {
  const bundle: ExportBundle = { generatedAt: new Date().toISOString(), url: client.url, resources };

  for (const resource of resources) {
    try {
      if (resource === "folders") {
        bundle.folders = addTypeList(
          expectObjectArray(
            await client.request<unknown>("GET", "/api/folders?limit=1000&page=1"),
            "folders",
          ),
          "folder",
        );
      } else if (resource === "dashboards" && options.dashboardApi === "v2") {
        const list = expectObject(
          await client.request<unknown>("GET", DashboardResourceApiBase),
          "dashboard v2 list",
        );
        const items = expectObjectArray(list.items, "dashboard v2 items");
        bundle.dashboards = items.map((item, index) => {
          if (!isDashboardResourceV2(item)) {
            throw new Error(`dashboard v2 items response item[${index}] is not a Dashboard resource`);
          }
          return addType(sanitizeDashboardResourceV2(item), "dashboard-v2");
        });
      } else if (resource === "dashboards") {
        const list = expectObjectArray(
          await client.request<unknown>("GET", "/api/search?type=dash-db&limit=5000"),
          "dashboard search",
        );
        bundle.dashboards = await mapLimit(list, 8, async (item) => {
          const uid = asString(item.uid);
          if (!uid) return item;
          const full = expectObject(
            await client.request<unknown>("GET", `/api/dashboards/uid/${encodeURIComponent(uid)}`),
            `dashboard ${uid}`,
          );
          const dashboard = getObjectField(full, "dashboard");
          if (!dashboard) throw new Error(`dashboard ${uid} response.dashboard must be an object`);
          const meta = getObjectField(full, "meta");
          return addType(
            {
              uid,
              title: asString(item.title),
              folderUid: asString(meta?.folderUid) ?? null,
              dashboard,
            },
            "dashboard",
          );
        });
      } else if (resource === "datasources") {
        bundle.datasources = addTypeList(
          expectObjectArray(await client.request<unknown>("GET", "/api/datasources"), "datasources"),
          "connection",
        );
      } else if (resource === "alert-rules") {
        bundle["alert-rules"] = addTypeList(
          expectObjectArray(
            await client.request<unknown>("GET", "/api/v1/provisioning/alert-rules"),
            "alert rules",
          ),
          "alert-rule",
        );
      } else if (resource === "contact-points") {
        bundle["contact-points"] = addTypeList(
          expectObjectArray(
            await client.request<unknown>("GET", "/api/v1/provisioning/contact-points"),
            "contact points",
          ),
          "contact-point",
        );
      } else if (resource === "policies") {
        bundle.policies = addType(
          expectObject(
            await client.request<unknown>("GET", "/api/v1/provisioning/policies"),
            "notification policy",
          ),
          "policy",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.allowPartial) {
        throw new Error(`Failed to fetch ${resource}: ${message}`, { cause: error });
      }
      bundle.failedResources = [...(bundle.failedResources || []), resource];
      console.warn(`[WARN] skip ${resource}: ${message}`);
    }
  }
  return bundle;
}
