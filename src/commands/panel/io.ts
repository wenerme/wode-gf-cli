import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrafanaClient } from "../../client";
import { asObject, asString, getObjectField } from "../../lib/json-narrow";
import { type PanelJsonObject, replacePanelInDashboard } from "../../lib/panel-tree";
import type { CliContext, CommandAppContext } from "../runtime";
import { shellQuote } from "./model";
import { type DashboardSelection, selectDashboardByToken } from "./selection";

export async function loadDashboardSelection(
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

export async function applyPanelUpdate(
  ctx: CliContext,
  selection: DashboardSelection,
  panelId: number,
  nextPanel: PanelJsonObject,
  runtime: CommandAppContext["runtime"],
): Promise<void> {
  const updatedWrapper = {
    ...selection.wrapper,
    dashboard: replacePanelInDashboard(selection.dashboard, panelId, nextPanel),
  };
  const bundle = runtime.createEmptyBundle();
  runtime.setSingleResource(bundle, "dashboards", updatedWrapper);
  await runtime.importResources(ctx, bundle, ["dashboards"]);
}

export function fileExists(file: string): boolean {
  return fs.existsSync(file);
}

export function resolveFile(file: string): string {
  return path.resolve(file);
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

export function writeJsonFile(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function editJson(
  value: unknown,
  panelId: number,
  editor: string,
  runtime: CommandAppContext["runtime"],
): unknown {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wode-gf-cli-panel-"));
  const tempFile = path.join(tempDir, `panel-${panelId}.json`);
  runtime.writeJson(tempFile, value, true);
  try {
    const result = spawnSync(`${editor} ${shellQuote(tempFile)}`, {
      shell: true,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Editor exited with status ${result.status}`);
    return JSON.parse(fs.readFileSync(tempFile, "utf8"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function renderPanelImage(
  ctx: CliContext,
  renderPath: string,
  out: string,
  timeoutMs: number,
  runtime: CommandAppContext["runtime"],
): Promise<number> {
  const client = new GrafanaClient({ ...ctx, timeoutMs });
  const image = await client.requestBytes("GET", renderPath, [200]);
  runtime.ensureDir(path.dirname(out));
  fs.writeFileSync(out, Buffer.from(image));
  return image.length;
}
