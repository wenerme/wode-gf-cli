import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { writeFileAtomic } from "../../core/atomic-write";
import { checkLayout, type LayoutCheckResult } from "../../dashboard/layout/check";
import { diffLayout, layoutFingerprint } from "../../dashboard/layout/diff";
import { detectIndent, fixLayout, unsafeFix } from "../../dashboard/layout/fix";
import { buildLayoutGraph, type LayoutGraph } from "../../dashboard/layout/graph";
import { renderLayoutTree } from "../../dashboard/layout/show";
import type { CommandAppContext } from "../runtime";

const SkippedJsonFiles = new Set(["bundle.meta.json", "grafana.manifest.json", "_folder.json"]);

function collectJsonFiles(sources: string[]): string[] {
  const files: string[] = [];
  for (const source of sources) {
    const resolved = path.resolve(source);
    if (!fs.existsSync(resolved)) throw new Error(`Source not found: ${source}`);
    if (fs.statSync(resolved).isFile()) {
      files.push(resolved);
      continue;
    }
    const queue = [resolved];
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) queue.push(full);
        else if (name.endsWith(".json") && !SkippedJsonFiles.has(name) && !name.endsWith(".meta.json")) {
          files.push(full);
        }
      }
    }
  }
  return files;
}

export function loadLayoutGraph(file: string): LayoutGraph | undefined {
  return buildLayoutGraph(JSON.parse(fs.readFileSync(file, "utf8")));
}

function relative(file: string) {
  return path.relative(process.cwd(), file) || file;
}

function printCheckText(file: string, result: LayoutCheckResult) {
  const errors = result.issues.filter((issue) => issue.severity === "error");
  const warnings = result.issues.filter((issue) => issue.severity === "warning");
  const status = errors.length > 0 ? "ERROR" : warnings.length > 0 ? "WARN" : "OK";
  console.log(
    `[${status}] ${relative(file)} (${result.format}, ${result.panels} panels, ${errors.length} errors, ${warnings.length} warnings)`,
  );
  for (const issue of result.issues) {
    const location = [issue.container ? `in ${issue.container}` : undefined, issue.path]
      .filter(Boolean)
      .join(" @ ");
    console.log(`  ${issue.severity} ${issue.code}: ${issue.message}${location ? `\n    ${location}` : ""}`);
  }
}

