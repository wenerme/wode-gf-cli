import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { GrafanaClient } from "../client";
import { type JsonObject, stripMeta } from "../core/json";
import { formatJsonChanges } from "../core/json-diff";
import {
  type AlertRuleVersion,
  comparableAlertRule,
  getCurrentAlertRule,
  listAlertRuleVersions,
  resolveAlertRuleUid,
} from "../lib/alert-rule-versions";
import { orderChanged, writeAlertRule } from "../lib/alert-rule-write";
import { asObject, asString } from "../lib/json-narrow";
import type { CommandAppContext } from "./runtime";
import {
  clip,
  diffJson,
  parseVersionNumber,
  parseVersionRef,
  printChanges,
  readJsonFile,
  shortTime,
} from "./versions-shared";

/** A rule from a local file: single rule, array of rules, or export bundle `{ "alert-rules": [...] }`. */
function ruleFromLocal(value: unknown, uid: string): JsonObject {
  const object = asObject(value);
  const items = Array.isArray(value)
    ? value
    : Array.isArray(object?.["alert-rules"])
      ? (object?.["alert-rules"] as unknown[])
      : [value];
  const rules = items
    .map((item) => asObject(stripMeta(item)))
    .filter((item): item is JsonObject => Boolean(item));
  const hit = rules.length === 1 ? rules[0] : rules.find((rule) => asString(rule.uid) === uid);
  if (!hit) throw new Error(`No alert rule ${uid} found in local file`);
  return hit;
}

function pick(
  list: AlertRuleVersion[],
  token: string,
): { label: string; rule: JsonObject; version?: AlertRuleVersion } {
  const ref = parseVersionRef(token);
  if (ref.kind === "file") {
    const uid = asString(list[0]?.rule.uid) || "";
    return { label: path.basename(ref.file), rule: ruleFromLocal(readJsonFile(ref.file), uid) };
  }
  const hit = ref.kind === "version" ? list.find((item) => item.version === ref.version) : list[ref.back];
  if (!hit) throw new Error(`Alert rule has no version ${token}`);
  return {
    label: list[0] === hit ? `current (v${hit.version})` : `v${hit.version}`,
    rule: hit.rule,
    version: hit,
  };
}

