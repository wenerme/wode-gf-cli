import type { Command } from "commander";
import { asString, getObjectField } from "../../lib/json-narrow";
import { applyLegendPresetToDashboard, parsePanelIds } from "../../lib/panel-legend";
import { clonePanelJson, findPanel, type PanelJsonObject } from "../../lib/panel-tree";
import type { CliContext, CommandAppContext } from "../runtime";
import {
  applyPanelUpdate,
  editJson,
  fileExists,
  loadDashboardSelection,
  readJsonFile,
  resolveFile,
  writeJsonFile,
} from "./io";
import { assertPanelId, assertPanelObject, parsePanelRef } from "./model";

type PatchOptions = {
  path?: string;
  set?: string[];
  merge?: string;
  from?: string;
  json?: boolean;
};
type EditOptions = { path?: string; editor?: string; json?: boolean };
type LegendOptions = {
  panelId?: string;
  rightTable?: boolean;
  meanDesc?: boolean;
  calcs?: string;
  json?: boolean;
};
type LegendResult = {
  panelId: number;
  panelTitle: string;
  status: string;
  message: string;
};

function printLegendPresetResult(
  ctx: CliContext,
  results: LegendResult[],
  json: boolean,
  printMessage: CommandAppContext["runtime"]["printMessage"],
): void {
  if (json || ctx.output === "json") {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }
  for (const result of results) {
    const level = result.status === "updated" || result.status === "unchanged" ? "OK" : "WARN";
    printMessage(ctx, `[${level}] panel ${result.panelId} ${result.panelTitle}: ${result.message}`);
  }
  if (ctx.dryRun) printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
}

export function addPanelPatchCommand(panelCommand: Command, app: CommandAppContext): void {
  const { collectList, runtime } = app;
  panelCommand
    .command("patch <REF>")
    .description("Patch panel JSON by DASH/PANEL")
    .option("--path <path>", "default path for value-only --set")
    .option("-s, --set <expr>", "patch expression path=value, repeatable", collectList, [])
    .option("--merge <json>", "deep merge JSON object into selected panel")
    .option("--from <file>", "replace selected panel with this JSON file content")
    .option("--json", "print patched panel json")
    .action(async function panelPatchAction(ref: string, options: PatchOptions) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const parsed = parsePanelRef(ref);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      const match = findPanel(selection.dashboard, parsed.panelId);
      let updated: unknown = clonePanelJson(match.panel);

      if (options.from) updated = readJsonFile(String(options.from));
      if (options.merge) {
        const patchObj = runtime.parseJsonLike(String(options.merge));
        if (!patchObj || typeof patchObj !== "object" || Array.isArray(patchObj)) {
          throw new Error("--merge requires a JSON object");
        }
        updated = runtime.deepMerge(updated, patchObj);
      }
      for (const expr of options.set || []) {
        const { path: setPath, value } = runtime.parseSetExpr(String(expr), options.path);
        const panel = assertPanelObject(updated);
        runtime.setPathValue(panel, setPath, value);
        updated = panel;
      }
      if ((options.set || []).length === 0 && !options.merge && !options.from) {
        throw new Error("No patch operation provided. Use --set, --merge, or --from.");
      }

      const updatedPanel = assertPanelObject(updated);
      assertPanelId(updatedPanel, parsed.panelId);
      await applyPanelUpdate(ctx, selection, parsed.panelId, updatedPanel, runtime);
      if (options.json || ctx.output === "json" || ctx.dryRun) {
        console.log(JSON.stringify(updatedPanel, null, 2));
      }
      runtime.printMessage(ctx, `Patched panel ${ref}.`);
      if (ctx.dryRun) runtime.printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
    });
}

