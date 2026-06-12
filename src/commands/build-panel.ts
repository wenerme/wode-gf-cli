import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { GrafanaClient } from "../client";
import { asObject, asObjectArray, asString, getObjectField } from "../lib/json-narrow";
import { applyLegendPresetToDashboard, parsePanelIds } from "../lib/panel-legend";
import { parseGrafanaPromQLMacroMode } from "../promql/grafana";
import { type ResourceSelector, ResourceSelectorSchema } from "../schema";
import { buildRenderPanelPath, parsePositiveInt } from "../utils";
import type { CliContext, CommandAppContext } from "./runtime";

type JsonObject = Record<string, unknown>;

type PanelRef = {
  dashboard: string;
  panelId: number;
};

type DashboardSelection = {
  wrapper: JsonObject;
  dashboard: JsonObject;
  uid: string;
  title: string;
};

type PanelMatch = {
  panel: JsonObject;
  path: string;
  depth: number;
};

export function parsePanelRef(ref: string): PanelRef {
  const text = String(ref || "").trim();
  const index = text.lastIndexOf("/");
  if (index <= 0 || index === text.length - 1) {
    throw new Error("Panel ref must be DASH/PANEL, for example fusion-alerts/12");
  }
  const dashboard = text.slice(0, index).trim();
  const panelToken = text.slice(index + 1).trim();
  if (!dashboard) throw new Error("Panel ref is missing dashboard uid");
  if (!/^\d+$/.test(panelToken)) throw new Error("Panel ref PANEL must be a numeric panel id");
  return { dashboard, panelId: Number.parseInt(panelToken, 10) };
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return undefined;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function flattenPanels(input: unknown, prefix = "panels", depth = 0): PanelMatch[] {
  if (!Array.isArray(input)) return [];
  const result: PanelMatch[] = [];
  input.forEach((value, index) => {
    const panel = asObject(value);
    if (!panel) return;
    const panelPath = `${prefix}[${index}]`;
    result.push({ panel, path: panelPath, depth });
    result.push(...flattenPanels(panel.panels, `${panelPath}.panels`, depth + 1));
  });
  return result;
}

function findPanel(dashboard: JsonObject, panelId: number): PanelMatch {
  const match = flattenPanels(dashboard.panels).find(
    (candidate) => numberValue(candidate.panel.id) === panelId,
  );
  if (!match) throw new Error(`No panel ${panelId} found in dashboard`);
  return match;
}

function replaceInPanelArray(value: unknown, panelId: number, nextPanel: JsonObject): boolean {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const panel = asObject(value[index]);
    if (!panel) continue;
    if (numberValue(panel.id) === panelId) {
      value[index] = nextPanel;
      return true;
    }
    if (replaceInPanelArray(panel.panels, panelId, nextPanel)) return true;
  }
  return false;
}

