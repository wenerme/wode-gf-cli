import path from "node:path";
import type { Command } from "commander";
import { asObjectArray, asString } from "../../lib/json-narrow";
import { findPanel } from "../../lib/panel-tree";
import { parseGrafanaPromQLMacroMode } from "../../promql/grafana";
import { buildRenderPanelPath, parsePositiveInt, parseRenderScale } from "../../utils";
import type { CommandAppContext } from "../runtime";
import { loadDashboardSelection, renderPanelImage } from "./io";
import { normalizeRefIds, parsePanelRef, targetHasValidationQuery } from "./model";

type ValidateOptions = {
  from?: string;
  to?: string;
  timeout?: string;
  intervalMs?: string;
  refId?: string[];
  failFast?: boolean;
  promqlMacroMode?: string;
  var?: string[];
};
type RenderOptions = {
  out: string;
  from?: string;
  to?: string;
  width?: string;
  height?: string;
  scale?: string;
  hdpi?: boolean;
  renderParam?: string[];
  tz?: string;
  theme?: string;
  renderTimeout?: string;
  var?: string[];
};

export function addPanelValidateCommand(panelCommand: Command, app: CommandAppContext): void {
  const { collectList, runtime } = app;
  panelCommand
    .command("validate <REF>")
    .description("Validate one panel's queries by DASH/PANEL")
    .option("--from <time>", "query time start", "now-1h")
    .option("--to <time>", "query time end", "now")
    .option("--timeout <ms>", "request timeout milliseconds for validate", "60000")
    .option("--interval-ms <ms>", "grafana built-in interval in milliseconds", "60000")
    .option("--ref-id <id>", "only validate query refId, repeatable", collectList, [])
    .option("--fail-fast", "stop when first validation error found")
    .option("--promql-macro-mode <mode>", "PromQL Grafana macro handling: keep|preset|eval|strict", "keep")
    .option("--var <expr>", "variable override key=value, repeatable", collectList, [])
    .action(async function panelValidateAction(ref: string, options: ValidateOptions) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const parsed = parsePanelRef(ref);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      const panel = findPanel(selection.dashboard, parsed.panelId).panel;
      const onlyRefIds = normalizeRefIds(options.refId);
      if (onlyRefIds.length > 0) {
        const targets = asObjectArray(panel.targets).map((target, index) => ({
          refId: asString(target.refId) || String.fromCharCode(65 + index),
          target,
        }));
        const availableRefIds = targets.map((target) => target.refId);
        const missing = onlyRefIds.filter((refId) => !availableRefIds.includes(refId));
        if (missing.length > 0) {
          throw new Error(
            `Panel ${ref} does not contain refId(s): ${missing.join(", ")}. Available: ${availableRefIds.join(", ") || "(none)"}`,
          );
        }
        const unsupported = targets
          .filter((target) => onlyRefIds.includes(target.refId) && !targetHasValidationQuery(target.target))
          .map((target) => target.refId);
        if (unsupported.length > 0) {
          throw new Error(`Panel ${ref} refId(s) have no supported query body: ${unsupported.join(", ")}`);
        }
      }
      const varOverrides = Object.fromEntries(
        (options.var || []).map((expr) => {
          const index = expr.indexOf("=");
          if (index <= 0) throw new Error(`Invalid --var expression: ${expr}. Expect key=value`);
          return [expr.slice(0, index).trim(), expr.slice(index + 1)];
        }),
      );
      const { errors, warnings } = await runtime.validateDashboards(
        ctx,
        [
          {
            ...selection.wrapper,
            dashboard: selection.dashboard,
            title: selection.title,
            uid: selection.uid,
          },
        ],
        {
          from: String(options.from || "now-1h").trim(),
          to: String(options.to || "now").trim(),
          timeoutMs: parsePositiveInt(options.timeout, 60_000),
          intervalMs: parsePositiveInt(options.intervalMs, 60_000),
          concurrency: 1,
          failFast: Boolean(options.failFast),
          promqlMacroMode: parseGrafanaPromQLMacroMode(options.promqlMacroMode),
          skipPanelIds: [],
          onlyPanelIds: [parsed.panelId],
          onlyRefIds,
          vars: varOverrides,
        },
      );

      for (const error of errors) {
        runtime.printMessage(
          ctx,
          `[ERROR] Panel: ${error.panelTitle} (id=${error.panelId}) / refId=${error.refId}\n  Error: ${error.message}`,
        );
      }
      for (const warning of warnings) {
        runtime.printMessage(
          ctx,
          `[WARN] Panel: ${warning.panelTitle} (id=${warning.panelId}) / refId=${warning.refId} / ${warning.message}`,
        );
      }
      if (errors.length === 0 && warnings.length === 0) {
        runtime.printMessage(ctx, `[OK] panel ${ref} passed validation`);
      }
      if (errors.length > 0) {
        process.exitCode = 1;
        return;
      }
      if (warnings.length > 0) process.exitCode = 2;
    });
}