export function addPanelEditCommand(panelCommand: Command, app: CommandAppContext): void {
  const { runtime } = app;
  panelCommand
    .command("edit <REF>")
    .description(
      "Open panel JSON/path in $EDITOR and apply it back to dashboard; use --editor in non-interactive shells",
    )
    .option("--path <path>", "edit only this panel JSON path")
    .option("--editor <cmd>", "editor command", process.env.VISUAL || process.env.EDITOR || "vi")
    .option("--json", "print edited panel json")
    .action(async function panelEditAction(ref: string, options: EditOptions) {
      const command = this as unknown as Command;
      const ctx = runtime.parseCommonOptions(command);
      const parsed = parsePanelRef(ref);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      const match = findPanel(selection.dashboard, parsed.panelId);
      const beforeHash = runtime.hashObject(match.panel);
      const editPath = asString(options.path);
      const editTarget = editPath ? runtime.getPathValue(match.panel, editPath) : match.panel;
      const editor = String(options.editor || "").trim() || "vi";
      const editorSource = command.getOptionValueSource("editor");
      if (!process.stdin.isTTY && editorSource !== "cli") {
        throw new Error(
          "panel edit opens an editor; in non-interactive shells use --editor <cmd> or use p patch --from <file>",
        );
      }
      const editedJson = editJson(editTarget, parsed.panelId, editor, runtime);
      const editedPanel = editPath
        ? (() => {
            const nextPanel = clonePanelJson(match.panel);
            runtime.setPathValue(nextPanel, editPath, editedJson);
            return nextPanel;
          })()
        : assertPanelObject(editedJson);
      assertPanelId(editedPanel, parsed.panelId);
      if (runtime.hashObject(editedPanel) === beforeHash) {
        runtime.printMessage(ctx, `Panel ${ref} unchanged.`);
        return;
      }
      await applyPanelUpdate(ctx, selection, parsed.panelId, editedPanel, runtime);
      if (options.json || ctx.output === "json" || ctx.dryRun) {
        console.log(JSON.stringify(editedPanel, null, 2));
      }
      runtime.printMessage(ctx, `Edited panel ${ref}.`);
      if (ctx.dryRun) runtime.printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
    });
}

export function addPanelLegendPresetCommand(panelCommand: Command, app: CommandAppContext): void {
  const { runtime } = app;
  panelCommand
    .command("legend-preset <TARGET>")
    .description("Apply common timeseries legend preset to remote panel ref or local dashboard JSON")
    .option("--panel-id <ids>", "panel id(s) for local dashboard JSON, comma-separated")
    .option("--right-table", "place legend table on the right")
    .option("--mean-desc", "sort by Mean descending")
    .option("--calcs <list>", "comma-separated calcs", "mean,max,sum")
    .option("--json", "print result as json")
    .action(async function panelLegendPresetAction(target: string, options: LegendOptions) {
      const local = fileExists(target);
      const ctx = runtime.parseCommonOptions(this as unknown as Command, {
        requireUrl: !local,
      });
      const calcs = String(options.calcs || "mean,max,sum")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (calcs.length === 0) throw new Error("--calcs must contain at least one calculation");

      if (local) {
        const file = resolveFile(target);
        const root = readJsonFile(file) as PanelJsonObject;
        const dashboard = getObjectField(root, "dashboard") || root;
        const panelIds = parsePanelIds(options.panelId);
        if (panelIds.length === 0) throw new Error("local dashboard legend-preset requires --panel-id");
        const result = applyLegendPresetToDashboard(dashboard, panelIds, {
          calcs,
          rightTable: Boolean(options.rightTable),
          meanDesc: Boolean(options.meanDesc),
        });
        const output = getObjectField(root, "dashboard")
          ? { ...root, dashboard: result.dashboard }
          : result.dashboard;
        if (!ctx.dryRun) writeJsonFile(file, output);
        printLegendPresetResult(ctx, result.results, Boolean(options.json), runtime.printMessage);
        if (result.results.some((item) => item.status === "skip")) process.exitCode = 2;
        return;
      }

      const parsed = parsePanelRef(target);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      const result = applyLegendPresetToDashboard(selection.dashboard, [parsed.panelId], {
        calcs,
        rightTable: Boolean(options.rightTable),
        meanDesc: Boolean(options.meanDesc),
      });
      await applyPanelUpdate(
        ctx,
        selection,
        parsed.panelId,
        findPanel(result.dashboard, parsed.panelId).panel,
        runtime,
      );
      printLegendPresetResult(ctx, result.results, Boolean(options.json), runtime.printMessage);
      if (result.results.some((item) => item.status === "skip")) process.exitCode = 2;
    });
}
