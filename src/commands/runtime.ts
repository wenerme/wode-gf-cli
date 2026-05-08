import type { Command } from "commander";
import type { GrafanaClient } from "../client";
import type { ExportBundle, ResourceName, ResourceSelector } from "../schema";

type JsonObject = Record<string, unknown>;

export type CliContext = {
  url: string;
  apiKey?: string;
  username?: string;
  password?: string;
  timeoutMs: number;
  dryRun: boolean;
  debug: boolean;
  contextName?: string;
  output: "text" | "json";
  quiet: boolean;
};

export type QueryModeFlags = {
  resourceAlias: ResourceName | undefined;
  isDsKeyword: boolean;
  isQuickQueryMode: boolean;
};

export type ValidateIssue = {
  dashboardTitle: string;
  panelTitle: string;
  panelId: number;
  refId: string;
  message: string;
};

export type DiffItem = {
  key: string;
  change: "added" | "removed" | "changed";
};

export type CliRuntime = {
  parseCommonOptions: (cmd: Command, cfg?: { requireUrl?: boolean }) => CliContext;
  getConfigPath: () => string;
  readCliConfig: () => { context: string; contexts: Array<Record<string, string>> };
  parseResources: (value?: string) => ResourceName[];
  parseResourceAlias: (value: string | undefined) => ResourceName | undefined;
  dedupeResources: (resources: ResourceName[]) => ResourceName[];
  collectBundle: (sources: string[], forcedResource?: ResourceName) => ExportBundle;
  fetchResources: (client: GrafanaClient, resources: ResourceName[]) => Promise<ExportBundle>;
  bundleToFiles: (outDir: string, bundle: ExportBundle, pretty: boolean) => void;
  importResources: (
    ctx: CliContext,
    bundle: ExportBundle,
    resources: ResourceName[],
    options?: { overwrite?: boolean },
  ) => Promise<void>;
  resourceItems: (bundle: ExportBundle, resource: ResourceName) => unknown[];
  selectResource: (
    items: unknown[],
    resource: ResourceName,
    selector: ResourceSelector,
    allowMissing?: boolean,
  ) => unknown | undefined;
  getPathValue: (input: unknown, pathExpr?: string) => unknown;
  valueEqual: (a: unknown, b: unknown) => boolean;
  hashObject: (input: unknown) => string;
  diffArray: (resource: ResourceName, local: unknown[], remote: unknown[]) => DiffItem[];
  printMessage: (ctx: CliContext, message: string) => void;
  printData: (ctx: CliContext, type: string, data: Record<string, unknown>) => void;
  rowsToTable: (rows: Array<{ uid: string; label: string; folder?: string; raw: JsonObject }>) => string;
  renderTable: (headers: string[], rows: string[][]) => string;
  normalizeRenderTarget: (target: string) => "panel" | "dashboard";
  ensureDir: (dir: string) => void;
  detectQueryMode: (
    resourceArg: string,
    options: { sql?: string; expr?: string; queryJson?: string; queryFile?: string; query?: string[] },
  ) => QueryModeFlags;
  resolveQueryDatasourceIdentifier: (
    resourceArg: string,
    options: { uid?: string },
    flags: QueryModeFlags,
  ) => string;
  resolveDatasourceByIdentifier: (
    client: GrafanaClient,
    identifier: string,
    vars: Record<string, string | string[]>,
  ) => Promise<{ uid: string }>;
  parseJsonObjectOrThrow: (input: string, sourceLabel: string) => JsonObject;
  parseQueryAssignment: (expr: string) => { path: string; value: unknown };
  setPathValue: (target: Record<string, unknown>, pathExpr: string, value: unknown) => void;
  renderFramesText: (data: unknown, refId: string) => string | undefined;
  collectDashboards: (bundle: ExportBundle) => JsonObject[];
  validateDashboards: (
    ctx: CliContext,
    dashboards: JsonObject[],
    options: {
      from: string;
      to: string;
      timeoutMs: number;
      intervalMs: number;
      concurrency: number;
      failFast: boolean;
      skipPanelIds: number[];
      onlyPanelIds?: number[];
      vars: Record<string, string>;
    },
  ) => Promise<{ errors: ValidateIssue[]; warnings: ValidateIssue[] }>;
  parseJsonLike: (input: string) => unknown;
  deepMerge: (base: unknown, patch: unknown) => unknown;
  parseSetExpr: (expr: string, defaultPath?: string) => { path: string; value: unknown };
  createEmptyBundle: () => ExportBundle;
  setSingleResource: (bundle: ExportBundle, resource: ResourceName, item: unknown) => void;
  writeJson: (file: string, data: unknown, pretty?: boolean) => void;
  deleteSingleResource: (
    ctx: CliContext,
    resource: ResourceName,
    selector: ResourceSelector,
  ) => Promise<unknown>;
  parseIdOrUidSelector: (idOrUid: string) => ResourceSelector;
};

export type CommandAppContext = {
  collectList: (value: string, prev: string[]) => string[];
  runtime: CliRuntime;
};
