import fs from "node:fs";
import type { JsonObject } from "../core/json";
import { sourceFileOf } from "../core/source-file";
import { checkLayout, type LayoutIssue } from "../dashboard/layout/check";
import { buildLayoutGraph, type LayoutGraph } from "../dashboard/layout/graph";
import type { CliContext } from "./runtime";

export type LayoutMode = "error" | "warn" | "off";

export type DashboardLayoutReport = {
  mode: LayoutMode;
  errors: number;
  warnings: number;
  dashboards: Array<{ title: string; sourceFile?: string; issues: LayoutIssue[] }>;
};

function graphFor(entry: JsonObject): LayoutGraph | undefined {
  const fromEntry = buildLayoutGraph(entry);
  // Prefer the raw source file so JSON paths match what the user edits, but only when the file
  // is this same single dashboard (array bundles share one sourceFile for many entries).
  const file = sourceFileOf(entry);
  if (!file || !fs.existsSync(file)) return fromEntry;
  try {
    const fromFile = buildLayoutGraph(JSON.parse(fs.readFileSync(file, "utf8")));
    if (fromFile && fromEntry && fromFile.uid === fromEntry.uid) return fromFile;
  } catch {
    // fall through to the in-memory entry
  }
  return fromEntry;
}

/** Layout lint for validate; `warn` downgrades layout errors to warnings. */
export function checkDashboardLayouts(dashboards: JsonObject[], mode: LayoutMode): DashboardLayoutReport {
  const report: DashboardLayoutReport = { mode, errors: 0, warnings: 0, dashboards: [] };
  if (mode === "off") return report;
  for (const entry of dashboards) {
    const graph = graphFor(entry);
    if (!graph) continue;
    const issues = checkLayout(graph).issues.map((issue) =>
      mode === "warn" && issue.severity === "error" ? { ...issue, severity: "warning" as const } : issue,
    );
    if (issues.length === 0) continue;
    report.errors += issues.filter((issue) => issue.severity === "error").length;
    report.warnings += issues.filter((issue) => issue.severity === "warning").length;
    report.dashboards.push({ title: graph.title, sourceFile: sourceFileOf(entry), issues });
  }
  return report;
}

export function parseLayoutMode(value: unknown): LayoutMode {
  const mode = String(value || "warn");
  if (mode !== "error" && mode !== "warn" && mode !== "off")
    throw new Error("--layout must be error|warn|off");
  return mode;
}

/** Run before any remote write: warn prints, error throws so nothing is sent. */
export function layoutPreflight(
  ctx: CliContext,
  dashboards: JsonObject[],
  mode: LayoutMode,
  action: string,
  printMessage: (ctx: CliContext, message: string) => void,
) {
  const report = checkDashboardLayouts(dashboards, mode);
  printLayoutIssues(ctx, report, printMessage);
  if (report.errors > 0) {
    const first = report.dashboards[0];
    throw new Error(
      `Layout check failed before ${action}: ${report.errors} errors in ${report.dashboards.length} dashboards (first: ${first?.title}: ${first?.issues[0]?.message}); fix or use --layout warn`,
    );
  }
}

export function printLayoutIssues(
  ctx: CliContext,
  report: DashboardLayoutReport,
  printMessage: (ctx: CliContext, message: string) => void,
) {
  for (const dashboard of report.dashboards) {
    for (const issue of dashboard.issues) {
      const level = issue.severity === "error" ? "ERROR" : "WARN";
      const file = dashboard.sourceFile ? ` / File: ${dashboard.sourceFile}` : "";
      printMessage(ctx, `[${level}] Layout: ${dashboard.title}${file} / ${issue.code}: ${issue.message}`);
    }
  }
  if (report.dashboards.length > 0) {
    printMessage(
      ctx,
      `[${report.errors > 0 ? "ERROR" : "WARN"}] Layout: ${report.dashboards.length} dashboards with layout issues; run \`wode-gf-cli dashboard layout check <FILE>\` for details`,
    );
  }
}
