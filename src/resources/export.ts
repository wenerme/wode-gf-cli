import fs from "node:fs";
import path from "node:path";
import { addType, type JsonObject } from "../core/json";
import {
  dashboardResourceV2Name,
  dashboardResourceV2Title,
  isDashboardResourceV2,
  sanitizeDashboardResourceV2,
} from "../dashboard/model";
import { asObjectArray, asString, getObjectField } from "../lib/json-narrow";
import { ensureDir, resetDir, safeName, uniqueBaseName, writeJson } from "../output/files";
import type { ExportBundle } from "../schema";

function dashboardFileName(item: JsonObject, used: Set<string>): string {
  const dashboard = getObjectField(item, "dashboard") || item;
  const uid = isDashboardResourceV2(item)
    ? dashboardResourceV2Name(item)
    : asString(item.uid) || asString(dashboard.uid);
  const title = isDashboardResourceV2(item)
    ? dashboardResourceV2Title(item)
    : asString(item.title) || asString(dashboard.title) || uid || "dashboard";
  return `${uniqueBaseName(uid ? safeName(uid) : safeName(title || "dashboard"), used)}.json`;
}

function folderTitleByUid(bundle: ExportBundle): Map<string, string> {
  const map = new Map<string, string>();
  for (const folder of asObjectArray(bundle.folders)) {
    const uid = asString(folder.uid);
    const title = asString(folder.title);
    if (uid && title) map.set(uid, title);
  }
  return map;
}

export function bundleToFiles(outDir: string, bundle: ExportBundle, pretty: boolean): void {
  ensureDir(outDir);
  for (const file of [
    "bundle.meta.json",
    "folders.json",
    "dashboards.json",
    "datasources.json",
    "alert-rules.json",
    "contact-points.json",
    "policies.json",
  ])
    fs.rmSync(path.join(outDir, file), { force: true });

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

  if (Array.isArray(bundle.dashboards)) {
    const hasV2Dashboards = asObjectArray(bundle.dashboards).some(isDashboardResourceV2);
    const directory = path.join(outDir, hasV2Dashboards ? "dashboard-v2" : "dashboard");
    resetDir(directory);
    const folderMap = folderTitleByUid(bundle);
    const usedByDir = new Map<string, Set<string>>();
    for (const item of asObjectArray(bundle.dashboards)) {
      if (isDashboardResourceV2(item)) {
        const used = usedByDir.get(directory) || new Set<string>();
        usedByDir.set(directory, used);
        writeJson(
          path.join(directory, dashboardFileName(item, used)),
          addType(sanitizeDashboardResourceV2(item), "dashboard-v2"),
          pretty,
        );
        continue;
      }
      const dashboard = getObjectField(item, "dashboard") || item;
      const folderUid = asString(item.folderUid);
      const folderTitle = folderUid ? folderMap.get(folderUid) || folderUid : undefined;
      const targetDir = folderUid ? path.join(directory, safeName(folderTitle || folderUid)) : directory;
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
      writeJson(path.join(targetDir, filename), dashboard, pretty);
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

  const writeItems = (
    values: unknown[] | undefined,
    directoryName: string,
    baseName: (item: JsonObject) => string,
  ): void => {
    if (!Array.isArray(values)) return;
    const directory = path.join(outDir, directoryName);
    resetDir(directory);
    const used = new Set<string>();
    for (const item of asObjectArray(values)) {
      writeJson(path.join(directory, `${uniqueBaseName(baseName(item), used)}.json`), item, pretty);
    }
  };

  writeItems(bundle.datasources, "connection", (item) =>
    safeName(String(item.name || item.uid || "datasource")),
  );
  writeItems(bundle.folders, "folder", (item) => safeName(String(item.title || "folder")));
  writeItems(bundle["alert-rules"], "alert-rule", (item) => {
    const uid = String(item.uid || "");
    const title = String(item.title || item.name || uid || "alert-rule");
    return uid ? `${safeName(title)}-${safeName(uid)}` : safeName(title);
  });
  writeItems(bundle["contact-points"], "contact-point", (item) => {
    const uid = String(item.uid || "");
    const name = String(item.name || item.title || uid || "contact-point");
    return uid ? `${safeName(name)}-${safeName(uid)}` : safeName(name);
  });

  if (bundle.policies !== undefined) {
    const directory = path.join(outDir, "policy");
    resetDir(directory);
    writeJson(path.join(directory, "root.json"), bundle.policies, pretty);
  }
}
