import path from "node:path";
import { Command } from "commander";
import { ValidateOptionsSchema } from "../schema";
import { parsePositiveInt, parseSkipPanelIds, parseVarAssignments } from "../utils";
import type { CommandAppContext, ValidateIssue } from "./runtime";

export function buildValidateCommand(app: CommandAppContext) {
  const { collectList, runtime } = app;
  const { parseCommonOptions, collectBundle, collectDashboards, validateDashboards, printMessage } = runtime;

  return new Command("validate")
    .argument("[sources...]", "source files/directories")
    .description("Validate dashboard queries via Grafana /api/ds/query")
    .option("--skip-panel-ids <ids>", "comma-separated panel ids to skip")
    .option("--from <time>", "query time start", "now-1h")
    .option("--to <time>", "query time end", "now")
    .option("--timeout <ms>", "request timeout milliseconds for validate", "60000")
    .option("--interval-ms <ms>", "grafana built-in interval in milliseconds", "60000")
    .option("--concurrency <n>", "request concurrency", "4")
    .option("--fail-fast", "stop when first validation error found")
    .option("--var <expr>", "variable override key=value, repeatable", collectList, [])
    .action(async function validateAction(sources: string[] | undefined, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const sourceList = sources && sources.length > 0 ? sources : ["./grafana/"];
      const resolvedSources = sourceList.map((source) => path.resolve(source));
      const parsedOptions = ValidateOptionsSchema.parse({
        from: String(options.from || "now-1h").trim(),
        to: String(options.to || "now").trim(),
        timeoutMs: parsePositiveInt(options.timeout, 60_000),
        intervalMs: parsePositiveInt(options.intervalMs, 60_000),
        concurrency: parsePositiveInt(options.concurrency, 4),
        skipPanelIds: parseSkipPanelIds(options.skipPanelIds),
        failFast: Boolean(options.failFast),
        vars: options.var || [],
      });

      const bundle = collectBundle(resolvedSources, "dashboards");
      const dashboards = collectDashboards(bundle);
      const varOverrides = parseVarAssignments(parsedOptions.vars);

      const { errors, warnings } = await validateDashboards(ctx, dashboards, {
        from: parsedOptions.from,
        to: parsedOptions.to,
        timeoutMs: parsedOptions.timeoutMs,
        intervalMs: parsedOptions.intervalMs,
        concurrency: parsedOptions.concurrency,
        failFast: parsedOptions.failFast,
        skipPanelIds: parsedOptions.skipPanelIds,
        vars: varOverrides,
      });

      const dashboardGroups = new Map<string, ValidateIssue[]>();
      for (const err of errors) {
        const list = dashboardGroups.get(err.dashboardTitle) || [];
        list.push(err);
        dashboardGroups.set(err.dashboardTitle, list);
      }

      for (const [dashboardTitle, items] of dashboardGroups.entries()) {
        const totalPanels = new Set(items.map((item) => item.panelId)).size;
        printMessage(ctx, `[ERROR] Dashboard: ${dashboardTitle}`);
        for (const item of items) {
          printMessage(
            ctx,
            `  Panel: ${item.panelTitle} (id=${item.panelId}) / refId=${item.refId}\n  Error: ${item.message}`,
          );
        }
        printMessage(ctx, `  Summary: ${items.length} errors across ${totalPanels} panels`);
      }

      const okDashboards = dashboards.length - dashboardGroups.size;
      if (okDashboards > 0) {
        printMessage(ctx, `[OK] ${okDashboards} dashboards passed validation`);
      }

      for (const warning of warnings) {
        printMessage(
          ctx,
          `[WARN] Dashboard: ${warning.dashboardTitle} / Panel: ${warning.panelTitle} (id=${warning.panelId}) / refId=${warning.refId} / ${warning.message}`,
        );
      }

      if (errors.length > 0) {
        process.exitCode = 1;
        return;
      }
      if (warnings.length > 0) {
        process.exitCode = 2;
      }
    });
}
