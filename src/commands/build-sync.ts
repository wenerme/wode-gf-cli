import path from "node:path";
import { Command } from "commander";
import { GrafanaClient } from "../client";
import { type ResourceSelector, ResourceSelectorSchema } from "../schema";
import type { CommandAppContext, DiffItem } from "./runtime";

export function buildSyncCommands(app: CommandAppContext) {
  const { collectList, runtime } = app;
  const {
    parseCommonOptions,
    parseResources,
    parseResourceAlias,
    dedupeResources,
    collectBundle,
    fetchResources,
    bundleToFiles,
    importResources,
    resourceItems,
    selectResource,
    getPathValue,
    valueEqual,
    hashObject,
    diffArray,
    printMessage,
    printData,
  } = runtime;

  const exportCommand = new Command("export")
    .description("Export remote Grafana resources into local split JSON files")
    .option("-o, --out <dir>", "output directory", "./grafana-export")
    .option(
      "-r, --resources <list>",
      "comma-separated resources: dashboards,datasources,folders,alert-rules,contact-points,policies",
    )
    .option("--compact", "write compact json")
    .action(async function exportAction(options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resources = parseResources(options.resources);
      const outDir = path.resolve(options.out);

      const client = new GrafanaClient(ctx);
      const bundle = await fetchResources(client, resources);
      bundle.profile = ctx.profile;

      bundleToFiles(outDir, bundle, !options.compact);
      printData(ctx, "export-complete", {
        resources,
        outputDir: outDir,
        message: `Exported resources: ${resources.join(",")}\nOutput directory: ${outDir}`,
      });
    });

  const importCommand = new Command("import")
    .argument("[sources...]", "source files/directories")
    .description("Apply local JSON files/directories to remote Grafana")
    .option(
      "-r, --resources <list>",
      "comma-separated resources: dashboards,datasources,folders,alert-rules,contact-points,policies",
    )
    .option(
      "-t, --type <type>",
      "fallback type when JSON has no __type (dashboard|connection|folder|alert-rule|contact-point|policy)",
    )
    .action(async function importAction(sources: string[] | undefined, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resources = parseResources(options.resources);
      const fallbackType = parseResourceAlias(options.type);
      if (options.type && !fallbackType) {
        throw new Error(`Unsupported --type: ${options.type}`);
      }
      const sourceList = sources && sources.length > 0 ? sources : ["./grafana-export"];
      const resolvedSources = sourceList.map((source) => path.resolve(source));
      printData(ctx, "collect-sources", {
        sources: resolvedSources,
        message: `Collect sources: ${resolvedSources.join(", ")}`,
      });
      const merged = collectBundle(resolvedSources, fallbackType);
      merged.resources = dedupeResources(resources);

      await importResources(ctx, merged, resources);
      printData(ctx, "import-complete", {
        resources,
        input: resolvedSources,
        dryRun: ctx.dryRun,
        message: `Imported resources: ${resources.join(",")}\nInput: ${resolvedSources.join(", ")}`,
      });
      if (ctx.dryRun) printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
    });

  const diffCommand = new Command("diff")
    .description("Compare local export with current remote Grafana")
    .option("-i, --in <dir>", "input directory", "./grafana-export")
    .option(
      "-r, --resources <list>",
      "comma-separated resources: dashboards,datasources,folders,alert-rules,contact-points,policies",
    )
    .option(
      "--resource <resource>",
      "single resource mode (dashboard|connection|folder|alert-rule|contact-point|policy)",
    )
    .option("--id <id>", "resource id selector")
    .option("--uid <uid>", "resource uid selector")
    .option("--match-name <name>", "resource name selector")
    .option("--title <title>", "resource title selector")
    .option("-w, --where <expr>", "filter path=value, repeatable", collectList, [])
    .option("--path <path>", "only compare value at this path")
    .option("--json", "print full diff as JSON")
    .action(async function diffAction(options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resources = parseResources(options.resources);
      const inPath = path.resolve(options.in);

      if (options.resource) {
        const resource = parseResourceAlias(options.resource);
        if (!resource) throw new Error(`Unsupported --resource: ${options.resource}`);

        const selector: ResourceSelector = ResourceSelectorSchema.parse({
          id: options.id,
          uid: options.uid,
          name: options.matchName,
          title: options.title,
          where: options.where || [],
        });
        const localBundle = collectBundle([inPath], resource);
        const remoteBundle = await fetchResources(new GrafanaClient(ctx), [resource]);

        const localItem = selectResource(resourceItems(localBundle, resource), resource, selector, true);
        const remoteItem = selectResource(resourceItems(remoteBundle, resource), resource, selector, true);
        const localValue = getPathValue(localItem, options.path);
        const remoteValue = getPathValue(remoteItem, options.path);
        const changed = !valueEqual(localValue, remoteValue);

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                resource,
                selector,
                path: options.path || null,
                changed,
                local: localValue,
                remote: remoteValue,
              },
              null,
              2,
            ),
          );
        } else {
          printMessage(ctx, `resource: ${resource}`);
          printMessage(ctx, `path: ${options.path || "(root)"}`);
          printMessage(ctx, `status: ${changed ? "changed" : "equal"}`);
          if (changed) {
            printMessage(ctx, `local: ${hashObject(localValue)}`);
            printMessage(ctx, `remote: ${hashObject(remoteValue)}`);
          }
        }

        if (changed) process.exitCode = 2;
        return;
      }

      const local = collectBundle([inPath]);
      const remote = await fetchResources(new GrafanaClient(ctx), resources);
      const result: Record<string, DiffItem[]> = {};

      for (const resource of resources) {
        if (resource === "policies") {
          const localHash = hashObject(local.policies || {});
          const remoteHash = hashObject(remote.policies || {});
          result[resource] = localHash === remoteHash ? [] : [{ key: "policies", change: "changed" }];
          continue;
        }

        const localData = resourceItems(local, resource);
        const remoteData = resourceItems(remote, resource);
        result[resource] = diffArray(resource, localData || [], remoteData || []);
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      let total = 0;
      for (const resource of resources) {
        const items = result[resource] || [];
        total += items.length;
        const added = items.filter((v) => v.change === "added").length;
        const removed = items.filter((v) => v.change === "removed").length;
        const changed = items.filter((v) => v.change === "changed").length;
        printMessage(ctx, `${resource}: +${added} -${removed} ~${changed} (total ${items.length})`);
        for (const line of items.slice(0, 20)) {
          printMessage(ctx, `  ${line.change.padEnd(7)} ${line.key}`);
        }
        if (items.length > 20) {
          printMessage(ctx, `  ... ${items.length - 20} more`);
        }
      }

      if (total === 0) printMessage(ctx, "No diff.");
      else process.exitCode = 2;
    });

  return [exportCommand, importCommand, diffCommand];
}
