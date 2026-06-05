import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { GrafanaClient } from "../client";
import { asObject, asString, getObjectField } from "../lib/json-narrow";
import { buildGrafanaMacros, resolveTemplateString, resolveTemplateValue } from "../lib/template-vars";
import { type ResourceSelector, ResourceSelectorSchema } from "../schema";
import { parsePositiveInt, parseVarAssignments } from "../utils";
import type { CommandAppContext } from "./runtime";

type JsonObject = Record<string, unknown>;

export function buildQueryCommand(app: CommandAppContext) {
  const { collectList, runtime } = app;
  const {
    parseCommonOptions,
    detectQueryMode,
    resolveQueryDatasourceIdentifier,
    resolveDatasourceByIdentifier,
    parseJsonObjectOrThrow,
    parseQueryAssignment,
    setPathValue,
    renderFramesText,
    printMessage,
    collectBundle,
    resourceItems,
    fetchResources,
    selectResource,
    getPathValue,
  } = runtime;

  return new Command("query")
    .argument("<resourceOrDatasource>", "resource alias or datasource uid/name")
    .description("Inspect one resource, or run quick datasource queries")
    .option("-i, --in <target>", "optional local source path (directory or json file), default is remote")
    .option("--id <id>", "resource id selector")
    .option("--uid <uid>", "resource uid selector")
    .option("--match-name <name>", "resource name selector")
    .option("--title <title>", "resource title selector")
    .option("-w, --where <expr>", "filter path=value, repeatable", collectList, [])
    .option("--path <path>", "value path (dot / [index])")
    .option("--sql <sql>", "quick SQL query text (SQL datasource)")
    .option("--expr <expr>", "quick expression query text (Prometheus datasource)")
    .option("--query-json <json>", "full query object JSON for /api/ds/query")
    .option("--query-file <file>", "JSON file containing full query object")
    .option("--query <expr>", "query object patch path=value, repeatable", collectList, [])
    .option("--from <time>", "quick query time start", "now-1h")
    .option("--to <time>", "quick query time end", "now")
    .option("--format <format>", "quick query format", "table")
    .option("--ref-id <id>", "quick query refId", "A")
    .option("--max-data-points <n>", "quick query max datapoints", "1000")
    .option("--interval-ms <ms>", "quick query interval milliseconds", "60000")
    .option("--var <expr>", "quick query variable override key=value, repeatable", collectList, [])
    .option("--json", "print as json (default for objects)")
    .action(async function queryAction(resourceArg: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command, { requireUrl: !options.in });
      const flags = detectQueryMode(resourceArg, options);

      if (flags.isQuickQueryMode) {
        if (
          !options.sql &&
          !options.expr &&
          !options.queryJson &&
          !options.queryFile &&
          (options.query || []).length === 0
        ) {
          throw new Error("query datasource requires one of --sql/--expr/--query-json/--query-file/--query");
        }

        const datasourceIdentifier = resolveQueryDatasourceIdentifier(resourceArg, options, flags);
        const userVars = parseVarAssignments(options.var || []);
        const client = new GrafanaClient(ctx);
        const datasource = await resolveDatasourceByIdentifier(client, datasourceIdentifier, userVars);
        const refId = String(options.refId || "A").trim() || "A";
        const from = String(options.from || "now-1h").trim();
        const to = String(options.to || "now").trim();
        const intervalMs = parsePositiveInt(options.intervalMs, 60_000);

        // built-in Grafana macros + user vars (user vars take precedence)
        const vars = {
          ...buildGrafanaMacros({ from, to, intervalMs }),
          ...userVars,
        };

        let queryObject: JsonObject;
        if (options.queryFile) {
          const queryFile = String(options.queryFile).trim();
          const raw =
            queryFile === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(queryFile), "utf8");
          queryObject = parseJsonObjectOrThrow(raw, "--query-file content");
        } else if (options.queryJson) {
          queryObject = parseJsonObjectOrThrow(String(options.queryJson), "--query-json");
        } else {
          queryObject = {
            refId,
            datasource: { uid: datasource.uid },
          };
          if (options.sql) {
            queryObject.rawSql = resolveTemplateString(String(options.sql), vars);
            queryObject.format = String(options.format || "table").trim() || "table";
            queryObject.intervalMs = parsePositiveInt(options.intervalMs, 60_000);
            queryObject.maxDataPoints = parsePositiveInt(options.maxDataPoints, 1_000);
          }
          if (options.expr) {
            queryObject.expr = resolveTemplateString(String(options.expr), vars);
            queryObject.format = String(options.format || "time_series").trim() || "time_series";
            queryObject.intervalMs = parsePositiveInt(options.intervalMs, 60_000);
            queryObject.maxDataPoints = parsePositiveInt(options.maxDataPoints, 1_000);
          }
        }

        for (const expr of options.query || []) {
          const { path: queryPath, value } = parseQueryAssignment(String(expr));
          setPathValue(queryObject, queryPath, value);
        }

        queryObject = resolveTemplateValue(queryObject, vars) as JsonObject;
        if (!asObject(queryObject.datasource)) {
          queryObject.datasource = { uid: datasource.uid };
        }
        if (!asString(queryObject.refId)) {
          queryObject.refId = refId;
        }

        const payload = { from, to, queries: [queryObject] };
        const response = await client.requestWithStatus<JsonObject>("POST", "/api/ds/query", payload);
        const body = asObject(response.data);
        const result = body ? getObjectField(getObjectField(body, "results") || {}, refId) : undefined;
        const error = result ? asString(result.error) : undefined;

        if (options.json || ctx.output === "json") {
          console.log(
            JSON.stringify(
              {
                status: response.status,
                error,
                response: response.data,
              },
              null,
              2,
            ),
          );
        } else if (error) {
          printMessage(ctx, `[ERROR] refId=${refId} ${error}`);
        } else {
          const table = renderFramesText(response.data, refId);
          if (table) {
            printMessage(ctx, table);
          } else {
            printMessage(ctx, `[OK] status=${response.status} refId=${refId} (no data returned)`);
          }
        }

        if (error) {
          process.exitCode = 1;
          return;
        }
        if (response.status !== 200) {
          process.exitCode = 2;
        }
        return;
      }

      const resource = flags.resourceAlias;
      if (!resource) throw new Error(`Unsupported resource: ${resourceArg}`);

      const selector: ResourceSelector = ResourceSelectorSchema.parse({
        id: options.id,
        uid: options.uid,
        name: options.matchName,
        title: options.title,
        where: options.where || [],
      });

      let items: unknown[] = [];
      if (options.in) {
        const localBundle = collectBundle([path.resolve(options.in)], resource);
        items = resourceItems(localBundle, resource);
      } else {
        const remoteBundle = await fetchResources(new GrafanaClient(ctx), [resource]);
        items = resourceItems(remoteBundle, resource);
      }

      const item = selectResource(items, resource, selector, false);
      const value = getPathValue(item, options.path);
      if (options.json || typeof value === "object") {
        console.log(JSON.stringify(value, null, 2));
      } else {
        console.log(String(value ?? ""));
      }
    });
}
