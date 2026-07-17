import type { Command } from "commander";
import { asObjectArray, asString } from "../../lib/json-narrow";
import { findPanel, flattenPanels, panelNumberValue } from "../../lib/panel-tree";
import type { CommandAppContext } from "../runtime";
import { panelDatasources, panelInspectSummary, renderPanelInspectText } from "./inspect";
import { loadDashboardSelection } from "./io";
import { parsePanelRef } from "./model";

type ListOptions = { search?: string; json?: boolean };
type PathOptions = { path?: string };
type InspectOptions = PathOptions & { json?: boolean };

export function addPanelListCommand(panelCommand: Command, app: CommandAppContext): void {
  const { runtime } = app;
  panelCommand
    .command("list <DASH>")
    .description("List panels in dashboard")
    .option("--search <TERM>", "filter by id/title/type/datasource")
    .option("--json", "print panels as json")
    .action(async function panelListAction(dashboardRef: string, options: ListOptions) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const selection = await loadDashboardSelection(ctx, dashboardRef, runtime);
      const query = String(options.search || "")
        .trim()
        .toLowerCase();
      const rows = flattenPanels(selection.dashboard.panels)
        .map((match) => {
          const id = String(panelNumberValue(match.panel.id) ?? "");
          const title = asString(match.panel.title) || "";
          const type = asString(match.panel.type) || "";
          const datasource = panelDatasources(match.panel).join(", ");
          return {
            id,
            title,
            type,
            datasource,
            targets: String(asObjectArray(match.panel.targets).length),
            path: match.path,
            raw: match.panel,
          };
        })
        .filter((row) => {
          if (!query) return true;
          return [row.id, row.title, row.type, row.datasource].some((value) =>
            value.toLowerCase().includes(query),
          );
        });

      if (options.json || ctx.output === "json") {
        console.log(
          JSON.stringify(
            rows.map((row) => ({ ...row, raw: row.raw })),
            null,
            2,
          ),
        );
        return;
      }
      runtime.printMessage(
        ctx,
        runtime.renderTable(
          ["id", "title", "type", "datasource", "targets", "path"],
          rows.map((row) => [row.id, row.title, row.type, row.datasource, row.targets, row.path]),
        ),
      );
    });
}

export function addPanelGetCommand(panelCommand: Command, app: CommandAppContext): void {
  const { runtime } = app;
  panelCommand
    .command("get <REF>")
    .alias("read")
    .description("Get/read panel JSON by DASH/PANEL")
    .option("--path <path>", "value path (dot / [index])")
    .action(async function panelGetAction(ref: string, options: PathOptions) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const parsed = parsePanelRef(ref);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      const match = findPanel(selection.dashboard, parsed.panelId);
      console.log(JSON.stringify(runtime.getPathValue(match.panel, options.path), null, 2));
    });
}

export function addPanelInspectCommand(panelCommand: Command, app: CommandAppContext): void {
  const { runtime } = app;
  panelCommand
    .command("inspect <REF>")
    .description("Inspect panel summary by DASH/PANEL")
    .option("--path <path>", "value path (dot / [index])")
    .option("--json", "print summary/path as json")
    .action(async function panelInspectAction(ref: string, options: InspectOptions) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const parsed = parsePanelRef(ref);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      const match = findPanel(selection.dashboard, parsed.panelId);
      if (options.path) {
        console.log(JSON.stringify(runtime.getPathValue(match.panel, options.path), null, 2));
        return;
      }
      const summary = panelInspectSummary(selection, match);
      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      runtime.printMessage(ctx, renderPanelInspectText(summary));
    });
}
