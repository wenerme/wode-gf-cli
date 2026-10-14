import type { Command } from "commander";
import { GrafanaClient } from "../../client";
import { asObject, asObjectArray, asString, getObjectField } from "../../lib/json-narrow";
import { CliName } from "../../schema";
import type { CommandAppContext } from "../runtime";
import { buildDashboardLayoutCommand } from "./build-dashboard-layout";
import { buildDashboardVersionsCommand } from "./build-dashboard-versions";
import { attachScopedGetDelete, createScopedCommand, type ScopedResourceConfig } from "./build-scoped";
import { attachDashboardPatchFile } from "./dashboard-patch-file";
import { buildFolderMap, type JsonObject, printResourceRows, selectResourceByToken } from "./shared";

export function buildDashboardCommand(app: CommandAppContext): Command {
  const entry: ScopedResourceConfig = {
    cmd: "dashboard",
    aliases: ["dash", "d"],
    resource: "dashboards",
    description: "manage dashboards (list/search/get/move/delete/versions)",
  };
  const scoped = createScopedCommand(entry);
  const { parseCommonOptions, fetchResources, resourceItems, selectResource, printMessage, printData } =
    app.runtime;

  attachDashboardPatchFile(scoped, app);

  scoped
    .command("list")
    .description("List dashboards")
    .option("--folder <folderUid>", "filter dashboards by folder uid")
    .option("--json", "print full list as json")
    .action(async function dashboardListAction(options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const remote = await fetchResources(new GrafanaClient(ctx), ["dashboards", "folders"]);
      let items = asObjectArray(resourceItems(remote, "dashboards"));
      const folderMap = buildFolderMap(remote.folders);

      if (options.folder) {
        const folderUid = String(options.folder).trim();
        items = items.filter((item) => asString(item.folderUid) === folderUid);
      }

      const rows = items.map((item) => {
        const dashboard = getObjectField(item, "dashboard");
        const uid = asString(item.uid) || asString(dashboard?.uid) || "";
        const label = asString(item.title) || asString(dashboard?.title) || "";
        const folderUid = asString(item.folderUid) || null;
        return {
          uid,
          label,
          folder: folderUid ? folderMap.get(folderUid) || folderUid : undefined,
          raw: item as JsonObject,
        };
      });

      printResourceRows(app, ctx, rows, options);
    });

  scoped
    .command("search <TERM>")
    .description("Search dashboards by uid/title/folder")
    .option("--json", "print matched dashboards as json")
    .action(async function dashboardSearchAction(term: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const remote = await fetchResources(new GrafanaClient(ctx), ["dashboards", "folders"]);
      const items = asObjectArray(resourceItems(remote, "dashboards"));
      const folderMap = buildFolderMap(remote.folders);
      const query = term.trim().toLowerCase();
      const rows = items
        .map((item) => {
          const dashboard = getObjectField(item, "dashboard");
          const uid = asString(item.uid) || asString(dashboard?.uid) || "";
          const label = asString(item.title) || asString(dashboard?.title) || "";
          const folderUid = asString(item.folderUid) || null;
          const folder = folderUid ? folderMap.get(folderUid) || folderUid : undefined;
          return {
            uid,
            label,
            folder,
            raw: item as JsonObject,
          };
        })
        .filter((row) => {
          return [row.uid, row.label, row.folder || ""].some((value) => value.toLowerCase().includes(query));
        });

      printResourceRows(app, ctx, rows, options);
    });

  scoped
    .command("move <ID> <FOLDER>")
    .alias("mv")
    .description("Move dashboard to another folder (ID/FOLDER accept uid, numeric id, or title)")
    .option("--json", "print updated dashboard json")
    .action(async function dashboardMoveAction(idOrUid: string, folderIdOrUid: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const client = new GrafanaClient(ctx);
      const remote = await fetchResources(client, ["dashboards", "folders"]);
      const dashboard = asObject(
        selectResourceByToken(resourceItems(remote, "dashboards"), "dashboards", idOrUid, selectResource),
      );
      const folder = asObject(
        selectResourceByToken(resourceItems(remote, "folders"), "folders", folderIdOrUid, selectResource),
      );

      if (!dashboard) throw new Error("Selected dashboard is not a JSON object");
      if (!folder) throw new Error("Selected folder is not a JSON object");

      const dashboardBody = getObjectField(dashboard, "dashboard");
      const dashboardUid = asString(dashboard.uid) || asString(dashboardBody?.uid) || "";
      const dashboardTitle = asString(dashboard.title) || asString(dashboardBody?.title) || dashboardUid;
      const currentFolderUid = asString(dashboard.folderUid) || "";
      const targetFolderUid = asString(folder.uid);
      const targetFolderTitle = asString(folder.title) || targetFolderUid || "(unknown)";
      if (!dashboardBody) throw new Error("Selected dashboard has no dashboard payload");
      if (!targetFolderUid) throw new Error("Selected folder has no uid");

      const moved = {
        ...dashboard,
        folderUid: targetFolderUid,
      };

      if (currentFolderUid === targetFolderUid) {
        if (options.json || ctx.output === "json") {
          console.log(JSON.stringify(moved, null, 2));
        }
        printMessage(ctx, `Dashboard ${dashboardTitle} is already in folder ${targetFolderTitle}.`);
        return;
      }

      const body = {
        dashboard: {
          ...dashboardBody,
          id: null,
        },
        folderUid: targetFolderUid,
        overwrite: true,
        message: `moved by ${CliName}`,
      };

      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "dashboards",
          action: "move",
          uid: dashboardUid,
          title: dashboardTitle,
          fromFolderUid: currentFolderUid,
          toFolderUid: targetFolderUid,
          message: `[DRY-RUN] dashboard move ${dashboardUid || dashboardTitle} -> ${targetFolderUid}`,
        });
      } else {
        await client.request("POST", "/api/dashboards/db", body, [200]);
      }

      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify(moved, null, 2));
      }
      printMessage(ctx, `Moved dashboard ${dashboardTitle} to folder ${targetFolderTitle}.`);
      if (ctx.dryRun) printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
    });

  scoped.addCommand(buildDashboardLayoutCommand(app));
  scoped.addCommand(buildDashboardVersionsCommand(app));
  attachScopedGetDelete(scoped, app, entry);
  return scoped;
}
