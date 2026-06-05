import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { GrafanaClient } from "../client";
import { asObject, asObjectArray, asString, getObjectField } from "../lib/json-narrow";
import { jsonPathRegex, jsonPathSet } from "../lib/jsonpath-patch";
import { CliName, type ResourceName, type ResourceSelector, ResourceSelectorSchema } from "../schema";
import { parsePositiveInt } from "../utils";
import type { CliContext, CommandAppContext } from "./runtime";

type JsonObject = Record<string, unknown>;
type ResourceRow = {
  uid: string;
  label: string;
  folder?: string;
  raw: JsonObject;
};

type FolderNode = {
  uid: string;
  title: string;
  parentUid?: string;
  raw: JsonObject;
};

function printResourceRows(
  ctx: CliContext,
  rows: ResourceRow[],
  options: { json?: boolean },
  rowsToTable: (rows: ResourceRow[]) => string,
  printMessage: (ctx: CliContext, message: string) => void,
) {
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
}

function buildFolderMap(folders: unknown): Map<string, string> {
  const folderMap = new Map<string, string>();
  for (const folder of asObjectArray(folders)) {
    const uid = asString(folder.uid);
    const title = asString(folder.title);
    if (uid && title) folderMap.set(uid, title);
  }
  return folderMap;
}

function buildFolderNodes(folders: unknown): FolderNode[] {
  return asObjectArray(folders)
    .map((folder) => {
      const uid = asString(folder.uid);
      const title = asString(folder.title);
      if (!uid || !title) return undefined;
      return {
        uid,
        title,
        parentUid: asString(folder.parentUid),
        raw: folder,
      } satisfies FolderNode;
    })
    .filter((node): node is FolderNode => Boolean(node));
}

function renderFolderTree(folders: unknown): string {
  const nodes = buildFolderNodes(folders);
  if (nodes.length === 0) return "";

  const byParent = new Map<string, FolderNode[]>();
  for (const node of nodes) {
    const key = node.parentUid || "__root__";
    const list = byParent.get(key) || [];
    list.push(node);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.title.localeCompare(b.title) || a.uid.localeCompare(b.uid));
  }

  const lines: string[] = [];
  const visit = (parentUid: string | undefined, depth: number) => {
    const key = parentUid || "__root__";
    for (const node of byParent.get(key) || []) {
      lines.push(`${"  ".repeat(depth)}- ${node.title} [${node.uid}]`);
      visit(node.uid, depth + 1);
    }
  };

  visit(undefined, 0);

  const missingRoots = nodes
    .filter((node) => node.parentUid && !nodes.some((candidate) => candidate.uid === node.parentUid))
    .sort((a, b) => a.title.localeCompare(b.title) || a.uid.localeCompare(b.uid));
  for (const node of missingRoots) {
    if (lines.some((line) => line.endsWith(`[${node.uid}]`))) continue;
    lines.push(`- ${node.title} [${node.uid}]`);
    visit(node.uid, 1);
  }

  return lines.join("\n");
}

function buildTokenSelectors(resource: ResourceName, token: string): ResourceSelector[] {
  const selectors: ResourceSelector[] = [];
  if (/^\d+$/.test(token)) {
    // numeric: try as id AND as uid (Grafana new-style uids can be all-digit strings)
    selectors.push(ResourceSelectorSchema.parse({ id: token, uid: token, where: [] }));
    selectors.push(ResourceSelectorSchema.parse({ uid: token, where: [] }));
  } else {
    selectors.push(ResourceSelectorSchema.parse({ uid: token, where: [] }));
  }

  if (resource === "folders" || resource === "dashboards" || resource === "alert-rules") {
    selectors.push(ResourceSelectorSchema.parse({ title: token, where: [] }));
  }
  if (resource === "datasources" || resource === "contact-points") {
    selectors.push(ResourceSelectorSchema.parse({ name: token, where: [] }));
  }
  return selectors;
}

function selectResourceByToken(
  items: unknown[],
  resource: ResourceName,
  token: string,
  selectResource: (
    items: unknown[],
    resource: ResourceName,
    selector: ResourceSelector,
    allowMissing?: boolean,
  ) => unknown | undefined,
): unknown {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Missing selector token");

  let lastNoMatch: Error | undefined;
  for (const selector of buildTokenSelectors(resource, trimmed)) {
    try {
      return selectResource(items, resource, selector, false);
    } catch (error) {
      const err = error as Error;
      if (err.message === `No ${resource} matched selector`) {
        lastNoMatch = err;
        continue;
      }
      throw err;
    }
  }

  throw lastNoMatch || new Error(`No ${resource} matched selector`);
}

