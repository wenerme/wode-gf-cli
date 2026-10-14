import { buildAlertCommand, buildSilenceCommand } from "./build-alertmanager";
import { buildDashboardCommand } from "./mutate/build-dashboard";
import { buildFolderCommand } from "./mutate/build-folder";
import { buildRootCommands } from "./mutate/build-root";
import {
  buildAlertRuleCommand,
  buildConnectionCommand,
  buildContactPointCommand,
  buildPolicyCommand,
} from "./mutate/build-scoped";
import type { CommandAppContext } from "./runtime";

export function buildMutateCommands(app: CommandAppContext) {
  return [
    ...buildRootCommands(app),
    buildDashboardCommand(app),
    buildConnectionCommand(app),
    buildFolderCommand(app),
    buildAlertRuleCommand(app),
    buildContactPointCommand(app),
    buildPolicyCommand(app),
    buildAlertCommand(app),
    buildSilenceCommand(app),
  ];
}
