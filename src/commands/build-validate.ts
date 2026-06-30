import path from "node:path";
import { Command } from "commander";
import { ValidateOptionsSchema } from "../schema";
import { parsePositiveInt, parseSkipPanelIds, parseVarAssignments } from "../utils";
import { validateAlertRules } from "./build-alert-ops";
import type { CommandAppContext, ValidateIssue } from "./runtime";

export function buildValidateCommand(app: CommandAppContext) {
  const { collectList, runtime } = app;
  const {
    parseCommonOptions,
    collectBundle,
    collectDashboards,
    resourceItems,
    validateDashboards,
    printMessage,
  } = runtime;

  return new Command("validate")
    .argument("[sources...]", "source files/directories")
    .description("Validate dashboard queries via Grafana /api/ds/query")
    .option("--skip-panel-ids <ids>", "comma-separated panel ids to skip")
    .option("--datasource-type <type>", "only validate datasource type, repeatable", collectList, [])
    .option("--skip-type <type>", "skip datasource type, repeatable", collectList, [])
    .option("--from <time>", "query time start", "now-1h")
    .option("--to <time>", "query time end", "now")
    .option("--timeout <ms>", "request timeout milliseconds for validate", "60000")
    .option("--interval-ms <ms>", "grafana built-in interval in milliseconds", "60000")
    .option("--concurrency <n>", "request concurrency", "4")
    .option("--fail-fast", "stop when first validation error found")
    .option("--syntax-only", "only run local syntax checks; do not call Grafana /api/ds/query")
    .option("--promql-macro-mode <mode>", "PromQL Grafana macro handling: keep|preset|eval|strict", "keep")
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
        datasourceTypes: options.datasourceType || [],
        skipTypes: options.skipType || [],
        failFast: Boolean(options.failFast),
        syntaxOnly: Boolean(options.syntaxOnly),
        promqlMacroMode: options.promqlMacroMode,
        vars: options.var || [],
      });

      const bundle = collectBundle(resolvedSources);
      const dashboards = collectDashboards(bundle);
      const alertRules = resourceItems(bundle, "alert-rules") as Array<Record<string, unknown>>;
      const varOverrides = parseVarAssignments(parsedOptions.vars);

      const { errors, warnings } =
        dashboards.length > 0
          ? await validateDashboards(ctx, dashboards, {
              from: parsedOptions.from,
              to: parsedOptions.to,
              timeoutMs: parsedOptions.timeoutMs,
              intervalMs: parsedOptions.intervalMs,
              concurrency: parsedOptions.concurrency,
              failFast: parsedOptions.failFast,
              syntaxOnly: parsedOptions.syntaxOnly,
              promqlMacroMode: parsedOptions.promqlMacroMode,
              skipPanelIds: parsedOptions.skipPanelIds,
              datasourceTypes: parsedOptions.datasourceTypes,
              skipTypes: parsedOptions.skipTypes,
              vars: varOverrides,
            })
          : { errors: [], warnings: [] };

      const alertValidation =
        alertRules.length > 0
          ? await validateAlertRules(ctx, alertRules, runtime, {
              from: parsedOptions.from,
              to: parsedOptions.to,
              timeoutMs: parsedOptions.timeoutMs,
              intervalMs: parsedOptions.intervalMs,
              maxDataPoints: 1_000,
              vars: varOverrides,
            })
          : { results: [], refIssues: [] };

      const dashboardGroups = new Map<string, ValidateIssue[]>();
      for (const err of errors) {
        const list = dashboardGroups.get(err.dashboardTitle) || [];
        list.push(err);
        dashboardGroups.set(err.dashboardTitle, list);
      }

      for (const [dashboardTitle, items] of dashboardGroups.entries()) {
        const totalPanels = new Set(items.map((item) => item.panelId)).size;
        const sourceFiles = Array.from(new Set(items.map((item) => item.sourceFile).filter(Boolean)));
        printMessage(ctx, `[ERROR] Dashboard: ${dashboardTitle}`);
        if (sourceFiles.length > 0) printMessage(ctx, `  File: ${sourceFiles.join(", ")}`);
        for (const item of items) {
          const location = [
            item.sourceFile ? `file=${item.sourceFile}` : undefined,
            `panel=${item.panelTitle}`,
            `id=${item.panelId}`,
            `refId=${item.refId}`,
            item.datasourceUid ? `ds=${item.datasourceUid}` : undefined,
            item.datasourceType ? `type=${item.datasourceType}` : undefined,
          ]
            .filter(Boolean)
            .join(" / ");
          printMessage(
            ctx,
            `  ${location}\n  ERROR: ${item.kind === "promql-syntax" ? "promql syntax" : "query error"} — ${item.message}`,
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
          `[WARN] Dashboard: ${warning.dashboardTitle}${warning.sourceFile ? ` / File: ${warning.sourceFile}` : ""} / Panel: ${warning.panelTitle} (id=${warning.panelId}) / refId=${warning.refId}${warning.datasourceUid ? ` / ds=${warning.datasourceUid}` : ""}${warning.datasourceType ? ` / type=${warning.datasourceType}` : ""} / ${warning.kind === "no-data" ? `WARN: no data returned` : warning.message}`,
        );
      }

      for (const issue of alertValidation.refIssues) {
        printMessage(ctx, `[ERROR] AlertRule: ${issue.rule} / ${issue.message}`);
      }
      for (const result of alertValidation.results) {
        const level = result.status === "ok" ? "OK" : result.status === "error" ? "ERROR" : "WARN";
        printMessage(ctx, `[${level}] AlertRule: ${result.rule} / refId=${result.refId} / ${result.message}`);
      }

      const hasAlertErrors =
        alertValidation.refIssues.length > 0 ||
        alertValidation.results.some((item) => item.status === "error");
      const hasAlertWarnings = alertValidation.results.some(
        (item) => item.status === "no-data" || item.status === "skip",
      );

      if (errors.length > 0 || hasAlertErrors) {
        process.exitCode = 1;
        return;
      }
      if (warnings.length > 0 || hasAlertWarnings) {
        process.exitCode = 2;
      }
    });
}