export function addPanelRenderCommand(panelCommand: Command, app: CommandAppContext): void {
  const { collectList, runtime } = app;
  panelCommand
    .command("render <REF>")
    .description("Render panel PNG by DASH/PANEL")
    .option("-o, --out <file>", "output PNG file", "local/panel.png")
    .option("--from <from>", "time range start", "now-6h")
    .option("--to <to>", "time range end", "now")
    .option("--width <px>", "render width", "1600")
    .option("--height <px>", "render height", "900")
    .option("--scale <factor>", "device scale factor / output pixel ratio")
    .option("--hdpi", "shortcut for --scale 2 when --scale is not set")
    .option("--render-param <expr>", "extra render URL parameter key=value, repeatable", collectList, [])
    .option("--tz <timezone>", "timezone", "UTC")
    .option("--theme <theme>", "light|dark", "light")
    .option("--render-timeout <ms>", "render request timeout milliseconds", "60000")
    .option("--var <expr>", "template variable key=value, repeatable", collectList, [])
    .action(async function panelRenderAction(ref: string, options: RenderOptions) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const parsed = parsePanelRef(ref);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      findPanel(selection.dashboard, parsed.panelId);
      const out = path.resolve(options.out);
      const renderTimeoutMs = parsePositiveInt(options.renderTimeout, 60_000);
      const renderPath = buildRenderPanelPath({
        dashboardUid: selection.uid,
        panelId: parsed.panelId,
        from: String(options.from || "now-6h").trim(),
        to: String(options.to || "now").trim(),
        width: parsePositiveInt(options.width, 1600),
        height: parsePositiveInt(options.height, 900),
        scale: parseRenderScale(options.scale, Boolean(options.hdpi)),
        tz: String(options.tz || "UTC").trim(),
        theme: String(options.theme || "light").trim() as "light" | "dark",
        vars: options.var || [],
        renderParams: options.renderParam || [],
      });
      if (ctx.dryRun) {
        runtime.printData(ctx, "dry-run", {
          action: "panel-render",
          ref,
          dashboardUid: selection.uid,
          panelId: parsed.panelId,
          renderPath,
          out,
          timeoutMs: renderTimeoutMs,
          message: `[DRY-RUN] panel render ${ref} -> ${out}`,
        });
        return;
      }

      const size = await renderPanelImage(ctx, renderPath, out, renderTimeoutMs, runtime);
      const noDataWarning = size < 20 * 1024;
      runtime.printData(ctx, "panel-render-complete", {
        ref,
        dashboardUid: selection.uid,
        panelId: parsed.panelId,
        out,
        size,
        possibleNoData: noDataWarning,
        message: `Rendered panel image: ${out} (${size} bytes)${noDataWarning ? `\n[WARN] possible NoData (file size: ${(size / 1024).toFixed(1)}KB)` : ""}`,
      });
    });
}
