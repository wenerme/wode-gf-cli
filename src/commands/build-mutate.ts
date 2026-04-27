import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { GrafanaClient } from "../client";
import { asObjectArray, asString, getObjectField } from "../lib/json-narrow";
import { type ResourceName, type ResourceSelector, ResourceSelectorSchema } from "../schema";
import type { CommandAppContext } from "./runtime";

type JsonObject = Record<string, unknown>;

export function buildMutateCommands(app: CommandAppContext) {
  const {
    collectList,
    runtime: {
      parseCommonOptions,
      parseResourceAlias,
      fetchResources,
      resourceItems,
      selectResource,
      parseJsonLike,
      deepMerge,
      parseSetExpr,
      setPathValue,
      createEmptyBundle,
      setSingleResource,
      importResources,
      printMessage,
      rowsToTable,
      deleteSingleResource,
      parseIdOrUidSelector,
    },
  } = app;

  const patchCommand = new Command("patch")
    .argument("<resource>", "resource to patch")
    .description("Patch one remote resource with path/value updates")
    .option("--id <id>", "resource id selector")
    .option("--uid <uid>", "resource uid selector")
    .option("--match-name <name>", "resource name selector")
    .option("--title <title>", "resource title selector")
    .option("-w, --where <expr>", "filter path=value, repeatable", collectList, [])
    .option("--path <path>", "default path for value-only --set")
    .option("-s, --set <expr>", "patch expression path=value, repeatable", collectList, [])
    .option("--merge <json>", "deep merge JSON object into selected resource")
    .option("--from <file>", "replace selected resource with this JSON file content")
    .option("--json", "print patched json")
    .action(async function patchAction(resourceArg: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resource = parseResourceAlias(resourceArg);
      if (!resource) throw new Error(`Unsupported resource: ${resourceArg}`);

      const selector: ResourceSelector = ResourceSelectorSchema.parse({
        id: options.id,
        uid: options.uid,
        name: options.matchName,
        title: options.title,
        where: options.where || [],
      });

      const remoteBundle = await fetchResources(new GrafanaClient(ctx), [resource]);
      const current = selectResource(resourceItems(remoteBundle, resource), resource, selector, false);
      let updated: unknown = JSON.parse(JSON.stringify(current));

      if (options.from) {
        const fromFile = path.resolve(options.from);
        updated = JSON.parse(fs.readFileSync(fromFile, "utf8"));
      }

      if (options.merge) {
        const patchObj = parseJsonLike(options.merge);
        if (!patchObj || typeof patchObj !== "object" || Array.isArray(patchObj)) {
          throw new Error("--merge requires a JSON object");
        }
        updated = deepMerge(updated, patchObj);
      }

      const setExprs = options.set || [];
      for (const expr of setExprs) {
        const { path: setPath, value } = parseSetExpr(expr, options.path);
        if (!setPath) throw new Error(`Invalid --set expression: ${expr}`);
        if (!updated || typeof updated !== "object" || Array.isArray(updated)) {
          throw new Error("Patch target must be a JSON object");
        }
        setPathValue(updated as Record<string, unknown>, setPath, value);
      }

      if (setExprs.length === 0 && !options.merge && !options.from) {
        throw new Error("No patch operation provided. Use --set, --merge, or --from.");
      }

      const out = createEmptyBundle();
      out.resources = [resource];
      setSingleResource(out, resource, updated);
      await importResources(ctx, out, [resource]);

      if (options.json || ctx.dryRun) {
        console.log(JSON.stringify(updated, null, 2));
      }
      printMessage(ctx, `Patched ${resource}.`);
      if (ctx.dryRun) printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
    });

  const deleteCommand = new Command("delete")
    .argument("<resource>", "resource to delete")
    .description("Delete one remote resource")
    .option("--id <id>", "resource id selector")
    .option("--uid <uid>", "resource uid selector")
    .option("--match-name <name>", "resource name selector")
    .option("--title <title>", "resource title selector")
    .option("-w, --where <expr>", "filter path=value, repeatable", collectList, [])
    .option("--json", "print selected resource json")
    .action(async function deleteAction(resourceArg: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resource = parseResourceAlias(resourceArg);
      if (!resource) throw new Error(`Unsupported resource: ${resourceArg}`);

      const selector: ResourceSelector = ResourceSelectorSchema.parse({
        id: options.id,
        uid: options.uid,
        name: options.matchName,
        title: options.title,
        where: options.where || [],
      });

      const selected = await deleteSingleResource(ctx, resource, selector);
      if (options.json || ctx.dryRun) {
        console.log(JSON.stringify(selected, null, 2));
      }
      printMessage(ctx, `Deleted ${resource}.`);
      if (ctx.dryRun) printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
    });

  const scopedResources: Array<{
    cmd: string;
    aliases?: string[];
    resource: ResourceName;
    description: string;
  }> = [
    {
      cmd: "dashboard",
      aliases: ["dash"],
      resource: "dashboards",
      description: "manage dashboards (list/search/get/delete)",
    },
    {
      cmd: "connection",
      aliases: ["conn"],
      resource: "datasources",
      description: "manage connections (list/search/get/delete)",
    },
    {
      cmd: "folder",
      resource: "folders",
      description: "manage folders (get/delete)",
    },
    {
      cmd: "alert-rule",
      resource: "alert-rules",
      description: "manage alert rules (get/delete)",
    },
    {
      cmd: "contact-point",
      resource: "contact-points",
      description: "manage contact points (get/delete)",
    },
    { cmd: "policy", resource: "policies", description: "manage policies (get/delete)" },
  ];

  const scopedCommands: Command[] = [];
  for (const entry of scopedResources) {
    const scoped = new Command(entry.cmd).description(entry.description);
    for (const alias of entry.aliases || []) {
      scoped.alias(alias);
    }

    if (entry.resource === "dashboards") {
      scoped
        .command("list")
        .description("List dashboards")
        .option("--folder <folderUid>", "filter dashboards by folder uid")
        .option("--json", "print full list as json")
        .action(async function dashboardListAction(options) {
          const ctx = parseCommonOptions(this as unknown as Command);
          const remote = await fetchResources(new GrafanaClient(ctx), ["dashboards", "folders"]);
          let items = asObjectArray(resourceItems(remote, "dashboards"));

          const folderMap = new Map<string, string>();
          for (const folder of asObjectArray(remote.folders)) {
            const uid = asString(folder.uid);
            const title = asString(folder.title);
            if (uid && title) folderMap.set(uid, title);
          }

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

      scoped
        .command("search <TERM>")
        .description("Search dashboards by uid/title/folder")
        .option("--json", "print matched dashboards as json")
        .action(async function dashboardSearchAction(term: string, options) {
          const ctx = parseCommonOptions(this as unknown as Command);
          const remote = await fetchResources(new GrafanaClient(ctx), ["dashboards", "folders"]);
          const items = asObjectArray(resourceItems(remote, "dashboards"));

          const folderMap = new Map<string, string>();
          for (const folder of asObjectArray(remote.folders)) {
            const uid = asString(folder.uid);
            const title = asString(folder.title);
            if (uid && title) folderMap.set(uid, title);
          }

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
              return [row.uid, row.label, row.folder || ""].some((value) =>
                value.toLowerCase().includes(query),
              );
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
    }

    if (entry.resource === "datasources") {
      scoped
        .command("list")
        .description("List connections")
        .option("--json", "print full list as json")
        .action(async function datasourceListAction(options) {
          const ctx = parseCommonOptions(this as unknown as Command);
          const remote = await fetchResources(new GrafanaClient(ctx), ["datasources"]);
          const items = asObjectArray(resourceItems(remote, "datasources"));
          const rows = items.map((item) => {
            const uid = asString(item.uid) || "";
            const name = asString(item.name) || uid;
            const type = asString(item.type);
            return {
              uid,
              label: type ? `${name} (${type})` : name,
              raw: item as JsonObject,
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

      scoped
        .command("search <TERM>")
        .description("Search connections by uid/name/type")
        .option("--json", "print matched connections as json")
        .action(async function datasourceSearchAction(term: string, options) {
          const ctx = parseCommonOptions(this as unknown as Command);
          const remote = await fetchResources(new GrafanaClient(ctx), ["datasources"]);
          const query = term.trim().toLowerCase();
          const rows = asObjectArray(resourceItems(remote, "datasources"))
            .map((item) => {
              const uid = asString(item.uid) || "";
              const name = asString(item.name) || uid;
              const type = asString(item.type) || "";
              return {
                uid,
                label: type ? `${name} (${type})` : name,
                raw: item as JsonObject,
                searchable: [uid, name, type],
              };
            })
            .filter((row) => row.searchable.some((value) => value.toLowerCase().includes(query)))
            .map(({ searchable: _searchable, ...row }) => row);

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
    }

    scoped
      .command("get <ID>")
      .description(`Get ${entry.cmd} by id or uid as JSON`)
      .action(async function scopedGetAction(idOrUid: string) {
        const ctx = parseCommonOptions(this as unknown as Command);
        const selector = parseIdOrUidSelector(idOrUid);
        const remote = await fetchResources(new GrafanaClient(ctx), [entry.resource]);
        const selected = selectResource(
          resourceItems(remote, entry.resource),
          entry.resource,
          selector,
          false,
        );
        console.log(JSON.stringify(selected, null, 2));
      });

    scoped
      .command("delete <ID>")
      .description(`Delete ${entry.cmd} by id or uid`)
      .option("--json", "print selected resource json")
      .action(async function scopedDeleteAction(idOrUid: string, options) {
        const ctx = parseCommonOptions(this as unknown as Command);
        const selector = parseIdOrUidSelector(idOrUid);
        const selected = await deleteSingleResource(ctx, entry.resource, selector);
        if (options.json || ctx.dryRun) {
          console.log(JSON.stringify(selected, null, 2));
        }
        printMessage(ctx, `Deleted ${entry.resource}.`);
        if (ctx.dryRun) printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
      });
    scopedCommands.push(scoped);
  }

  return [patchCommand, deleteCommand, ...scopedCommands];
}
