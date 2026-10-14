import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { GrafanaClient } from "../../client";
import type { JsonObject } from "../../core/json";
import { formatJsonChanges } from "../../core/json-diff";
import { checkLayout } from "../../dashboard/layout/check";
import { diffLayout } from "../../dashboard/layout/diff";
import { buildLayoutGraph } from "../../dashboard/layout/graph";
import { sanitizeDashboardResourceV2 } from "../../dashboard/model";
import {
  comparableDashboard,
  comparableFromLocal,
  type DashboardApi,
  type DashboardSnapshot,
  detectDashboardApi,
  getCurrentDashboard,
  getDashboardVersion,
  listDashboardSnapshotsV2,
  listDashboardVersions,
  resolveDashboardUid,
  writeDashboardVersion,
} from "../../dashboard/versions";
import type { CliContext, CommandAppContext } from "../runtime";
import {
  checkDashboardLayouts,
  type DashboardLayoutReport,
  layoutPreflight,
  parseLayoutMode,
} from "../validate-layout";
import {
  clip,
  diffJson,
  parseVersionNumber,
  parseVersionRef,
  printChanges,
  readJsonFile,
  shortTime,
} from "../versions-shared";

type Side = { label: string; api: DashboardApi; document: JsonObject };

function parseApi(value: unknown): DashboardApi | "auto" {
  const mode = String(value || "auto");
  if (mode !== "auto" && mode !== "classic" && mode !== "v2")
    throw new Error("--dashboard-api must be auto|classic|v2");
  return mode;
}

/** A graph-able wrapper so layout tooling sees v2 specs and classic bodies alike. */
function layoutInput(side: Pick<Side, "api" | "document">): JsonObject {
  return side.api === "v2"
    ? {
        apiVersion: "dashboard.grafana.app/v2beta1",
        kind: "Dashboard",
        metadata: { name: "x" },
        spec: side.document,
      }
    : { dashboard: side.document };
}

function layoutCounts(side: Pick<Side, "api" | "document">) {
  const graph = buildLayoutGraph(layoutInput(side));
  const issues = graph ? checkLayout(graph).issues : [];
  return {
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
  };
}

async function resolveSide(
  client: GrafanaClient,
  uid: string,
  token: string,
  api: DashboardApi,
): Promise<Side> {
  const ref = parseVersionRef(token);
  if (ref.kind === "file") {
    const local = comparableFromLocal(readJsonFile(ref.file), uid);
    return { label: path.basename(ref.file), ...local };
  }
  const current = await getCurrentDashboard(client, uid, api);
  if (ref.kind === "current" && ref.back === 0) {
    return { label: `current (v${current.version})`, api, document: comparableDashboard(current) };
  }
  const version = ref.kind === "version" ? ref.version : await nthVersion(client, uid, ref.back);
  const snapshot = await getDashboardVersion(client, uid, version, api);
  return { label: `v${snapshot.version}`, api, document: comparableDashboard(snapshot) };
}

/**
 * N distinct versions back from current. Grafana prunes old versions (numbers are not contiguous) and a
 * metadata-only save adds a history row without bumping the version (numbers repeat).
 */
async function nthVersion(client: GrafanaClient, uid: string, back: number): Promise<number> {
  for (let limit = back + 10; ; limit *= 4) {
    const rows = await listDashboardVersions(client, uid, limit);
    const version = [...new Set(rows.map((row) => row.version))][back];
    if (version !== undefined) return version;
    if (rows.length < limit || limit >= 4000) {
      throw new Error(`Dashboard ${uid} has fewer than ${back + 1} distinct versions`);
    }
  }
}

/**
 * Grafana parses any message containing "Restored from version " with strconv.Atoi on the rest; anything but a
 * bare number there makes `GET /api/dashboards/uid/:uid/versions` return 404 for that dashboard from then on.
 */