export function buildAlertRuleVersionsCommand(app: CommandAppContext): Command {
  const { parseCommonOptions, printMessage, renderTable } = app.runtime;
  const versions = new Command("versions")
    .alias("version")
    .description("List, inspect, diff and restore alert rule config versions (not state history)");

  const load = async (command: Command, id: string) => {
    const ctx = parseCommonOptions(command);
    const client = new GrafanaClient(ctx);
    const uid = await resolveAlertRuleUid(client, id);
    const list = await listAlertRuleVersions(client, uid);
    if (list.length === 0) throw new Error(`Alert rule ${uid} has no versions`);
    return { ctx, client, uid, list };
  };

  versions
    .command("list <UID>")
    .description("List config versions, newest first")
    .option("--limit <n>", "max versions", "20")
    .option("--json", "print versions as json")
    .action(async function ruleVersionsListAction(id: string, options) {
      const { ctx, uid, list } = await load(this as unknown as Command, id);
      const limit = parseVersionNumber(options.limit, "--limit") ?? 20;
      const rows = list.slice(0, limit).map(({ rule, ...meta }, index) => ({
        ...meta,
        title: asString(rule.title),
        paused: Boolean(rule.isPaused),
        // What changed relative to the next older version, as top-level fields: a quick "why" for the row.
        changed: list[index + 1]
          ? [
              ...new Set(
                diffJson(comparableAlertRule(list[index + 1]?.rule || {}), comparableAlertRule(rule)).map(
                  (c) => c.path.split(/[.[]/)[1] || c.path,
                ),
              ),
            ]
          : [],
      }));
      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify({ uid, versions: rows }, null, 2));
        return;
      }
      const table = rows.map((row) => [
        String(row.version),
        shortTime(row.updated),
        row.updatedBy || "",
        row.paused ? "paused" : "",
        clip(row.changed.join(","), 40),
        clip(row.message, 40),
      ]);
      printMessage(ctx, renderTable(["VERSION", "UPDATED", "BY", "PAUSED", "CHANGED", "MESSAGE"], table));
    });

  versions
    .command("get <UID> <VERSION>")
    .description("Print one version as a provisioning rule (import-ready)")
    .option("-o, --out <file>", "write to file instead of stdout")
    .action(async function ruleVersionsGetAction(id: string, token: string, options) {
      const { ctx, list } = await load(this as unknown as Command, id);
      const side = pick(list, token);
      const text = `${JSON.stringify(side.rule, null, 2)}\n`;
      if (options.out) {
        fs.writeFileSync(path.resolve(String(options.out)), text);
        printMessage(ctx, `Wrote ${side.label} to ${options.out}`);
      } else process.stdout.write(text);
    });

  versions
    .command("diff <UID> <FROM> [TO]")
    .description(
      "Diff two versions; FROM/TO = N | current | current~N | local FILE (TO defaults to current); exit 2 if different",
    )
    .option("--json", "print changes as json")
    .action(async function ruleVersionsDiffAction(id: string, from: string, to: string | undefined, options) {
      const { ctx, list } = await load(this as unknown as Command, id);
      const a = pick(list, from);
      const b = pick(list, to || "current");
      const changes = diffJson(comparableAlertRule(a.rule), comparableAlertRule(b.rule));
      if (printChanges(app, ctx, { from: a.label, to: b.label }, changes, Boolean(options.json)))
        process.exitCode = 2;
    });

  versions
    .command("restore <UID> <VERSION>")
    .description(
      "Write an old version back in place: current folder/group, group order and provenance are kept. Grafana has no write precondition for rules; the version is re-checked right before writing. Honors --dry-run",
    )
    .option("--expect-version <n>", "abort unless the current version is N (what you reviewed)")
    .option("--json", "print result as json")
    .action(async function ruleVersionsRestoreAction(id: string, token: string, options) {
      const { ctx, client, uid, list } = await load(this as unknown as Command, id);
      const current = list[0] as AlertRuleVersion;
      const version = parseVersionNumber(token, "VERSION") as number;
      const expect = parseVersionNumber(options.expectVersion, "--expect-version");
      if (expect !== undefined && current.version !== expect) {
        throw new Error(
          `Alert rule ${uid} is at version ${current.version}, expected ${expect}; review again before restoring`,
        );
      }
      const target = list.find((item) => item.version === version);
      if (!target) throw new Error(`Alert rule ${uid} has no version ${version}`);
      // Restore keeps the current location, so compare against what will actually be written.
      const expected = {
        ...target.rule,
        folderUID: current.rule.folderUID,
        ruleGroup: current.rule.ruleGroup,
      };
      const changes = diffJson(comparableAlertRule(current.rule), comparableAlertRule(expected));
      const moved = ["folderUID", "ruleGroup"].filter((key) => current.rule[key] !== target.rule[key]);
      // The versions list omits provenance; check it now so --dry-run reports what the real run would do.
      const live = await getCurrentAlertRule(client, uid);
      if (live.provenance && live.provenance !== "api") {
        throw new Error(`Alert rule ${uid} is provisioned from ${live.provenance}; change it at the source`);
      }
      const base = {
        uid,
        from: current.version,
        to: target.version,
        changes: changes.length,
        keptLocation: moved,
      };
      const json = options.json || ctx.output === "json";
      const print = (line: string) => printMessage(ctx, line);
      if (changes.length === 0) {
        if (json) console.log(JSON.stringify({ ...base, action: "noop" }, null, 2));
        else
          print(
            `Alert rule ${uid} v${current.version} already equals v${target.version}; nothing to restore`,
          );
        return;
      }
      if (!json) {
        print(
          `${ctx.dryRun ? "[DRY-RUN] " : ""}restore ${uid} v${current.version} -> content of v${target.version}: ${changes.length} change(s)`,
        );
        for (const line of formatJsonChanges(changes)) print(`  ${line}`);
        if (moved.length > 0)
          print(`  (kept current ${moved.join("/")}; v${target.version} lived elsewhere)`);
      }
      if (ctx.dryRun) {
        if (json)
          console.log(JSON.stringify({ ...base, action: "plan", dryRun: true, diff: changes }, null, 2));
        return;
      }
      const written = await writeAlertRule(client, uid, expected, current.version);
      const after = written.rule;
      const residual = diffJson(comparableAlertRule(expected), comparableAlertRule(after.rule));
      const reordered = orderChanged(written);
      const outcome = {
        ...base,
        action: "restored",
        via: written.path,
        readback: after.version,
        residual: residual.length,
        reordered,
      };
      if (json) console.log(JSON.stringify({ ...outcome, diff: changes }, null, 2));
      else {
        print(`Restored as v${after.version} (via ${written.path}).`);
        if (residual.length > 0)
          print(
            `[WARN] readback differs in ${residual.length} path(s): ${residual.map((c) => c.path).join(", ")}`,
          );
        if (reordered)
          print(
            `[WARN] Grafana reordered group ${String(current.rule.ruleGroup)}: ${written.orderBefore.join(",")} -> ${written.orderAfter.join(",")} (provisioned group; single-rule PUT drops the index)`,
          );
      }
      if (residual.length > 0 || reordered || after.version !== current.version + 1) process.exitCode = 2;
    });

  return versions;
}
