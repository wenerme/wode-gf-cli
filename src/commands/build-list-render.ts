import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { GrafanaClient } from "../client";
import { asObjectArray, asString, getObjectField } from "../lib/json-narrow";
import { RenderPanelOptionsSchema, type ResourceName } from "../schema";
import { buildRenderDashboardPath, buildRenderPanelPath, parsePositiveInt } from "../utils";
import type { CommandAppContext } from "./runtime";

type JsonObject = Record<string, unknown>;

type ListRow = {
  uid: string;
  label: string;
  folder?: string;
  raw: JsonObject;
};

export function buildListAndRenderCommands(app: CommandAppContext) {
  const { collectList, runtime } = app;
  const {
    parseCommonOptions,
    parseResourceAlias,
    fetchResources,
    resourceItems,
    rowsToTable,
    printMessage,
    printData,
    normalizeRenderTarget,
    ensureDir,
  } = runtime;

  const listCommand = new Command("list")
    .argument("<resource>", "resource to list")
    .description("List remote resources for discovery")
    .option("--folder <folderUid>", "filter dashboards by folder uid")
    .option("--json", "print full list as json")
    .action(async function listAction(resourceArg: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resource = parseResourceAlias(resourceArg);
      if (!resource) {
        throw new Error(`Unsupported list resource: ${resourceArg}`);
      }

      const client = new GrafanaClient(ctx);
      const fetchSet: ResourceName[] =
        resource === "dashboards" ? (["dashboards", "folders"] as ResourceName[]) : [resource];
      const remote = await fetchResources(client, fetchSet);
      let items = asObjectArray(resourceItems(remote, resource));

      const folderMap = new Map<string, string>();
      for (const folder of asObjectArray(remote.folders)) {
        const uid = asString(folder.uid);
        const title = asString(folder.title);
        if (uid && title) folderMap.set(uid, title);
      }

      if (resource === "dashboards" && options.folder) {
        const folderUid = String(options.folder).trim();
        items = items.filter((item) => asString(item.folderUid) === folderUid);
      }

      const rows: ListRow[] = items.map((item) => {
        const dashboard = getObjectField(item, "dashboard");
        const uid = asString(item.uid) || asString(dashboard?.uid) || "";
        const label =
          asString(item.title) ||
          asString(item.name) ||
          asString(dashboard?.title) ||
          asString(dashboard?.name) ||
          "";
        const folderUid = asString(item.folderUid) || null;
        return {
          uid,
          label,
          folder: folderUid ? folderMap.get(folderUid) || folderUid : undefined,
          raw: item,
        };
      });

      if (options.json || ctx.output === "json") {
        console.log(
          JSON.stringify(
            rows.map((row) => row.raw),
            null,
            2,
          ),
        );
        return;
      }

      printMessage(ctx, rowsToTable(rows));
    });

  const renderCommand = new Command("render")
    .argument("<target>", "panel|dashboard")
    .description("Render panel or dashboard PNG (requires Grafana image renderer plugin)")
    .requiredOption("--dashboard-uid <uid>", "dashboard uid")
    .option("-o, --out <file>", "output PNG file", "local/panel.png")
    .option("--from <from>", "time range start", "now-6h")
    .option("--to <to>", "time range end", "now")
    .option("--width <px>", "render width", "1600")
    .option("--height <px>", "render height", "900")
    .option("--tz <timezone>", "timezone", "UTC")
    .option("--theme <theme>", "light|dark", "light")
    .option("--render-timeout <ms>", "render request timeout milliseconds", "60000")
    .option("--panel-id <id>", "panel id (required for target=panel)")
    .option("--var <expr>", "template variable key=value, repeatable", collectList, [])
    .action(async function renderAction(target: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const renderTimeoutMs = parsePositiveInt(options.renderTimeout, 60_000);
      const normalizedTarget = normalizeRenderTarget(target);
      const base = {
        dashboardUid: String(options.dashboardUid || "").trim(),
        out: path.resolve(options.out),
        from: String(options.from || "now-6h").trim(),
        to: String(options.to || "now").trim(),
        width: parsePositiveInt(options.width, 1600),
        height: parsePositiveInt(options.height, 900),
        tz: String(options.tz || "UTC").trim(),
        theme: String(options.theme || "light").trim(),
        vars: options.var || [],
      };

      let renderPath = "";
      let actionName = "render-dashboard";
      if (normalizedTarget === "panel") {
        const parsed = RenderPanelOptionsSchema.parse({
          ...base,
          panelId: parsePositiveInt(options.panelId, 1),
        });
        renderPath = buildRenderPanelPath(parsed);
        actionName = "render-panel";
      } else {
        renderPath = buildRenderDashboardPath({
          dashboardUid: base.dashboardUid,
          from: base.from,
          to: base.to,
          width: base.width,
          height: base.height,
          tz: base.tz,
          theme: base.theme as "light" | "dark",
          vars: base.vars,
        });
      }

      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          action: actionName,
          dashboardUid: base.dashboardUid,
          panelId: options.panelId,
          renderPath,
          out: base.out,
          timeoutMs: renderTimeoutMs,
          message:
            normalizedTarget === "panel"
              ? `[DRY-RUN] render panel ${base.dashboardUid}:${String(options.panelId || "") || "?"} -> ${base.out}`
              : `[DRY-RUN] render dashboard ${base.dashboardUid} -> ${base.out}`,
        });
        return;
      }

      const client = new GrafanaClient({ ...ctx, timeoutMs: renderTimeoutMs });
      const image = await client.requestBytes("GET", renderPath, [200]);
      ensureDir(path.dirname(base.out));
      fs.writeFileSync(base.out, Buffer.from(image));
      const noDataWarning = image.length < 20 * 1024;

      printData(ctx, "render-complete", {
        target: normalizedTarget,
        dashboardUid: base.dashboardUid,
        panelId: options.panelId,
        out: base.out,
        size: image.length,
        possibleNoData: noDataWarning,
        message:
          normalizedTarget === "panel"
            ? `Rendered panel image: ${base.out} (${image.length} bytes)${noDataWarning ? `\n[WARN] possible NoData (file size: ${(image.length / 1024).toFixed(1)}KB)` : ""}`
            : `Rendered dashboard image: ${base.out} (${image.length} bytes)${noDataWarning ? `\n[WARN] possible NoData (file size: ${(image.length / 1024).toFixed(1)}KB)` : ""}`,
      });
    });

  return [listCommand, renderCommand];
}
