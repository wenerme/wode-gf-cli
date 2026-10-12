import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { checkLayout, type LayoutIssue } from "../../dashboard/layout/check";
import { diffLayout, layoutFingerprint } from "../../dashboard/layout/diff";
import { buildLayoutGraph } from "../../dashboard/layout/graph";
import { isDashboardResourceV2 } from "../../dashboard/model";
import { asObject, getObjectField } from "../../lib/json-narrow";
import { jsonPathRegex, jsonPathSet } from "../../lib/jsonpath-patch";
import type { CommandAppContext } from "../runtime";
import { collectVariadic, panelScopedJsonPathsFor, parseJsonPathValue } from "./shared";

type PatchOperation =
  | { kind: "set"; path: string; value: unknown }
  | { kind: "regex"; path: string; pattern: string; replacement: string };

function errorKey(issue: LayoutIssue) {
  // Item issues are identified by panel/element key (stable across reorders); structural issues
  // without a key (missing-layout, unknown kinds) are identified by their JSON path.
  return `${issue.code}|${issue.key ?? `@${issue.path ?? ""}`}|${issue.otherKey ?? ""}`;
}

type DocumentFormat = { format: "classic" | "v2"; v2Root: string };

function documentFormat(data: unknown): DocumentFormat {
  const obj = asObject(data);
  if (isDashboardResourceV2(obj)) return { format: "v2", v2Root: "$" };
  if (isDashboardResourceV2(getObjectField(obj, "dashboard"))) return { format: "v2", v2Root: "$.dashboard" };
  return { format: "classic", v2Root: "$" };
}

function parseOperations(command: Command, options: Record<string, unknown>, doc: DocumentFormat) {
  const panelFilter = String(options.panelId || "ALL").trim();
  const scope = (pathArg: string) => {
    if (pathArg.trim().startsWith("$") && panelFilter.toUpperCase() !== "ALL") {
      throw new Error(
        `--panel-id ${panelFilter} cannot be combined with absolute path ${pathArg}: "$" paths start at the document root. Use a path relative to the panel, e.g. "title" or "gridPos.h"`,
      );
    }
    return panelScopedJsonPathsFor(doc.format, options.panelId as string, pathArg, doc.v2Root);
  };
  const values = command.args.slice(1);
  const setPaths = [...((options.set as string[][]) || [])].map((item) => item[0]);
  const regexPaths = [...((options.regex as string[][]) || [])].map((item) => item[0]);
  const operations: PatchOperation[] = [];
  let valueIndex = 0;
  for (const pathArg of setPaths) {
    const valueArg = values[valueIndex];
    if (!pathArg || valueArg === undefined) throw new Error("--set requires <jsonpath> <value>");
    for (const scopedPath of scope(pathArg)) {
      operations.push({ kind: "set", path: scopedPath, value: parseJsonPathValue(valueArg) });
    }
    valueIndex += 1;
  }
  for (const pathArg of regexPaths) {
    const pattern = values[valueIndex];
    const replacement = values[valueIndex + 1];
    if (!pathArg || pattern === undefined || replacement === undefined) {
      throw new Error("--regex requires <jsonpath> <pattern> <replacement>");
    }
    for (const scopedPath of scope(pathArg)) {
      operations.push({ kind: "regex", path: scopedPath, pattern, replacement });
    }
    valueIndex += 2;
  }
  if (valueIndex < values.length) {
    throw new Error(`Unexpected extra patch arguments: ${values.slice(valueIndex).join(" ")}`);
  }
  if (operations.length === 0) throw new Error("No patch operation provided. Use --set or --regex.");
  return operations;
}