function collectVariadic(value: string, previous: string[][]) {
  previous.push([value]);
  return previous;
}

function parseJsonPathValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parsePanelIdFilter(panelId: string | undefined) {
  const text = String(panelId || "ALL").trim();
  if (!text || text.toUpperCase() === "ALL") return "*";
  const ids = text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length === 0) return "*";
  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error(`Invalid --panel-id value: ${panelId}`);
  }
  return `?(${ids.map((id) => `@.id==${id}`).join(" || ")})`;
}

function panelScopedJsonPaths(panelId: string | undefined, pathExpr: string) {
  const path = pathExpr.trim();
  if (!path) throw new Error("Missing patch path");
  if (path.startsWith("$")) return [path];
  const selector = parsePanelIdFilter(panelId);
  return [`$..panels[${selector}].${path}`];
}

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
      printData,
      rowsToTable,
      renderTable,
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

  const scopedResources: Array<{
    cmd: string;
    aliases?: string[];
    resource: ResourceName;
    description: string;
  }> = [
    {
      cmd: "dashboard",
      aliases: ["dash", "d"],
      resource: "dashboards",
      description: "manage dashboards (list/search/get/move/delete)",
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
      description: "manage folders (list/search/get/create/rename/delete)",
    },
    {
      cmd: "alert-rule",
      resource: "alert-rules",
      description: "manage alert rules (list/search/get/delete)",
    },
    {
      cmd: "contact-point",
      resource: "contact-points",
      description: "manage contact points (list/search/get/delete)",
    },
    { cmd: "policy", resource: "policies", description: "manage notification policies (get)" },
  ];

  const scopedCommands: Command[] = [];
  for (const entry of scopedResources) {
    const scoped = new Command(entry.cmd).description(entry.description);
    for (const alias of entry.aliases || []) {
      scoped.alias(alias);
    }

    if (entry.resource === "dashboards") {
      scoped
        .command("patch-file <FILE>")
        .alias("patch")
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .description("Patch local dashboard JSON file with JSONPath set/regex operations")
        .option(
          "--panel-id <ids>",
          "panel id filter for relative patch paths: ALL or comma-separated ids",
          "ALL",
        )
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
          const setPaths = [...(options.set || [])].map((entry: string[]) => entry[0]);
          const regexPaths = [...(options.regex || [])].map((entry: string[]) => entry[0]);
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
                (result) =>
                  `${result.kind} ${result.path}: matched ${result.matched}, changed ${result.changed}`,
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

          printResourceRows(ctx, rows, options, rowsToTable, printMessage);
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
              return [row.uid, row.label, row.folder || ""].some((value) =>
                value.toLowerCase().includes(query),
              );
            });

          printResourceRows(ctx, rows, options, rowsToTable, printMessage);
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

          printResourceRows(ctx, rows, options, rowsToTable, printMessage);
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

          printResourceRows(ctx, rows, options, rowsToTable, printMessage);
        });
    }

    if (entry.resource === "folders") {
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

          printResourceRows(ctx, rows, options, rowsToTable, printMessage);
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

          printResourceRows(ctx, rows, options, rowsToTable, printMessage);
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
    }

    if (entry.resource === "alert-rules" || entry.resource === "contact-points") {
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

          printResourceRows(ctx, rows, options, rowsToTable, printMessage);
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
            .filter((row) => [row.uid, row.label].some((v) => v.toLowerCase().includes(query)));

          printResourceRows(ctx, rows, options, rowsToTable, printMessage);
        });
    }

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

    if (entry.resource !== "policies") {
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
            return deleteSingleResource(
              ctx,
              entry.resource,
              ResourceSelectorSchema.parse({ uid, where: [] }),
            );
          })();
          if (options.json || ctx.dryRun) {
            console.log(JSON.stringify(selected, null, 2));
          }
          printMessage(ctx, `Deleted ${entry.resource}.`);
          if (ctx.dryRun) printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
        });
    }
    scopedCommands.push(scoped);
  }

  return [patchCommand, deleteCommand, userCommand, ...scopedCommands];
}
