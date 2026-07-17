import type { Command } from "commander";
import { GrafanaClient } from "../../client";
import { asObject, asObjectArray, asString } from "../../lib/json-narrow";
import type { CommandAppContext } from "../runtime";
import { attachScopedGetDelete, createScopedCommand, type ScopedResourceConfig } from "./build-scoped";
import { type JsonObject, printResourceRows, renderFolderTree, selectResourceByToken } from "./shared";

export function buildFolderCommand(app: CommandAppContext): Command {
  const entry: ScopedResourceConfig = {
    cmd: "folder",
    resource: "folders",
    description: "manage folders (list/search/get/create/rename/delete)",
  };
  const scoped = createScopedCommand(entry);
  const { parseCommonOptions, fetchResources, resourceItems, selectResource, printMessage, printData } =
    app.runtime;

  scoped
    .command("list")
    .description("List folders")
    .option("--tree", "render folders as tree when parent info is available")
    .option("--json", "print full list as json")
    .action(async function folderListAction(options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const remote = await fetchResources(new GrafanaClient(ctx), ["folders"]);
      if (options.tree && !(options.json || ctx.output === "json")) {
        const tree = renderFolderTree(resourceItems(remote, "folders"));
        printMessage(ctx, tree || "(no folders)");
        return;
      }

      const rows = asObjectArray(resourceItems(remote, "folders")).map((item) => ({
        uid: asString(item.uid) || "",
        label: asString(item.title) || asString(item.uid) || "",
        raw: item as JsonObject,
      }));

      printResourceRows(app, ctx, rows, options);
    });

  scoped
    .command("search <TERM>")
    .description("Search folders by uid/title")
    .option("--json", "print matched folders as json")
    .action(async function folderSearchAction(term: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const remote = await fetchResources(new GrafanaClient(ctx), ["folders"]);
      const query = term.trim().toLowerCase();
      const rows = asObjectArray(resourceItems(remote, "folders"))
        .map((item) => ({
          uid: asString(item.uid) || "",
          label: asString(item.title) || asString(item.uid) || "",
          raw: item as JsonObject,
        }))
        .filter((row) => [row.uid, row.label].some((value) => value.toLowerCase().includes(query)));

      printResourceRows(app, ctx, rows, options);
    });

  scoped
    .command("create <TITLE>")
    .description("Create folder")
    .option("--uid <UID>", "explicit folder uid")
    .option("--json", "print created folder json")
    .action(async function folderCreateAction(titleArg: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const client = new GrafanaClient(ctx);
      const title = String(titleArg || "").trim();
      const uid = asString(options.uid);
      if (!title) throw new Error("Missing folder title");

      const body = uid ? { title, uid } : { title };
      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "folders",
          action: "create",
          uid,
          title,
          message: `[DRY-RUN] folder create ${uid || title}`,
        });
        if (options.json || ctx.output === "json") {
          console.log(JSON.stringify(body, null, 2));
        }
        printMessage(ctx, `Create folder ${title}.`);
        return;
      }

      const created = await client.request<unknown>("POST", "/api/folders", body, [200]);
      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify(created, null, 2));
      }
      printMessage(ctx, `Created folder ${title}.`);
    });

  scoped
    .command("rename <ID> <TITLE>")
    .description("Rename folder")
    .option("--json", "print updated folder json")
    .action(async function folderRenameAction(idOrUid: string, titleArg: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const client = new GrafanaClient(ctx);
      const title = String(titleArg || "").trim();
      if (!title) throw new Error("Missing folder title");

      const remote = await fetchResources(client, ["folders"]);
      const current = asObject(
        selectResourceByToken(resourceItems(remote, "folders"), "folders", idOrUid, selectResource),
      );
      if (!current) throw new Error("Selected folder is not a JSON object");

      const uid = asString(current.uid);
      const previousTitle = asString(current.title) || uid || "(unknown)";
      if (!uid) throw new Error("Selected folder has no uid");

      const updated = {
        ...current,
        title,
      };

      if (previousTitle === title) {
        if (options.json || ctx.output === "json") {
          console.log(JSON.stringify(updated, null, 2));
        }
        printMessage(ctx, `Folder ${uid} is already named ${title}.`);
        return;
      }

      const body = { uid, title };
      if (ctx.dryRun) {
        printData(ctx, "dry-run", {
          resource: "folders",
          action: "rename",
          uid,
          fromTitle: previousTitle,
          toTitle: title,
          message: `[DRY-RUN] folder rename ${uid} ${previousTitle} -> ${title}`,
        });
      } else {
        await client.request("PUT", `/api/folders/${encodeURIComponent(uid)}`, body, [200]);
      }

      if (options.json || ctx.output === "json" || ctx.dryRun) {
        console.log(JSON.stringify(updated, null, 2));
      }
      printMessage(ctx, `Renamed folder ${previousTitle} to ${title}.`);
    });

  attachScopedGetDelete(scoped, app, entry);
  return scoped;
}