export function restoreMessage(version: number, custom?: unknown): string {
  const text = String(custom || "").trim();
  if (!text) return `Restored from version ${version}`;
  const tail = text.split("Restored from version ")[1];
  if (tail !== undefined && !/^\d+$/.test(tail)) {
    throw new Error(
      '--message may only contain "Restored from version " followed by a bare number (Grafana bug)',
    );
  }
  return text;
}

export function buildDashboardVersionsCommand(app: CommandAppContext): Command {
  const { parseCommonOptions, printMessage, renderTable } = app.runtime;
  const versions = new Command("versions")
    .alias("version")
    .description("List, inspect, diff and safely restore dashboard versions");

  const pickApi = async (client: GrafanaClient, uid: string, value: unknown, localFile?: string) => {
    const mode = parseApi(value);
    if (mode !== "auto") return mode;
    if (localFile) return comparableFromLocal(readJsonFile(localFile), uid).api;
    return detectDashboardApi(client, uid);
  };

  versions
    .command("list <ID>")
    .description("List versions (newest first); --check-layout marks where layout errors were introduced")
    .option("--limit <n>", "max versions", "20")
    .option("--check-layout", "lint layout of every listed version")
    .option("--dashboard-api <mode>", "auto|classic|v2 content for --check-layout", "auto")
    .option("--json", "print versions as json")
    .action(async function versionsListAction(id: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const client = new GrafanaClient(ctx);
      const uid = await resolveDashboardUid(client, id);
      const limit = parseVersionNumber(options.limit, "--limit") ?? 20;
      const rows = await listDashboardVersions(client, uid, limit);
      let layout: Map<number, { errors: number; warnings: number }> | undefined;
      if (options.checkLayout) {
        const api = await pickApi(client, uid, options.dashboardApi);
        layout = new Map();
        if (api === "v2") {
          for (const snap of await listDashboardSnapshotsV2(client, uid, limit)) {
            layout.set(snap.version, layoutCounts({ api, document: comparableDashboard(snap) }));
          }
        } else {
          for (const row of rows)
            if (row.data) layout.set(row.version, layoutCounts({ api, document: row.data }));
        }
      }
      const result = rows.map((row, index) => {
        const counts = layout?.get(row.version);
        const older = layout?.get(rows[index + 1]?.version ?? -1);
        const note =
          !counts || !older
            ? undefined
            : counts.errors > 0 && older.errors === 0
              ? "introduced"
              : counts.errors === 0 && older.errors > 0
                ? "fixed"
                : undefined;
        const { data: _data, ...meta } = row;
        return { ...meta, ...(counts ? { layout: { ...counts, note } } : {}) };
      });
      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify({ uid, versions: result }, null, 2));
        return;
      }
      const headers = ["VERSION", "CREATED", "BY", "MESSAGE", ...(layout ? ["LAYOUT"] : [])];
      const table = result.map((row) => [
        String(row.version),
        shortTime(row.created),
        row.createdBy || "",
        clip(row.message),
        ...(layout
          ? [
              row.layout
                ? `${row.layout.errors}E/${row.layout.warnings}W${row.layout.note ? ` <- ${row.layout.note}` : ""}`
                : "-",
            ]
          : []),
      ]);
      printMessage(ctx, renderTable(headers, table));
    });

  versions
    .command("get <ID> <VERSION>")
    .description("Print one version in import-ready shape (classic export item or v2 resource)")
    .option("--dashboard-api <mode>", "auto|classic|v2", "auto")
    .option("-o, --out <file>", "write to file instead of stdout")
    .action(async function versionsGetAction(id: string, token: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const client = new GrafanaClient(ctx);
      const uid = await resolveDashboardUid(client, id);
      const api = await pickApi(client, uid, options.dashboardApi);
      const ref = parseVersionRef(token);
      if (ref.kind === "file") throw new Error("VERSION must be a version number or current[~N]");
      const version = ref.kind === "version" ? ref.version : await nthVersion(client, uid, ref.back);
      const [snap, current] = await Promise.all([
        getDashboardVersion(client, uid, version, api),
        getCurrentDashboard(client, uid, api),
      ]);
      const output =
        api === "v2"
          ? sanitizeDashboardResourceV2(snap.document)
          : {
              uid,
              title: snap.document.title,
              folderUid: current.folderUid ?? null,
              dashboard: snap.document,
            };
      const text = `${JSON.stringify(output, null, 2)}\n`;
      if (options.out) {
        fs.writeFileSync(path.resolve(String(options.out)), text);
        printMessage(ctx, `Wrote ${uid} v${snap.version} (${api}) to ${options.out}`);
      } else process.stdout.write(text);
    });

  versions
    .command("diff <ID> <FROM> [TO]")
    .description(
      "Diff two versions; FROM/TO = N | current | current~N | local FILE (TO defaults to current); exit 2 if different",
    )
    .option("--layout", "compare layout only (moved/resized/reparented panels)")
    .option("--dashboard-api <mode>", "auto|classic|v2", "auto")
    .option("--json", "print changes as json")
    .action(async function versionsDiffAction(id: string, from: string, to: string | undefined, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const client = new GrafanaClient(ctx);
      const uid = await resolveDashboardUid(client, id);
      const target = to || "current";
      const file = [from, target].map(parseVersionRef).find((ref) => ref.kind === "file");
      const api = await pickApi(
        client,
        uid,
        options.dashboardApi,
        file?.kind === "file" ? file.file : undefined,
      );
      const [a, b] = await Promise.all([
        resolveSide(client, uid, from, api),
        resolveSide(client, uid, target, api),
      ]);
      if (a.api !== b.api)
        throw new Error(
          `Cannot diff ${a.api} (${a.label}) against ${b.api} (${b.label}); pass --dashboard-api`,
        );
      if (options.layout) {
        const ga = buildLayoutGraph(layoutInput(a));
        const gb = buildLayoutGraph(layoutInput(b));
        if (!ga || !gb) throw new Error("Layout is missing on one side");
        const diff = diffLayout(ga, gb);
        if (options.json || ctx.output === "json")
          console.log(JSON.stringify({ from: a.label, to: b.label, ...diff }, null, 2));
        else if (!diff.changed) printMessage(ctx, `Layout unchanged between ${a.label} and ${b.label}`);
        else
          for (const item of diff.items)
            printMessage(
              ctx,
              `${item.change.padEnd(10)} ${item.key}${item.title ? ` "${item.title}"` : ""}  ${[item.from, item.to].filter(Boolean).join(" -> ")}`,
            );
        if (diff.changed) process.exitCode = 2;
        return;
      }
      if (
        printChanges(
          app,
          ctx,
          { from: a.label, to: b.label },
          diffJson(a.document, b.document),
          Boolean(options.json),
        )
      ) {
        process.exitCode = 2;
      }
    });

  versions
    .command("restore <ID> <VERSION>")
    .description(
      "Restore a version as a new save with a version precondition (never Grafana /restore); honors --dry-run",
    )
    .option("--expect-version <n>", "abort unless the current version is N (what you reviewed)")
    .option("--message <text>", "version message", "")
    .option("--layout <mode>", "layout preflight on the restored version: error|warn|off", "warn")
    .option("--dashboard-api <mode>", "auto|classic|v2 (must match the stored format)", "auto")
    .option("--allow-format-change", "allow writing in a format other than the stored one (may be lossy)")
    .option("--json", "print result as json")
    .action(async function versionsRestoreAction(id: string, token: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const client = new GrafanaClient(ctx);
      const uid = await resolveDashboardUid(client, id);
      const requested = parseApi(options.dashboardApi);
      // Restore always writes in the stored format: classic over native v2 (or v2 over classic) converts the
      // dashboard, which is the lossy round-trip this command exists to avoid.
      const stored =
        requested !== "auto" && options.allowFormatChange ? requested : await detectDashboardApi(client, uid);
      if (requested !== "auto" && requested !== stored) {
        throw new Error(
          `Dashboard ${uid} is stored as ${stored}; restoring as ${requested} would convert it. Use --allow-format-change if intended`,
        );
      }
      const api = requested === "auto" ? stored : requested;
      const version = parseVersionNumber(token, "VERSION") as number;
      const expect = parseVersionNumber(options.expectVersion, "--expect-version");
      const message = restoreMessage(version, options.message);
      const current = await getCurrentDashboard(client, uid, api);
      if (expect !== undefined && current.version !== expect) {
        throw new Error(
          `Dashboard ${uid} is at version ${current.version}, expected ${expect}; review again before restoring`,
        );
      }
      const target = await getDashboardVersion(client, uid, version, api);
      const changes = diffJson(comparableDashboard(current), comparableDashboard(target));
      const report = (extra: RestoreOutcome) =>
        restoreReport(app, ctx, options, current, target, changes, extra);
      if (changes.length === 0) return report({ action: "noop" });
      const layoutMode = parseLayoutMode(options.layout);
      const layoutTarget = [layoutInput({ api, document: comparableDashboard(target) })];
      const json = Boolean(options.json) || ctx.output === "json";
      // JSON mode must stay one document: embed the layout report instead of printing it.
      const layout = json ? checkDashboardLayouts(layoutTarget, layoutMode) : undefined;
      if (layout && layout.errors > 0)
        throw new Error(
          `Layout check failed before restore: ${layout.errors} errors; fix or use --layout warn`,
        );
      if (!json) layoutPreflight(ctx, layoutTarget, layoutMode, "restore", printMessage);
      if (ctx.dryRun) return report({ action: "plan", layout });
      const written = await writeDashboardVersion(client, current, target, message);
      const after = await getCurrentDashboard(client, uid, api);
      const residual = diffJson(comparableDashboard(target), comparableDashboard(after));
      report({ action: "restored", written, readback: after.version, residual: residual.length, layout });
      if (residual.length > 0 || after.version !== current.version + 1) process.exitCode = 2;
    });

  return versions;
}

