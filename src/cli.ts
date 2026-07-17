import { createCommand } from "./command";
import { buildApiCommand } from "./commands/build-api";
import { buildContextAuthCommands } from "./commands/build-context-auth";
import { buildListAndRenderCommands } from "./commands/build-list-render";
import { buildMutateCommands } from "./commands/build-mutate";
import { buildPanelCommand } from "./commands/build-panel";
import { buildQueryCommand } from "./commands/build-query";
import { buildSyncCommands } from "./commands/build-sync";
import { buildValidateCommand } from "./commands/build-validate";
import type { CliRuntime, CommandAppContext } from "./commands/runtime";
import { parseCommonOptions } from "./config/context";
import { loadEnv, parseEnvFile } from "./config/env";
import {
  findGitRoot,
  getConfigPath,
  getProjectConfigPath,
  migrateLegacyConfig,
  parseSimpleYamlConfig,
  readCliConfig,
  readProjectCliConfig,
  resolveContextName,
} from "./config/store";
import { hashObject } from "./core/json";
import {
  deepMerge,
  getPathValue,
  parseJsonLike,
  parseJsonObjectOrThrow,
  parseQueryAssignment,
  parseSetExpr,
  parseWhereExpr,
  pathSegments,
  setPathValue,
  valueEqual,
} from "./core/json-values";
import {
  detectQueryMode,
  resolveDatasourceByIdentifier,
  resolveQueryDatasourceIdentifier,
} from "./core/query";
import {
  assertDashboardResourceV2Transformations,
  dashboardResourceV2HasTabs,
  dashboardResourceV2Name,
  dashboardResourceV2Title,
  isDashboardResourceV2,
  sanitizeDashboardResourceV2,
} from "./dashboard/model";
import {
  collectDashboardPanels,
  collectDashboards,
  extractPanelTargets,
  normalizeDashboardInput,
} from "./dashboard/normalize";
import {
  buildValidateQueryBody,
  matchesValidationTarget,
  validateDashboardPromQLSyntax,
} from "./dashboard/promql";
import { validateDashboards } from "./dashboard/validation";
import {
  extractTemplatingValues,
  findUnresolvedTemplateTokens,
  resolveDatasourceUid,
  resolveTemplateString,
} from "./lib/template-vars";
import { ensureDir, writeJson } from "./output/files";
import {
  normalizeRenderTarget,
  printData,
  printMessage,
  renderFramesText,
  renderTable,
  rowsToTable,
} from "./output/render";
import { bundleToFiles } from "./resources/export";
import { fetchResources } from "./resources/fetch";
import { deleteSingleResource, importResources, parseIdOrUidSelector } from "./resources/grafana";
import {
  createEmptyBundle,
  dedupeResources,
  diffArray,
  inferResourceFromObject,
  parseResourceAlias,
  parseResources,
  resourceFromType,
  resourceItems,
  selectedResourceChanged,
  selectResource,
  setSingleResource,
} from "./resources/model";
import { collectBundle } from "./resources/source";
import { CliName } from "./schema";
import {
  buildRenderPanelPath,
  msToInterval,
  parseRenderVar,
  parseSkipPanelIds,
  parseVarAssignments,
  resolveTimeToMs,
} from "./utils";

const runtime: CliRuntime = {
  parseCommonOptions,
  getConfigPath,
  readCliConfig,
  parseResources,
  parseResourceAlias,
  dedupeResources,
  isDashboardResourceV2,
  dashboardResourceV2HasTabs,
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
  selectedResourceChanged,
  printMessage,
  printData,
  rowsToTable,
  renderTable,
  normalizeRenderTarget,
  ensureDir,
  detectQueryMode,
  resolveQueryDatasourceIdentifier,
  resolveDatasourceByIdentifier,
  parseJsonObjectOrThrow,
  parseQueryAssignment,
  setPathValue,
  renderFramesText,
  collectDashboards,
  validateDashboards,
  validateDashboardPromQLSyntax,
  parseJsonLike,
  deepMerge,
  parseSetExpr,
  createEmptyBundle,
  setSingleResource,
  writeJson,
  deleteSingleResource,
  parseIdOrUidSelector,
};

function composeProgram(program: ReturnType<typeof createCommand>["program"], app: CommandAppContext) {
  for (const command of buildContextAuthCommands()) program.addCommand(command);
  for (const command of buildSyncCommands(app)) program.addCommand(command);
  program.addCommand(buildValidateCommand(app));
  for (const command of buildListAndRenderCommands(app)) program.addCommand(command);
  program.addCommand(buildQueryCommand(app));
  program.addCommand(buildApiCommand(app));
  program.addCommand(buildPanelCommand(app));
  for (const command of buildMutateCommands(app)) program.addCommand(command);

  return program;
}

export async function run(): Promise<void> {
  loadEnv();
  await buildCliProgram().parseAsync(process.argv);
}

export function buildCliProgram() {
  const { program, collectList } = createCommand(CliName);
  const app: CommandAppContext = { collectList, runtime };
  return composeProgram(program, app);
}

export const __test__ = {
  parseEnvFile,
  migrateLegacyConfig,
  parseSimpleYamlConfig,
  findGitRoot,
  getProjectConfigPath,
  readProjectCliConfig,
  resolveContextName,
  parseResources,
  parseResourceAlias,
  resourceFromType,
  inferResourceFromObject,
  isDashboardResourceV2,
  sanitizeDashboardResourceV2,
  assertDashboardResourceV2Transformations,
  dashboardResourceV2Name,
  dashboardResourceV2Title,
  dashboardResourceV2HasTabs,
  normalizeDashboardInput,
  collectDashboardPanels,
  extractPanelTargets,
  collectDashboards,
  collectBundle,
  parseWhereExpr,
  parseSetExpr,
  parseRenderVar,
  buildRenderPanelPath,
  parseSkipPanelIds,
  parseVarAssignments,
  parseQueryAssignment,
  detectQueryMode,
  resolveQueryDatasourceIdentifier,
  normalizeRenderTarget,
  resolveTimeToMs,
  msToInterval,
  extractTemplatingValues,
  findUnresolvedTemplateTokens,
  resolveTemplateString,
  resolveDatasourceUid,
  pathSegments,
  getPathValue,
  setPathValue,
  deepMerge,
  validateDashboardPromQLSyntax,
  buildValidateQueryBody,
  matchesValidationTarget,
  diffArray,
  selectedResourceChanged,
  writeJson,
};
