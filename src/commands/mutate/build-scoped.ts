import { Command } from "commander";
import { GrafanaClient } from "../../client";
import { asObject, asObjectArray, asString } from "../../lib/json-narrow";
import type { ResourceName } from "../../schema";
import { ResourceSelectorSchema } from "../../schema";
import { attachAlertRuleOps, attachPolicyRouteOps } from "../build-alert-ops";
import { buildAlertRuleVersionsCommand } from "../build-alert-rule-versions";
import { attachAlertRuleRuntimeOps } from "../build-alert-runtime";
import type { CommandAppContext } from "../runtime";
import { type JsonObject, printResourceRows, selectResourceByToken } from "./shared";

export type ScopedResourceConfig = {
  cmd: string;
  aliases?: string[];
  resource: ResourceName;
  description: string;
};

export function createScopedCommand(entry: ScopedResourceConfig): Command {
  const scoped = new Command(entry.cmd).description(entry.description);
  for (const alias of entry.aliases || []) {
    scoped.alias(alias);
  }
  return scoped;
}

export function attachScopedGetDelete(scoped: Command, app: CommandAppContext, entry: ScopedResourceConfig) {
  const { parseCommonOptions, fetchResources, resourceItems, selectResource, deleteSingleResource } =
    app.runtime;
  const getCommand =
    entry.resource === "policies"
      ? scoped.command("get [ID]").description("Get root notification policy tree as JSON")
      : scoped.command("get <ID>").description(`Get ${entry.cmd} by id, uid, name, or title as JSON`);

  getCommand.action(async function scopedGetAction(idOrUid: string | undefined) {
    const ctx = parseCommonOptions(this as unknown as Command);
    const remote = await fetchResources(new GrafanaClient(ctx), [entry.resource]);
    const selected =
      entry.resource === "policies"
        ? resourceItems(remote, entry.resource)[0]
        : selectResourceByToken(
            resourceItems(remote, entry.resource),
            entry.resource,
            String(idOrUid || ""),
            selectResource,
          );
    console.log(JSON.stringify(selected, null, 2));
  });

  if (entry.resource === "policies") return;

  scoped
    .command("delete <ID>")
    .description(`Delete ${entry.cmd} by id or uid`)
    .option("--json", "print selected resource json")
    .action(async function scopedDeleteAction(idOrUid: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const selected = await (async () => {
        if (entry.resource === "folders") {
          const client = new GrafanaClient(ctx);
          const remote = await fetchResources(client, ["folders"]);
          const folder = selectResourceByToken(
            resourceItems(remote, "folders"),
            "folders",
            idOrUid,
            selectResource,
          );
          const folderObj = asObject(folder);
          const uid = asString(folderObj?.uid);
          if (!uid) throw new Error("Selected folder has no uid, cannot delete");
          return deleteSingleResource(ctx, "folders", ResourceSelectorSchema.parse({ uid, where: [] }));
        }

        const remote = await fetchResources(new GrafanaClient(ctx), [entry.resource]);
        const target = selectResourceByToken(
          resourceItems(remote, entry.resource),
          entry.resource,
          idOrUid,
          selectResource,
        );
        const targetObj = asObject(target);
        const uid = asString(targetObj?.uid);
        if (!uid) throw new Error(`Selected ${entry.resource} has no uid, cannot delete`);
        return deleteSingleResource(ctx, entry.resource, ResourceSelectorSchema.parse({ uid, where: [] }));
      })();
      if (options.json || ctx.dryRun) {
        console.log(JSON.stringify(selected, null, 2));
      }
      app.runtime.printMessage(ctx, `Deleted ${entry.resource}.`);
      if (ctx.dryRun) {
        app.runtime.printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
      }
    });
}

export function buildConnectionCommand(app: CommandAppContext): Command {
  const entry: ScopedResourceConfig = {
    cmd: "connection",
    aliases: ["conn"],
    resource: "datasources",
    description: "manage connections (list/search/get/delete)",
  };
  const scoped = createScopedCommand(entry);
  const { parseCommonOptions, fetchResources, resourceItems } = app.runtime;

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

      printResourceRows(app, ctx, rows, options);
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

      printResourceRows(app, ctx, rows, options);
    });

  attachScopedGetDelete(scoped, app, entry);
  return scoped;
}

function attachAlertResourceListSearch(
  scoped: Command,
  app: CommandAppContext,
  entry: ScopedResourceConfig & { resource: "alert-rules" | "contact-points" },
) {
  const { parseCommonOptions, fetchResources, resourceItems } = app.runtime;
  const labelField = entry.resource === "alert-rules" ? "title" : "name";

  scoped
    .command("list")
    .description(`List ${entry.cmd}s`)
    .option("--folder <folderUid>", entry.resource === "alert-rules" ? "filter by folder uid" : undefined)
    .option("--json", "print full list as json")
    .action(async function (options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const remote = await fetchResources(new GrafanaClient(ctx), [entry.resource]);
      let items = asObjectArray(resourceItems(remote, entry.resource));

      if (entry.resource === "alert-rules" && options.folder) {
        const folderUid = String(options.folder).trim();
        items = items.filter((item) => asString(item.folderUid) === folderUid);
      }

      const rows = items.map((item) => ({
        uid: asString(item.uid) || "",
        label: asString(item[labelField]) || asString(item.uid) || "",
        raw: item as JsonObject,
      }));

      printResourceRows(app, ctx, rows, options);
    });

  scoped
    .command("search <TERM>")
    .description(`Search ${entry.cmd}s by uid/title/name`)
    .option("--json", "print matched resources as json")
    .action(async function (term: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const remote = await fetchResources(new GrafanaClient(ctx), [entry.resource]);
      const query = term.trim().toLowerCase();
      const rows = asObjectArray(resourceItems(remote, entry.resource))
        .map((item) => ({
          uid: asString(item.uid) || "",
          label: asString(item[labelField]) || asString(item.uid) || "",
          raw: item as JsonObject,
        }))
        .filter((row) => [row.uid, row.label].some((value) => value.toLowerCase().includes(query)));

      printResourceRows(app, ctx, rows, options);
    });
}

export function buildAlertRuleCommand(app: CommandAppContext): Command {
  const entry = {
    cmd: "alert-rule",
    resource: "alert-rules",
    description: "manage alert rules (list/search/get/state/history/pause/resume/delete)",
  } as const satisfies ScopedResourceConfig;
  const scoped = createScopedCommand(entry);
  attachAlertRuleOps(scoped, app);
  attachAlertRuleRuntimeOps(scoped, app);
  attachAlertResourceListSearch(scoped, app, entry);
  scoped.addCommand(buildAlertRuleVersionsCommand(app));
  attachScopedGetDelete(scoped, app, entry);
  return scoped;
}

export function buildContactPointCommand(app: CommandAppContext): Command {
  const entry = {
    cmd: "contact-point",
    resource: "contact-points",
    description: "manage contact points (list/search/get/delete)",
  } as const satisfies ScopedResourceConfig;
  const scoped = createScopedCommand(entry);
  attachAlertResourceListSearch(scoped, app, entry);
  attachScopedGetDelete(scoped, app, entry);
  return scoped;
}

export function buildPolicyCommand(app: CommandAppContext): Command {
  const entry = {
    cmd: "policy",
    resource: "policies",
    description: "manage notification policies (get)",
  } as const satisfies ScopedResourceConfig;
  const scoped = createScopedCommand(entry);
  attachPolicyRouteOps(scoped, app);
  attachScopedGetDelete(scoped, app, entry);
  return scoped;
}