type RestoreOutcome = {
  action: string;
  written?: number;
  readback?: number;
  residual?: number;
  layout?: DashboardLayoutReport;
};

function restoreReport(
  app: CommandAppContext,
  ctx: CliContext,
  options: { json?: boolean },
  current: DashboardSnapshot,
  target: DashboardSnapshot,
  changes: ReturnType<typeof diffJson>,
  extra: RestoreOutcome,
) {
  const base = {
    uid: current.uid,
    api: current.api,
    from: current.version,
    to: target.version,
    changes: changes.length,
  };
  if (options.json || ctx.output === "json") {
    console.log(JSON.stringify({ ...base, dryRun: ctx.dryRun, ...extra, diff: changes }, null, 2));
    return;
  }
  const print = (line: string) => app.runtime.printMessage(ctx, line);
  if (extra.action === "noop")
    return print(
      `Dashboard ${current.uid} v${current.version} already equals v${target.version}; nothing to restore`,
    );
  print(
    `${ctx.dryRun ? "[DRY-RUN] " : ""}restore ${current.uid} (${current.api}) v${current.version} -> content of v${target.version}: ${changes.length} change(s)`,
  );
  for (const line of printLimited(changes)) print(`  ${line}`);
  if (extra.action === "restored") {
    print(`Restored as v${extra.readback} (Grafana reported ${extra.written}).`);
    if (extra.readback !== current.version + 1)
      print(`[WARN] expected v${current.version + 1}; another save happened concurrently`);
    if (extra.residual)
      print(
        `[WARN] readback differs from v${target.version} in ${extra.residual} path(s); Grafana normalized the save`,
      );
  }
}

function printLimited(changes: ReturnType<typeof diffJson>, max = 40): string[] {
  const lines = formatJsonChanges(changes.slice(0, max));
  if (changes.length > max) lines.push(`... ${changes.length - max} more (use versions diff for details)`);
  return lines;
}
