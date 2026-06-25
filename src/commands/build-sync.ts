import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { GrafanaClient } from "../client";
import { parseGrafanaPromQLMacroMode } from "../promql/grafana";
import {
  type ExportBundle,
  type ResourceName,
  type ResourceSelector,
  ResourceSelectorSchema,
} from "../schema";
import type { CommandAppContext, DiffItem } from "./runtime";

const SyncResourceOrder = [
  "folders",
  "dashboards",
  "datasources",
  "alert-rules",
  "contact-points",
  "policies",
] as const satisfies readonly ResourceName[];

export function buildSyncCommands(app: CommandAppContext) {
  const { collectList, runtime } = app;
  const {
    parseCommonOptions,
    parseResources,
    parseResourceAlias,
    dedupeResources,
    isDashboardResourceV2,
    dashboardResourceV2HasTabs,
    collectBundle,
    collectDashboards,
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
    validateDashboardPromQLSyntax,
    createEmptyBundle,
    writeJson,
  } = runtime;

  const bundleResources = (bundle: ExportBundle): ResourceName[] => {
    return SyncResourceOrder.filter((resource) => resourceItems(bundle, resource).length > 0);
  };

  const parseDashboardApiMode = (value: unknown, fallback: "classic" | "auto") => {
    const mode = String(value || fallback)
      .trim()
      .toLowerCase();
    if (mode === "classic" || mode === "v2" || mode === "auto") return mode;
    throw new Error(`Unsupported --dashboard-api: ${String(value)}`);
  };

  const dashboardV2NameFromItem = (item: unknown): string | undefined => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const obj = item as Record<string, unknown>;
    const metadata =
      obj.metadata && typeof obj.metadata === "object"
        ? (obj.metadata as Record<string, unknown>)
        : undefined;
    const spec = obj.spec && typeof obj.spec === "object" ? (obj.spec as Record<string, unknown>) : undefined;
    const value = metadata?.name || spec?.uid || obj.uid;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };

  const fetchDashboardV2LocalSubset = async (
    client: GrafanaClient,
    localItems: unknown[],
  ): Promise<ExportBundle> => {
    const bundle = createEmptyBundle();
    bundle.resources = ["dashboards"];
    bundle.dashboards = [];
    for (const item of localItems) {
      const name = dashboardV2NameFromItem(item);
      if (!name) continue;
      const path = `/apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/${encodeURIComponent(name)}`;
      const response = await client.requestWithStatus<unknown>("GET", path);
      if (response.status === 404) continue;
      if (response.status < 200 || response.status >= 300) {
        const message = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
        throw new Error(`${response.status} GET ${path}: ${message}`);
      }
      if (response.data && typeof response.data === "object" && !Array.isArray(response.data)) {
        bundle.dashboards.push({ ...(response.data as Record<string, unknown>), __type: "dashboard-v2" });
      }
    }
    return bundle;
  };

  const exportCommand = new Command("export")
    .description("Export remote Grafana resources into local split JSON files")
    .option("-o, --out <dir>", "output directory", "./grafana-export")
    .option(
      "-r, --resources <list>",
      "comma-separated resources: dashboards,datasources,folders,alert-rules,contact-points,policies",
    )
    .option("--dashboard-api <mode>", "dashboard export API: classic|v2", "classic")
    .option("--compact", "write compact json")
    .action(async function exportAction(options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resources = parseResources(options.resources);
      const dashboardApiMode = parseDashboardApiMode(options.dashboardApi, "classic");
      const dashboardApi = dashboardApiMode === "v2" ? "v2" : "classic";
      const outDir = path.resolve(options.out);

      const client = new GrafanaClient(ctx);
      const bundle = await fetchResources(client, resources, { dashboardApi });
      bundle.context = ctx.contextName;

      bundleToFiles(outDir, bundle, !options.compact);
      printData(ctx, "export-complete", {
        resources,
        outputDir: outDir,
        message: `Exported resources: ${resources.join(",")}\nOutput directory: ${outDir}`,
      });
    });

  const pullCommand = new Command("pull")
    .argument("<file>", "local JSON file to refresh from remote")
    .description("Pull remote resource into one local JSON file")
    .option(
      "-t, --type <type>",
      "fallback type when JSON has no __type (dashboard|connection|folder|alert-rule|contact-point|policy)",
    )
    .option("--id <id>", "resource id selector")
    .option("--uid <uid>", "resource uid selector")
    .option("--match-name <name>", "resource name selector")
    .option("--title <title>", "resource title selector")
    .option("-w, --where <expr>", "filter path=value, repeatable", collectList, [])
    .option("--dashboard-api <mode>", "dashboard pull API: auto|classic|v2", "auto")
    .option("--compact", "write compact json")
    .action(async function pullAction(file: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const resolvedFile = path.resolve(file);
      const fallbackType = parseResourceAlias(options.type);
      if (options.type && !fallbackType) {
        throw new Error(`Unsupported --type: ${options.type}`);
      }
      if (!fs.existsSync(resolvedFile) && !fallbackType) {
        throw new Error("pull <file> needs an existing typed JSON file or --type with selector flags");
      }

      const localBundle = fs.existsSync(resolvedFile)
        ? collectBundle([resolvedFile], fallbackType)
        : undefined;
      const localResources = localBundle ? bundleResources(localBundle) : [];
      const resource = fallbackType || localResources[0];
      if (!resource) throw new Error("Cannot infer resource type for pull target. Use --type.");
      if (localResources.length > 1 && !fallbackType) {
        throw new Error("Pull target contains multiple resource types. Use --type.");
      }

      const localItem = localBundle ? resourceItems(localBundle, resource)[0] : undefined;
      const localObject =
        localItem && typeof localItem === "object" ? (localItem as Record<string, unknown>) : undefined;
      const localMetadata =
        localObject?.metadata && typeof localObject.metadata === "object"
          ? (localObject.metadata as Record<string, unknown>)
          : undefined;
      const localSpec =
        localObject?.spec && typeof localObject.spec === "object"
          ? (localObject.spec as Record<string, unknown>)
          : undefined;
      const selector: ResourceSelector = ResourceSelectorSchema.parse({
        id: options.id,
        uid:
          options.uid ||
          (localObject ? String(localObject.uid || localMetadata?.name || "") || undefined : undefined),
        name:
          options.matchName ||
          (localObject ? String(localObject.name || localMetadata?.name || "") || undefined : undefined),
        title:
          options.title ||
          (localObject ? String(localObject.title || localSpec?.title || "") || undefined : undefined),
        where: options.where || [],
      });

      const client = new GrafanaClient(ctx);
      const dashboardApiMode = parseDashboardApiMode(options.dashboardApi, "auto");
      let selected: unknown;
      if (resource === "dashboards" && dashboardApiMode === "auto") {
        const preferV2 = localObject ? isDashboardResourceV2(localObject) : false;
        try {
          const v2Bundle = await fetchResources(client, [resource], { dashboardApi: "v2" });
          const selectedV2 = selectResource(resourceItems(v2Bundle, resource), resource, selector, true);
          if (selectedV2 && (preferV2 || dashboardResourceV2HasTabs(selectedV2 as Record<string, unknown>))) {
            selected = selectedV2;
          }
        } catch (error) {
          if (preferV2) throw error;
        }
      }
      if (!selected) {
        const dashboardApi = dashboardApiMode === "v2" ? "v2" : "classic";
        const remoteBundle = await fetchResources(client, [resource], { dashboardApi });
        selected = selectResource(resourceItems(remoteBundle, resource), resource, selector, false);
      }
      writeJson(resolvedFile, selected, !options.compact);
      printData(ctx, "pull-complete", {
        resource,
        file: resolvedFile,
        message: `Pulled ${resource} -> ${resolvedFile}`,
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
    .option("--overwrite", "overwrite existing dashboards when importing", true)
    .option("--no-overwrite", "do not overwrite existing dashboards")
    .option("--skip-promql-check", "skip local PromQL syntax checks before importing dashboards")
    .option("--promql-macro-mode <mode>", "PromQL Grafana macro handling: keep|preset|eval|strict", "keep")
    .action(async function importAction(sources: string[] | undefined, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
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
      const resources = options.resources ? parseResources(options.resources) : bundleResources(merged);
      if (resources.length === 0) throw new Error("No importable resources found in sources");
      merged.resources = dedupeResources(resources);
      if (resources.includes("dashboards") && !options.skipPromqlCheck) {
        const promqlErrors = validateDashboardPromQLSyntax(collectDashboards(merged), {
          macroMode: parseGrafanaPromQLMacroMode(options.promqlMacroMode),
        });
        if (promqlErrors.length > 0) {
          throw new Error(
            `PromQL syntax check failed before import: ${promqlErrors
              .slice(0, 3)
              .map((item) => `${item.dashboardTitle} / ${item.panelTitle} / ${item.refId}: ${item.message}`)
              .join("; ")}${promqlErrors.length > 3 ? `; ... ${promqlErrors.length - 3} more` : ""}`,
          );
        }
      }

      await importResources(ctx, merged, resources, { overwrite: options.overwrite });
      const importedCount = resources.reduce(
        (sum, resource) => sum + resourceItems(merged, resource).length,
        0,
      );
      printData(ctx, "import-complete", {
        resources,
        input: resolvedSources,
        dryRun: ctx.dryRun,
        imported: importedCount,
        updated: ctx.dryRun ? 0 : importedCount,
        unchanged: 0,
        failed: 0,
        message: `Imported resources: ${resources.join(",")}\nInput: ${resolvedSources.join(", ")}\nImported: ${ctx.dryRun ? 0 : importedCount} updated, 0 unchanged, 0 failed`,
      });
      if (ctx.dryRun) printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
    });

  const pushCommand = new Command("push")
    .argument("[sources...]", "source JSON files/directories")
    .description("Push local JSON files/directories to remote Grafana (alias of import)")
    .option(
      "-r, --resources <list>",
      "comma-separated resources: dashboards,datasources,folders,alert-rules,contact-points,policies",
    )
    .option(
      "-t, --type <type>",
      "fallback type when JSON has no __type (dashboard|connection|folder|alert-rule|contact-point|policy)",
    )
    .option("--overwrite", "overwrite existing dashboards when pushing", true)
    .option("--no-overwrite", "do not overwrite existing dashboards")
    .option("--skip-promql-check", "skip local PromQL syntax checks before pushing dashboards")
    .option("--promql-macro-mode <mode>", "PromQL Grafana macro handling: keep|preset|eval|strict", "keep")
    .action(async function pushAction(sources: string[] | undefined, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
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
      const resources = options.resources ? parseResources(options.resources) : bundleResources(merged);
      if (resources.length === 0) throw new Error("No pushable resources found in sources");
      merged.resources = dedupeResources(resources);
      if (resources.includes("dashboards") && !options.skipPromqlCheck) {
        const promqlErrors = validateDashboardPromQLSyntax(collectDashboards(merged), {
          macroMode: parseGrafanaPromQLMacroMode(options.promqlMacroMode),
        });
        if (promqlErrors.length > 0) {
          throw new Error(
            `PromQL syntax check failed before push: ${promqlErrors
              .slice(0, 3)
              .map((item) => `${item.dashboardTitle} / ${item.panelTitle} / ${item.refId}: ${item.message}`)
              .join("; ")}${promqlErrors.length > 3 ? `; ... ${promqlErrors.length - 3} more` : ""}`,
          );
        }
      }

      await importResources(ctx, merged, resources, { overwrite: options.overwrite });
      const pushedCount = resources.reduce(
        (sum, resource) => sum + resourceItems(merged, resource).length,
        0,
      );
      printData(ctx, "push-complete", {
        resources,
        input: resolvedSources,
        dryRun: ctx.dryRun,
        imported: pushedCount,
        updated: ctx.dryRun ? 0 : pushedCount,
        unchanged: 0,
        failed: 0,
        message: `Pushed resources: ${resources.join(",")}\nInput: ${resolvedSources.join(", ")}\nImported: ${ctx.dryRun ? 0 : pushedCount} updated, 0 unchanged, 0 failed`,
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
    .option("--local-only", "only compare resources present in the local input")
    .option("--dashboard-api <mode>", "dashboard diff API: auto|classic|v2", "auto")
    .option("--json", "print full diff as JSON")
    .action(async function diffAction(options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const inPath = path.resolve(options.in);
      const dashboardApiMode = parseDashboardApiMode(options.dashboardApi, "auto");
      const client = new GrafanaClient(ctx);

      const dashboardApiForLocal = (localBundle: ExportBundle): "classic" | "v2" => {
        if (dashboardApiMode === "v2") return "v2";
        if (dashboardApiMode === "classic") return "classic";
        return resourceItems(localBundle, "dashboards").some((item) => isDashboardResourceV2(item))
          ? "v2"
          : "classic";
      };

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
        const localItems = resourceItems(localBundle, resource);
        const dashboardApi = resource === "dashboards" ? dashboardApiForLocal(localBundle) : undefined;
        const localItem = selectResource(localItems, resource, selector, true);
        const remoteBundle =
          resource === "dashboards" && dashboardApi === "v2" && localItem
            ? await fetchDashboardV2LocalSubset(client, [localItem])
            : await fetchResources(client, [resource], dashboardApi ? { dashboardApi } : undefined);

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
      const resources = options.resources
        ? parseResources(options.resources)
        : options.localOnly
          ? bundleResources(local)
          : parseResources(undefined);
      const dashboardApi = dashboardApiForLocal(local);
      let remote: ExportBundle;
      if (options.localOnly && resources.includes("dashboards") && dashboardApi === "v2") {
        const otherResources = resources.filter((resource) => resource !== "dashboards");
        remote =
          otherResources.length > 0
            ? await fetchResources(client, otherResources, { dashboardApi })
            : createEmptyBundle();
        remote.resources = resources;
        remote.dashboards = (
          await fetchDashboardV2LocalSubset(client, resourceItems(local, "dashboards"))
        ).dashboards;
      } else {
        remote = await fetchResources(client, resources, { dashboardApi });
      }
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
        result[resource] = diffArray(resource, localData || [], remoteData || [], {
          localOnly: Boolean(options.localOnly),
        });
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

  return [exportCommand, pullCommand, importCommand, pushCommand, diffCommand];
}
