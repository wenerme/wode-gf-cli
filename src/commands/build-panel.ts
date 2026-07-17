import { Command } from "commander";
import { addPanelEditCommand, addPanelLegendPresetCommand, addPanelPatchCommand } from "./panel/mutate";
import { addPanelGetCommand, addPanelInspectCommand, addPanelListCommand } from "./panel/read";
import { addPanelRenderCommand, addPanelValidateCommand } from "./panel/validate-render";
import type { CommandAppContext } from "./runtime";

export { replacePanelInDashboard } from "../lib/panel-tree";
export {
  normalizeRefIds,
  parsePanelRef,
  targetHasValidationQuery,
} from "./panel/model";

export function buildPanelCommand(app: CommandAppContext): Command {
  const panelCommand = new Command("panel")
    .alias("p")
    .description("inspect, edit, patch, and render dashboard panels");

  addPanelListCommand(panelCommand, app);
  addPanelGetCommand(panelCommand, app);
  addPanelInspectCommand(panelCommand, app);
  addPanelPatchCommand(panelCommand, app);
  addPanelEditCommand(panelCommand, app);
  addPanelValidateCommand(panelCommand, app);
  addPanelLegendPresetCommand(panelCommand, app);
  addPanelRenderCommand(panelCommand, app);

  return panelCommand;
}
