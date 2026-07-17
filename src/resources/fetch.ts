import { type GrafanaClient, mapLimit } from "../client";
import { addType, addTypeList } from "../core/json";
import {
  type DashboardApiMode,
  DashboardResourceApiBase,
  isDashboardResourceV2,
  sanitizeDashboardResourceV2,
} from "../dashboard/model";
import { asObject, asObjectArray, asString, getObjectField } from "../lib/json-narrow";
import type { ExportBundle, ResourceName } from "../schema";

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
          await client.request<unknown[]>("GET", "/api/folders?limit=1000&page=1"),
          "folder",
        );
      } else if (resource === "dashboards" && options.dashboardApi === "v2") {
        const list = asObject(await client.request<unknown>("GET", DashboardResourceApiBase));
        bundle.dashboards = asObjectArray(list?.items)
          .filter(isDashboardResourceV2)
          .map((item) => addType(sanitizeDashboardResourceV2(item), "dashboard-v2"));
      } else if (resource === "dashboards") {
        const list = asObjectArray(
          await client.request<unknown[]>("GET", "/api/search?type=dash-db&limit=5000"),
        );
        bundle.dashboards = await mapLimit(list, 8, async (item) => {
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
      } else if (resource === "datasources") {
        bundle.datasources = addTypeList(
          await client.request<unknown[]>("GET", "/api/datasources"),
          "connection",
        );
      } else if (resource === "alert-rules") {
        bundle["alert-rules"] = addTypeList(
          await client.request<unknown[]>("GET", "/api/v1/provisioning/alert-rules"),
          "alert-rule",
        );
      } else if (resource === "contact-points") {
        bundle["contact-points"] = addTypeList(
          await client.request<unknown[]>("GET", "/api/v1/provisioning/contact-points"),
          "contact-point",
        );
      } else if (resource === "policies") {
        bundle.policies = addType(
          await client.request<unknown>("GET", "/api/v1/provisioning/policies"),
          "policy",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.allowPartial) {
        throw new Error(`Failed to fetch ${resource}: ${message}`, { cause: error });
      }
      console.warn(`[WARN] skip ${resource}: ${message}`);
    }
  }
  return bundle;
}
