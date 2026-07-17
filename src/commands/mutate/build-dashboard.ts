import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { GrafanaClient } from "../../client";
import { asObject, asObjectArray, asString, getObjectField } from "../../lib/json-narrow";
import { jsonPathRegex, jsonPathSet } from "../../lib/jsonpath-patch";
import { CliName } from "../../schema";
import type { CommandAppContext } from "../runtime";
import { attachScopedGetDelete, createScopedCommand, type ScopedResourceConfig } from "./build-scoped";
import {
  buildFolderMap,
  collectVariadic,
  type JsonObject,
  panelScopedJsonPaths,
  parseJsonPathValue,
  printResourceRows,
  selectResourceByToken,
} from "./shared";

export function buildDashboardCommand(app: CommandAppContext): Command {
  const entry: ScopedResourceConfig = {
    cmd: "dashboard",
    aliases: ["dash", "d"],
    resource: "dashboards",
    description: "manage dashboards (list/search/get/move/delete)",
  };
  const scoped = createScopedCommand(entry);
  const { parseCommonOptions, fetchResources, resourceItems, selectResource, printMessage, printData } =
    app.runtime;

  scoped
    .command("patch-file <FILE>")
    .alias("patch")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .description("Patch local dashboard JSON file with JSONPath set/regex operations")
    .option("--panel-id <ids>", "panel id filter for relative patch paths: ALL or comma-separated ids", "ALL")
    .option("--set <jsonpath>", "set JSONPath value; value is the next token", collectVariadic, [])
    .option(
      "--regex <jsonpath>",
      "regex replace JSONPath string values; pattern/replacement are next tokens",
      collectVariadic,
      [],
    )
    .option("--compact", "write compact json")
    .option("--json", "print patch summary as json")
    .action(function dashboardPatchFileAction(file: string, options) {
      const command = this as unknown as Command;
      const values = command.args.slice(1);
      const setPaths = [...(options.set || [])].map((item: string[]) => item[0]);
      const regexPaths = [...(options.regex || [])].map((item: string[]) => item[0]);
      const operations: Array<
        | { kind: "set"; path: string; value: unknown }
        | { kind: "regex"; path: string; pattern: string; replacement: string }
      > = [];
      let valueIndex = 0;
      for (let index = 0; index < setPaths.length; index += 1) {
        const pathArg = setPaths[index];
        const valueArg = values[valueIndex];
        if (!pathArg || valueArg === undefined) throw new Error("--set requires <jsonpath> <value>");
        for (const scopedPath of panelScopedJsonPaths(options.panelId, pathArg)) {
          operations.push({ kind: "set", path: scopedPath, value: parseJsonPathValue(valueArg) });
        }
        valueIndex += 1;
      }
      for (let index = 0; index < regexPaths.length; index += 1) {
        const pathArg = regexPaths[index];
        const pattern = values[valueIndex];
        const replacement = values[valueIndex + 1];
        if (!pathArg || pattern === undefined || replacement === undefined) {
          throw new Error("--regex requires <jsonpath> <pattern> <replacement>");
        }
        for (const scopedPath of panelScopedJsonPaths(options.panelId, pathArg)) {
          operations.push({ kind: "regex", path: scopedPath, pattern, replacement });
        }
        valueIndex += 2;
      }
      if (valueIndex < values.length) {
        throw new Error(`Unexpected extra patch arguments: ${values.slice(valueIndex).join(" ")}`);
      }
      if (operations.length === 0) throw new Error("No patch operation provided. Use --set or --regex.");

      const resolvedFile = path.resolve(file);
      const data = JSON.parse(fs.readFileSync(resolvedFile, "utf8"));
      const results = operations.map((operation) => {
        const result =
          operation.kind === "set"
            ? jsonPathSet(data, operation.path, operation.value)
            : jsonPathRegex(data, operation.path, operation.pattern, operation.replacement);
        return { ...operation, ...result };
      });
      fs.writeFileSync(resolvedFile, `${JSON.stringify(data, null, options.compact ? 0 : 2)}\n`, "utf8");
      if (options.json) {
        console.log(JSON.stringify({ file: resolvedFile, operations: results }, null, 2));
        return;
      }
      printMessage(
        parseCommonOptions(this as unknown as Command, { requireUrl: false }),
        results
          .map(
            (result) => `${result.kind} ${result.path}: matched ${result.matched}, changed ${result.changed}`,
          )
          .join("\n"),
      );
    });

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

  attachScopedGetDelete(scoped, app, entry);
  return scoped;
}
