import { GrafanaClient } from "../client";
import type { RuntimeContext } from "../config/context";
import { type JsonObject, removeKeys, stripMeta } from "../core/json";
import {
  DashboardResourceApiBase,
  dashboardResourceV2Name,
  dashboardResourceV2Path,
  dashboardResourceV2Title,
  isDashboardResourceV2,
  sanitizeDashboardResourceV2,
} from "../dashboard/model";
import { asObject, asObjectArray, asString, getObjectField } from "../lib/json-narrow";
import { printData } from "../output/render";
import {
  CliName,
  type ExportBundle,
  type ResourceName,
  type ResourceSelector,
  ResourceSelectorSchema,
} from "../schema";
import { fetchResources } from "./fetch";
import { resourceItems, selectResource } from "./model";

export async function importResources(
  ctx: RuntimeContext,
  bundle: ExportBundle,
  resources: ResourceName[],
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const overwrite = options.overwrite !== false;
  const client = new GrafanaClient(ctx);
  const has = (resource: ResourceName): boolean => resources.includes(resource);

  if (has("folders") && Array.isArray(bundle.folders)) {
    printData(ctx, "import-folders-start", {
      count: bundle.folders.length,
      message: `Import folders: ${bundle.folders.length}`,
    });
    for (const folder of asObjectArray(bundle.folders)) {
      const folderUid = asString(folder.uid);
      const folderTitle = asString(folder.title);
      if (!folderUid || !folderTitle) continue;
      const body = { uid: folderUid, title: folderTitle };
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
    const byUid = new Map(existing.map((value) => [String(value.uid), value]));
    const byName = new Map(existing.map((value) => [String(value.name), value]));
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
      const existingDatasource = (keyUid && byUid.get(keyUid)) || (keyName && byName.get(keyName));
      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "datasources",
          action: existingDatasource ? "update" : "create",
          key: keyUid || keyName || "(unknown)",
          message: `[DRY-RUN] datasource ${existingDatasource ? "update" : "create"} ${keyUid || keyName || "(unknown)"}`,
        });
        continue;
      }
      const existingUid = existingDatasource ? asString(existingDatasource.uid) : undefined;
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
      if (isDashboardResourceV2(item)) {
        const resource = sanitizeDashboardResourceV2(item);
        const name = dashboardResourceV2Name(resource);
        const title = dashboardResourceV2Title(resource);
        if (!name) throw new Error(`Dashboard v2 resource needs metadata.name: ${title || "(untitled)"}`);
        const key = name || title || "(unknown)";
        if (ctx.dryRun) {
          printData(ctx, "dry-run", {
            resource: "dashboards",
            api: "v2",
            action: "upsert",
            key,
            message: `[DRY-RUN] dashboard v2 upsert ${key}`,
          });
          continue;
        }
        const existing = await client.requestWithStatus<JsonObject>("GET", dashboardResourceV2Path(name));
        if (existing.status === 200 && asObject(existing.data)) {
          const resourceVersion = asString(getObjectField(existing.data, "metadata")?.resourceVersion);
          if (resourceVersion) {
            const metadata = getObjectField(resource, "metadata") || {};
            metadata.resourceVersion = resourceVersion;
            resource.metadata = metadata;
          }
          await client.request("PUT", dashboardResourceV2Path(name), resource, [200]);
        } else if (existing.status === 404) {
          await client.request("POST", DashboardResourceApiBase, resource, [201, 200]);
        } else {
          const message = typeof existing.data === "string" ? existing.data : JSON.stringify(existing.data);
          throw new Error(`${existing.status} GET ${dashboardResourceV2Path(name)}: ${message}`);
        }
        continue;
      }

      const cleanItem = asObject(stripMeta(item));
      if (!cleanItem) continue;
      const dashboard = getObjectField(cleanItem, "dashboard") || cleanItem;
      const dashboardUid = asString(dashboard.uid);
      const dashboardTitle = asString(dashboard.title);
      if (!dashboardUid && !dashboardTitle) continue;
      const body = {
        dashboard: { ...removeKeys(dashboard, ["id"]), id: null },
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
      const provenanceHeaders = { "X-Disable-Provenance": "true" };
      if (ruleUid) {
        try {
          await client.request(
            "PUT",
            `/api/v1/provisioning/alert-rules/${encodeURIComponent(ruleUid)}`,
            cleanRule,
            [200],
            provenanceHeaders,
          );
        } catch {
          await client.request(
            "POST",
            "/api/v1/provisioning/alert-rules",
            cleanRule,
            [201],
            provenanceHeaders,
          );
        }
      } else {
        await client.request("POST", "/api/v1/provisioning/alert-rules", cleanRule, [201], provenanceHeaders);
      }
    }
  }

  if (has("contact-points") && Array.isArray(bundle["contact-points"])) {
    printData(ctx, "import-contact-points-start", {
      count: bundle["contact-points"].length,
      message: `Import contact-points: ${bundle["contact-points"].length}`,
    });
    for (const contactPoint of asObjectArray(bundle["contact-points"])) {
      const cleanContactPoint = asObject(stripMeta(contactPoint));
      if (!cleanContactPoint) continue;
      const uid = asString(cleanContactPoint.uid);
      const name = asString(cleanContactPoint.name);
      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "contact-points",
          action: "upsert",
          key: uid || name || "(unknown)",
          message: `[DRY-RUN] contact-point upsert ${uid || name || "(unknown)"}`,
        });
        continue;
      }
      if (uid) {
        try {
          await client.request(
            "PUT",
            `/api/v1/provisioning/contact-points/${encodeURIComponent(uid)}`,
            cleanContactPoint,
            [202],
          );
        } catch {
          await client.request("POST", "/api/v1/provisioning/contact-points", cleanContactPoint, [202]);
        }
      } else {
        await client.request("POST", "/api/v1/provisioning/contact-points", cleanContactPoint, [202]);
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

export async function deleteSingleResource(
  ctx: RuntimeContext,
  resource: ResourceName,
  selector: ResourceSelector,
): Promise<unknown> {
  if (resource === "policies") throw new Error("Delete is not supported for policies");
  const client = new GrafanaClient(ctx);
  const remote = await fetchResources(client, [resource]);
  const selected = selectResource(resourceItems(remote, resource), resource, selector, false);
  const selectedObj = asObject(selected);
  const selectedDashboard = selectedObj ? getObjectField(selectedObj, "dashboard") : undefined;
  const uid = String(selectedObj?.uid || selectedDashboard?.uid || "");
  const name = String(selectedObj?.name || selectedObj?.title || selectedDashboard?.title || "");
  if (!uid && ["datasources", "dashboards", "folders", "alert-rules"].includes(resource)) {
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
  } else if (resource === "dashboards") {
    await client.request("DELETE", `/api/dashboards/uid/${encodeURIComponent(uid)}`, undefined, [200]);
  } else if (resource === "folders") {
    await client.request("DELETE", `/api/folders/${encodeURIComponent(uid)}`, undefined, [200]);
  } else if (resource === "alert-rules") {
    await client.request(
      "DELETE",
      `/api/v1/provisioning/alert-rules/${encodeURIComponent(uid)}`,
      undefined,
      [202, 204, 200],
    );
  } else if (resource === "contact-points") {
    await client.request(
      "DELETE",
      `/api/v1/provisioning/contact-points/${encodeURIComponent(uid)}`,
      undefined,
      [202, 204, 200],
    );
  } else {
    throw new Error(`Delete for ${resource} is not implemented yet`);
  }
  return selected;
}

export function parseIdOrUidSelector(idOrUid: string): ResourceSelector {
  const token = String(idOrUid || "").trim();
  if (!token) throw new Error("Missing id-or-uid");
  if (/^\d+$/.test(token)) return ResourceSelectorSchema.parse({ id: token, uid: token, where: [] });
  return ResourceSelectorSchema.parse({ uid: token, where: [] });
}