export function replacePanelInDashboard(dashboard: JsonObject, panelId: number, nextPanel: JsonObject) {
  const updatedDashboard = cloneJson(dashboard);
  if (!replaceInPanelArray(updatedDashboard.panels, panelId, nextPanel)) {
    throw new Error(`No panel ${panelId} found in dashboard`);
  }
  return updatedDashboard;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function datasourceLabel(value: unknown): string | undefined {
  const datasource = asObject(value);
  if (datasource) {
    return asString(datasource.uid) || asString(datasource.name) || asString(datasource.type);
  }
  return asString(value);
}

function panelDatasources(panel: JsonObject): string[] {
  const values = new Set<string>();
  const own = datasourceLabel(panel.datasource);
  if (own) values.add(own);
  for (const target of asObjectArray(panel.targets)) {
    const targetDatasource = datasourceLabel(target.datasource);
    if (targetDatasource) values.add(targetDatasource);
  }
  return Array.from(values);
}

function shortText(value: unknown, maxLength = 80) {
  const text = asString(value);
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function panelTargetSummary(panel: JsonObject) {
  return asObjectArray(panel.targets).map((target) => {
    return {
      refId: asString(target.refId) || "",
      datasource: datasourceLabel(target.datasource) || "",
      query:
        shortText(target.expr) ||
        shortText(target.rawSql) ||
        shortText(target.query) ||
        shortText(target.expression) ||
        "",
    };
  });
}

function panelInspectSummary(selection: DashboardSelection, match: PanelMatch) {
  const panel = match.panel;
  const fieldConfig = asObject(panel.fieldConfig);
  const options = asObject(panel.options);
  return {
    dashboard: {
      uid: selection.uid,
      title: selection.title,
    },
    panel: {
      id: numberValue(panel.id) ?? null,
      title: asString(panel.title) || "",
      type: asString(panel.type) || "",
      path: match.path,
      depth: match.depth,
      datasource: panelDatasources(panel),
      targets: panelTargetSummary(panel),
      transformations: asObjectArray(panel.transformations).map((item) => ({
        id: asString(item.id) || "",
      })),
      overrides: asObjectArray(fieldConfig?.overrides).length,
      optionsKeys: options ? Object.keys(options).sort() : [],
      gridPos: asObject(panel.gridPos) || null,
      links: asObjectArray(panel.links).length,
    },
  };
}

function printLegendPresetResult(
  ctx: CliContext,
  results: Array<{ panelId: number; panelTitle: string; status: string; message: string }>,
  json: boolean,
  printMessage: (ctx: CliContext, message: string) => void,
) {
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

function renderPanelInspectText(summary: ReturnType<typeof panelInspectSummary>) {
  const lines = [
    `Dashboard: ${summary.dashboard.title} [${summary.dashboard.uid}]`,
    `Panel: ${summary.panel.title || "(untitled)"} [${summary.panel.id ?? "?"}]`,
    `Type: ${summary.panel.type || "<none>"}`,
    `Path: ${summary.panel.path}`,
    `Datasource: ${summary.panel.datasource.join(", ") || "<none>"}`,
    `Targets: ${summary.panel.targets.length}`,
  ];
  for (const target of summary.panel.targets) {
    lines.push(
      `  - ${target.refId || "?"}${target.datasource ? ` @ ${target.datasource}` : ""}${target.query ? `: ${target.query}` : ""}`,
    );
  }
  if (summary.panel.transformations.length > 0) {
    lines.push(
      `Transformations: ${summary.panel.transformations.map((item) => item.id || "<unknown>").join(", ")}`,
    );
  }
  if (summary.panel.overrides > 0) lines.push(`Overrides: ${summary.panel.overrides}`);
  if (summary.panel.optionsKeys.length > 0) lines.push(`Options: ${summary.panel.optionsKeys.join(", ")}`);
  if (summary.panel.links > 0) lines.push(`Links: ${summary.panel.links}`);
  return lines.join("\n");
}

function dashboardSelectors(token: string): ResourceSelector[] {
  const selectors: ResourceSelector[] = [];
  if (/^\d+$/.test(token)) {
    selectors.push(ResourceSelectorSchema.parse({ id: token, uid: token, where: [] }));
  } else {
    selectors.push(ResourceSelectorSchema.parse({ uid: token, where: [] }));
  }
  selectors.push(ResourceSelectorSchema.parse({ title: token, where: [] }));
  return selectors;
}

function selectDashboardByToken(
  items: unknown[],
  token: string,
  selectResource: (
    items: unknown[],
    resource: "dashboards",
    selector: ResourceSelector,
    allowMissing?: boolean,
  ) => unknown | undefined,
) {
  let lastNoMatch: Error | undefined;
  for (const selector of dashboardSelectors(token.trim())) {
    try {
      return selectResource(items, "dashboards", selector, false);
    } catch (error) {
      const err = error as Error;
      if (err.message === "No dashboards matched selector") {
        lastNoMatch = err;
        continue;
      }
      throw err;
    }
  }
  throw lastNoMatch || new Error("No dashboards matched selector");
}

function assertPanelObject(value: unknown): JsonObject {
  const panel = asObject(value);
  if (!panel) throw new Error("Panel JSON must be an object");
  return panel;
}

function assertPanelId(panel: JsonObject, panelId: number) {
  const id = numberValue(panel.id);
  if (id !== panelId) {
    throw new Error(`Edited panel id must remain ${panelId}`);
  }
}

async function loadDashboardSelection(
  ctx: CliContext,
  dashboardToken: string,
  runtime: CommandAppContext["runtime"],
): Promise<DashboardSelection> {
  const client = new GrafanaClient(ctx);
  const remote = await runtime.fetchResources(client, ["dashboards"]);
  const selected = selectDashboardByToken(
    runtime.resourceItems(remote, "dashboards"),
    dashboardToken,
    runtime.selectResource,
  );
  const wrapper = asObject(selected);
  if (!wrapper) throw new Error("Selected dashboard is not a JSON object");
  const dashboard = getObjectField(wrapper, "dashboard");
  if (!dashboard) throw new Error("Selected dashboard has no dashboard payload");
  const uid = asString(wrapper.uid) || asString(dashboard.uid) || dashboardToken;
  const title = asString(wrapper.title) || asString(dashboard.title) || uid;
  return { wrapper, dashboard, uid, title };
}

async function applyPanelUpdate(
  ctx: CliContext,
  selection: DashboardSelection,
  panelId: number,
  nextPanel: JsonObject,
  runtime: CommandAppContext["runtime"],
) {
  const updatedDashboard = replacePanelInDashboard(selection.dashboard, panelId, nextPanel);
  const updatedWrapper = {
    ...selection.wrapper,
    dashboard: updatedDashboard,
  };
  const bundle = runtime.createEmptyBundle();
  runtime.setSingleResource(bundle, "dashboards", updatedWrapper);
  await runtime.importResources(ctx, bundle, ["dashboards"]);
}

export function buildPanelCommand(app: CommandAppContext) {
  const { collectList, runtime } = app;
  const panelCommand = new Command("panel")
    .alias("p")
    .description("inspect, edit, patch, and render dashboard panels");

  panelCommand
    .command("list <DASH>")
    .description("List panels in dashboard")
    .option("--search <TERM>", "filter by id/title/type/datasource")
    .option("--json", "print panels as json")
    .action(async function panelListAction(dashboardRef: string, options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const selection = await loadDashboardSelection(ctx, dashboardRef, runtime);
      const query = String(options.search || "")
        .trim()
        .toLowerCase();
      const rows = flattenPanels(selection.dashboard.panels)
        .map((match) => {
          const id = String(numberValue(match.panel.id) ?? "");
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

  panelCommand
    .command("get <REF>")
    .alias("read")
    .description("Get/read panel JSON by DASH/PANEL")
    .option("--path <path>", "value path (dot / [index])")
    .action(async function panelGetAction(ref: string, options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const parsed = parsePanelRef(ref);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      const match = findPanel(selection.dashboard, parsed.panelId);
      const value = runtime.getPathValue(match.panel, options.path);
      console.log(JSON.stringify(value, null, 2));
    });

  panelCommand
    .command("inspect <REF>")
    .description("Inspect panel summary by DASH/PANEL")
    .option("--path <path>", "value path (dot / [index])")
    .option("--json", "print summary/path as json")
    .action(async function panelInspectAction(ref: string, options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const parsed = parsePanelRef(ref);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      const match = findPanel(selection.dashboard, parsed.panelId);
      if (options.path) {
        const value = runtime.getPathValue(match.panel, options.path);
        console.log(JSON.stringify(value, null, 2));
        return;
      }
      const summary = panelInspectSummary(selection, match);
      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      runtime.printMessage(ctx, renderPanelInspectText(summary));
    });

  panelCommand
    .command("patch <REF>")
    .description("Patch panel JSON by DASH/PANEL")
    .option("--path <path>", "default path for value-only --set")
    .option("-s, --set <expr>", "patch expression path=value, repeatable", collectList, [])
    .option("--merge <json>", "deep merge JSON object into selected panel")
    .option("--from <file>", "replace selected panel with this JSON file content")
    .option("--json", "print patched panel json")
    .action(async function panelPatchAction(ref: string, options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const parsed = parsePanelRef(ref);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      const match = findPanel(selection.dashboard, parsed.panelId);
      let updated: unknown = cloneJson(match.panel);

      if (options.from) {
        updated = JSON.parse(fs.readFileSync(path.resolve(String(options.from)), "utf8"));
      }
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

  panelCommand
    .command("edit <REF>")
    .description(
      "Open panel JSON/path in $EDITOR and apply it back to dashboard; use --editor in non-interactive shells",
    )
    .option("--path <path>", "edit only this panel JSON path")
    .option("--editor <cmd>", "editor command", process.env.VISUAL || process.env.EDITOR || "vi")
    .option("--json", "print edited panel json")
    .action(async function panelEditAction(ref: string, options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const parsed = parsePanelRef(ref);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      const match = findPanel(selection.dashboard, parsed.panelId);
      const beforeHash = runtime.hashObject(match.panel);
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wode-gf-cli-panel-"));
      const tempFile = path.join(tempDir, `panel-${parsed.panelId}.json`);
      const editPath = asString(options.path);
      const editTarget = editPath ? runtime.getPathValue(match.panel, editPath) : match.panel;
      runtime.writeJson(tempFile, editTarget, true);

      try {
        const editor = String(options.editor || "").trim() || "vi";
        const editorSource = (this as unknown as Command).getOptionValueSource("editor");
        if (!process.stdin.isTTY && editorSource !== "cli") {
          throw new Error(
            "panel edit opens an editor; in non-interactive shells use --editor <cmd> or use p patch --from <file>",
          );
        }
        const result = spawnSync(`${editor} ${shellQuote(tempFile)}`, { shell: true, stdio: "inherit" });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Editor exited with status ${result.status}`);
        const editedJson = JSON.parse(fs.readFileSync(tempFile, "utf8"));
        const editedPanel = editPath
          ? (() => {
              const nextPanel = cloneJson(match.panel);
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
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

  panelCommand
    .command("validate <REF>")
    .description("Validate one panel's queries by DASH/PANEL")
    .option("--from <time>", "query time start", "now-1h")
    .option("--to <time>", "query time end", "now")
    .option("--timeout <ms>", "request timeout milliseconds for validate", "60000")
    .option("--interval-ms <ms>", "grafana built-in interval in milliseconds", "60000")
    .option("--fail-fast", "stop when first validation error found")
    .option("--promql-macro-mode <mode>", "PromQL Grafana macro handling: keep|preset|eval|strict", "keep")
    .option("--var <expr>", "variable override key=value, repeatable", collectList, [])
    .action(async function panelValidateAction(ref: string, options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const parsed = parsePanelRef(ref);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      findPanel(selection.dashboard, parsed.panelId);
      const varOverrides = Object.fromEntries(
        (options.var || []).map((expr: string) => {
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

  panelCommand
    .command("legend-preset <TARGET>")
    .description("Apply common timeseries legend preset to remote panel ref or local dashboard JSON")
    .option("--panel-id <ids>", "panel id(s) for local dashboard JSON, comma-separated")
    .option("--right-table", "place legend table on the right")
    .option("--mean-desc", "sort by Mean descending")
    .option("--calcs <list>", "comma-separated calcs", "mean,max,sum")
    .option("--json", "print result as json")
    .action(async function panelLegendPresetAction(target: string, options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command, {
        requireUrl: !fs.existsSync(target),
      });
      const calcs = String(options.calcs || "mean,max,sum")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (calcs.length === 0) throw new Error("--calcs must contain at least one calculation");

      if (fs.existsSync(target)) {
        const file = path.resolve(target);
        const root = JSON.parse(fs.readFileSync(file, "utf8")) as JsonObject;
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
        if (!ctx.dryRun) fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`, "utf8");
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
      const nextPanel = findPanel(result.dashboard, parsed.panelId).panel;
      await applyPanelUpdate(ctx, selection, parsed.panelId, nextPanel, runtime);
      printLegendPresetResult(ctx, result.results, Boolean(options.json), runtime.printMessage);
      if (result.results.some((item) => item.status === "skip")) process.exitCode = 2;
    });

  panelCommand
    .command("render <REF>")
    .description("Render panel PNG by DASH/PANEL")
    .option("-o, --out <file>", "output PNG file", "local/panel.png")
    .option("--from <from>", "time range start", "now-6h")
    .option("--to <to>", "time range end", "now")
    .option("--width <px>", "render width", "1600")
    .option("--height <px>", "render height", "900")
    .option("--tz <timezone>", "timezone", "UTC")
    .option("--theme <theme>", "light|dark", "light")
    .option("--render-timeout <ms>", "render request timeout milliseconds", "60000")
    .option("--var <expr>", "template variable key=value, repeatable", collectList, [])
    .action(async function panelRenderAction(ref: string, options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const parsed = parsePanelRef(ref);
      const selection = await loadDashboardSelection(ctx, parsed.dashboard, runtime);
      findPanel(selection.dashboard, parsed.panelId);
      const out = path.resolve(options.out);
      const renderTimeoutMs = parsePositiveInt(options.renderTimeout, 60_000);
      const renderPath = buildRenderPanelPath({
        dashboardUid: selection.uid,
        panelId: parsed.panelId,
        out,
        from: String(options.from || "now-6h").trim(),
        to: String(options.to || "now").trim(),
        width: parsePositiveInt(options.width, 1600),
        height: parsePositiveInt(options.height, 900),
        tz: String(options.tz || "UTC").trim(),
        theme: String(options.theme || "light").trim() as "light" | "dark",
        vars: options.var || [],
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

      const client = new GrafanaClient({ ...ctx, timeoutMs: renderTimeoutMs });
      const image = await client.requestBytes("GET", renderPath, [200]);
      runtime.ensureDir(path.dirname(out));
      fs.writeFileSync(out, Buffer.from(image));
      const noDataWarning = image.length < 20 * 1024;
      runtime.printData(ctx, "panel-render-complete", {
        ref,
        dashboardUid: selection.uid,
        panelId: parsed.panelId,
        out,
        size: image.length,
        possibleNoData: noDataWarning,
        message: `Rendered panel image: ${out} (${image.length} bytes)${noDataWarning ? `\n[WARN] possible NoData (file size: ${(image.length / 1024).toFixed(1)}KB)` : ""}`,
      });
    });

  return panelCommand;
}