function writeAtomic(file: string, content: string, expectedOriginal: string) {
  // Resolve symlinks so rename replaces the target, not the link.
  const target = fs.realpathSync(file);
  if (fs.readFileSync(target, "utf8") !== expectedOriginal) {
    throw new Error(`${file} changed on disk while patching; re-run against the latest content`);
  }
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  // `wx` refuses to follow or truncate a pre-existing file/symlink at the temp path.
  fs.writeFileSync(temp, content, { encoding: "utf8", mode: fs.statSync(target).mode, flag: "wx" });
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export function attachDashboardPatchFile(scoped: Command, app: CommandAppContext) {
  const { parseCommonOptions, printMessage } = app.runtime;
  scoped
    .command("patch-file <FILE>")
    .alias("patch")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .description(
      "Patch local dashboard JSON (classic or v2) with JSONPath set/regex; all-or-nothing, fails on 0 matches or new layout errors",
    )
    .option(
      "--panel-id <ids>",
      "panels to patch with relative paths such as title or gridPos.h: ALL or comma-separated ids (classic panels[].id, v2 elements[].spec.id); cannot be combined with $ paths",
      "ALL",
    )
    .option("--set <jsonpath>", "set JSONPath value; value is the next token", collectVariadic, [])
    .option(
      "--regex <jsonpath>",
      "regex replace JSONPath string values; pattern/replacement are next tokens",
      collectVariadic,
      [],
    )
    .option("--allow-no-match", "do not fail when an operation matches nothing")
    .option("--forbid-layout-change", "fail if the patch changes any panel position/size/membership")
    .option(
      "--allow-layout-errors",
      "write even if the patch introduces new layout errors (overlap, out-of-bounds)",
    )
    .option("--compact", "write compact json")
    .option("--json", "print patch summary as json")
    .action(function dashboardPatchFileAction(file: string, options) {
      const command = this as unknown as Command;
      const ctx = parseCommonOptions(command, { requireUrl: false });
      const resolvedFile = path.resolve(file);
      const original = fs.readFileSync(resolvedFile, "utf8");
      const before = JSON.parse(original);
      const doc = documentFormat(before);
      const format = doc.format;
      const operations = parseOperations(command, options, doc);

      // Work on a clone: nothing is written unless every operation and check passes.
      const data = structuredClone(before);
      const results = operations.map((operation) => {
        const result =
          operation.kind === "set"
            ? jsonPathSet(data, operation.path, operation.value)
            : jsonPathRegex(data, operation.path, operation.pattern, operation.replacement);
        return { ...operation, ...result };
      });

      const failures: string[] = [];
      const unmatched = results.filter((result) => result.matched === 0);
      if (unmatched.length > 0 && !options.allowNoMatch) {
        const hint =
          format === "v2"
            ? " (v2 dashboard: relative paths resolve under spec.elements[*].spec, e.g. title or data.spec.queries[0].spec.query.spec.expr)"
            : "";
        failures.push(
          `${unmatched.length} operation(s) matched nothing: ${unmatched.map((r) => r.path).join(", ")}${hint}`,
        );
      }

      const graphBefore = buildLayoutGraph(before);
      const graphAfter = buildLayoutGraph(data);
      let layout: Record<string, unknown> | undefined;
      if (graphBefore && !graphAfter) {
        failures.push("patch removes the dashboard layout (panels/spec.layout no longer recognized)");
      }
      if (graphBefore && graphAfter) {
        const diff = diffLayout(graphBefore, graphAfter);
        // Only baseline *errors* offset new errors; a warning that becomes an error is new.
        const known = new Set(
          checkLayout(graphBefore)
            .issues.filter((issue) => issue.severity === "error")
            .map(errorKey),
        );
        const introduced = checkLayout(graphAfter).issues.filter(
          (issue) => issue.severity === "error" && !known.has(errorKey(issue)),
        );
        layout = {
          changed: diff.changed,
          fingerprintBefore: layoutFingerprint(graphBefore),
          fingerprintAfter: layoutFingerprint(graphAfter),
          changes: diff.items,
          introducedErrors: introduced,
        };
        if (diff.changed && options.forbidLayoutChange) {
          failures.push(
            `layout changed (${diff.items.length} item changes) but --forbid-layout-change is set`,
          );
        }
        if (introduced.length > 0 && !options.allowLayoutErrors) {
          failures.push(
            `patch introduces ${introduced.length} layout error(s): ${introduced.map((i) => i.message).join("; ")}`,
          );
        }
      }

      // Compare final documents so net-zero edits (A->B->A) do not rewrite the file.
      const changed = JSON.stringify(before) !== JSON.stringify(data);
      const write = failures.length === 0 && changed && !ctx.dryRun;
      if (write)
        writeAtomic(resolvedFile, `${JSON.stringify(data, null, options.compact ? 0 : 2)}\n`, original);

      const summary = {
        file: resolvedFile,
        format,
        dryRun: ctx.dryRun,
        written: write,
        ok: failures.length === 0,
        failures,
        operations: results,
        layout,
      };
      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        const lines = results.map(
          (result) => `${result.kind} ${result.path}: matched ${result.matched}, changed ${result.changed}`,
        );
        if (layout) {
          lines.push(
            layout.changed
              ? `layout: CHANGED (${(layout.changes as unknown[]).length} item changes)`
              : "layout: unchanged",
          );
        }
        if (ctx.dryRun) lines.push("[DRY-RUN] file not written");
        else if (!changed && failures.length === 0) lines.push("no changes; file not written");
        printMessage(ctx, lines.join("\n"));
      }
      if (failures.length > 0) {
        throw new Error(`patch-file aborted, file not written: ${failures.join(" | ")}`);
      }
    });
}
