import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { GrafanaClient } from "../../client";
import { asObject, asObjectArray, asString } from "../../lib/json-narrow";
import type { ResourceSelector } from "../../schema";
import { ResourceSelectorSchema } from "../../schema";
import { parsePositiveInt } from "../../utils";
import type { CommandAppContext } from "../runtime";

export function buildRootCommands(app: CommandAppContext) {
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
      renderTable,
      deleteSingleResource,
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

  const userCommand = new Command("user").description("list Grafana users");
  userCommand
    .command("list")
    .description("List users")
    .option("--search <TERM>", "filter users by login/name/email")
    .option("--page <N>", "page number", "1")
    .option("--limit <N>", "page size", "100")
    .option("--json", "print full user list as json")
    .action(async function userListAction(options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const client = new GrafanaClient(ctx);
      const page = parsePositiveInt(options.page, 1);
      const limit = parsePositiveInt(options.limit, 100);
      const search = String(options.search || "").trim();
      const apiPath = `/api/users/search?perpage=${limit}&page=${page}${search ? `&query=${encodeURIComponent(search)}` : ""}`;
      const result = asObject(await client.request<unknown>("GET", apiPath));
      const users = asObjectArray(result?.users);

      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify(users, null, 2));
        return;
      }

      const rows = users.map((user) => [
        String(user.id ?? ""),
        asString(user.login) || "",
        asString(user.name) || asString(user.displayName) || "",
        asString(user.email) || "",
        user.isAdmin === true || user.isGrafanaAdmin === true
          ? "yes"
          : user.isAdmin === false || user.isGrafanaAdmin === false
            ? "no"
            : "",
      ]);
      const totalCount = typeof result?.totalCount === "number" ? result.totalCount : undefined;
      const table = renderTable(["id", "login", "name", "email", "admin"], rows);
      const summary = `Page ${page}, limit ${limit}${typeof totalCount === "number" ? `, total ${totalCount}` : ""}`;
      printMessage(ctx, [table, summary].filter(Boolean).join("\n\n"));
    });

  return [patchCommand, deleteCommand, userCommand];
}