export function buildDashboardLayoutCommand(app: CommandAppContext): Command {
  const { parseCommonOptions } = app.runtime;
  const layout = new Command("layout").description(
    "Inspect, lint and diff dashboard layout from local files (classic gridPos, v2 Tabs/Rows/Grid/AutoGrid); works offline",
  );

  layout
    .command("show <FILE>")
    .description("Print the layout tree: tabs/rows/panels with x/y/w/h")
    .option("--json", "print normalized layout items as json")
    .action(function layoutShowAction(file: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command, { requireUrl: false });
      const graph = loadLayoutGraph(path.resolve(file));
      if (!graph) throw new Error(`Not a dashboard: ${file}`);
      if (options.json || ctx.output === "json") {
        const { elementPanelIds: _ids, ...rest } = graph;
        console.log(JSON.stringify({ ...rest, fingerprint: layoutFingerprint(graph) }, null, 2));
        return;
      }
      console.log(renderLayoutTree(graph));
    });

  layout
    .command("check [sources...]")
    .alias("lint")
    .description(
      "Lint layout: overlap, out-of-bounds, duplicate panel id, v2 missing/duplicate/orphan element; exit 1 on errors, 2 on warnings",
    )
    .option("--json", "print results as json")
    .action(function layoutCheckAction(sources: string[] | undefined, options) {
      const ctx = parseCommonOptions(this as unknown as Command, { requireUrl: false });
      const files = collectJsonFiles(sources && sources.length > 0 ? sources : ["."]);
      const results: Array<LayoutCheckResult & { file: string }> = [];
      for (const file of files) {
        let graph: LayoutGraph | undefined;
        try {
          graph = loadLayoutGraph(file);
        } catch (error) {
          results.push({
            file,
            format: "classic",
            title: "",
            panels: 0,
            issues: [
              {
                severity: "error",
                code: "invalid-rect",
                message: `invalid JSON: ${(error as Error).message}`,
              },
            ],
          });
          continue;
        }
        if (graph) results.push({ file, ...checkLayout(graph) });
      }
      const errors = results.reduce((n, r) => n + r.issues.filter((i) => i.severity === "error").length, 0);
      const warnings = results.reduce(
        (n, r) => n + r.issues.filter((i) => i.severity === "warning").length,
        0,
      );
      if (options.json || ctx.output === "json") {
        console.log(
          JSON.stringify(
            {
              ok: errors === 0,
              dashboards: results.length,
              errors,
              warnings,
              results: results.map((r) => ({ ...r, file: relative(r.file) })),
            },
            null,
            2,
          ),
        );
      } else {
        for (const result of results) {
          if (result.issues.length > 0 || results.length <= 5) printCheckText(result.file, result);
        }
        const failed = results.filter((r) => r.issues.some((i) => i.severity === "error")).length;
        console.log(
          `Summary: ${results.length} dashboards, ${failed} with errors, ${errors} errors, ${warnings} warnings`,
        );
      }
      if (errors > 0) process.exitCode = 1;
      else if (warnings > 0) process.exitCode = 2;
    });

  layout
    .command("diff <BASE> <CANDIDATE>")
    .description(
      "Compare layout of two dashboard files: added/removed/moved/resized/reparented; exit 1 if changed",
    )
    .option("--json", "print diff as json")
    .action(function layoutDiffAction(base: string, candidate: string, options) {
      const ctx = parseCommonOptions(this as unknown as Command, { requireUrl: false });
      const a = loadLayoutGraph(path.resolve(base));
      const b = loadLayoutGraph(path.resolve(candidate));
      if (!a || !b) throw new Error("Both BASE and CANDIDATE must be dashboard JSON files");
      const diff = diffLayout(a, b);
      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify(diff, null, 2));
      } else if (!diff.changed) {
        console.log("Layout unchanged.");
      } else {
        for (const item of diff.items) {
          const arrow = [item.from, item.to].filter(Boolean).join(" -> ");
          console.log(
            `${item.change.padEnd(10)} ${item.key}${item.title ? ` "${item.title}"` : ""}  ${arrow}`,
          );
        }
        for (const name of diff.containers.added) console.log(`added      container ${name}`);
        for (const name of diff.containers.removed) console.log(`removed    container ${name}`);
        for (const name of diff.containers.changed) console.log(`options    container ${name}`);
        if (diff.containers.reordered) console.log("reordered  containers");
      }
      if (diff.changed) process.exitCode = 1;
    });

  layout
    .command("fix [sources...]")
    .description(
      "Rewrite gridPos to the positions Grafana actually renders (removes overlaps and negative y, sorts panels[]); never moves panels between rows/tabs",
    )
    .option("--json", "print results as json")
    .action(function layoutFixAction(sources: string[] | undefined, options) {
      const ctx = parseCommonOptions(this as unknown as Command, { requireUrl: false });
      const files = collectJsonFiles(sources && sources.length > 0 ? sources : ["."]);
      const results: Array<Record<string, unknown>> = [];
      let failed = false;
      for (const file of files) {
        let original: string;
        let doc: unknown;
        try {
          original = fs.readFileSync(file, "utf8");
          doc = JSON.parse(original);
        } catch {
          continue;
        }
        const before = buildLayoutGraph(doc);
        if (!before) continue;
        const fixed = structuredClone(doc);
        let outcome: ReturnType<typeof fixLayout>;
        try {
          outcome = fixLayout(fixed);
        } catch (error) {
          outcome = { changed: false, skipped: (error as Error).message };
        }
        const after = buildLayoutGraph(fixed) as LayoutGraph;
        const reason = outcome.skipped ?? unsafeFix(before, after);
        const remaining = checkLayout(after).issues.filter((issue) => issue.severity === "error");
        let written = false;
        let writeError: string | undefined;
        if (!reason && outcome.changed && !ctx.dryRun) {
          try {
            writeFileAtomic(file, `${JSON.stringify(fixed, null, detectIndent(original))}\n`, original);
            written = true;
          } catch (error) {
            writeError = (error as Error).message;
          }
        }
        const skipped = reason ?? writeError;
        if (skipped || remaining.length > 0) failed = true;
        if (!outcome.changed && !skipped && remaining.length === 0) continue;
        results.push({
          file: relative(file),
          changed: outcome.changed && !skipped,
          written,
          skipped,
          changes: reason ? [] : diffLayout(before, after).items,
          remainingErrors: (reason ? checkLayout(before) : checkLayout(after)).issues
            .filter((issue) => issue.severity === "error")
            .map((issue) => `${issue.code}: ${issue.message}`),
        });
      }
      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify({ dryRun: ctx.dryRun, results }, null, 2));
      } else {
        for (const result of results) {
          const state = result.skipped ? "SKIP" : ctx.dryRun ? "PLAN" : result.written ? "FIXED" : "OK";
          console.log(`[${state}] ${result.file}${result.skipped ? `: ${result.skipped}` : ""}`);
          for (const change of result.changes as Array<Record<string, string>>) {
            const title = change.title ? ` "${change.title}"` : "";
            console.log(`  ${change.change.padEnd(8)} ${change.key}${title}  ${change.from} -> ${change.to}`);
          }
          for (const error of result.remainingErrors as string[]) console.log(`  still: ${error}`);
        }
        const changedCount = results.filter((r) => r.changed).length;
        const skippedCount = results.filter((r) => r.skipped).length;
        console.log(
          `${ctx.dryRun ? "[DRY-RUN] " : ""}${changedCount} dashboards ${ctx.dryRun ? "would change" : "fixed"}, ${skippedCount} skipped`,
        );
      }
      if (failed) process.exitCode = 1;
    });

  return layout;
}
