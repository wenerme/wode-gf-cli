import type { Command } from "commander";
import { GrafanaClient } from "../client";
import {
  buildPauseUpdate,
  compactLabels,
  decodeHistoryFrame,
  decodePrometheusRules,
  FailOnValues,
  failingRules,
  formatAge,
  formatLocalIso,
  formatValues,
  type JsonObject,
  parseLabelFilters,
  RuleHealthFilters,
  type RuleRuntime,
  RuleStateFilters,
  selectHistoryRows,
  splitListValues,
  truncate,
  validateChoices,
} from "../lib/alert-runtime";
import { parseLabelMatcher } from "../lib/alert-silence";
import { asObject, asString } from "../lib/json-narrow";
import { parsePositiveInt, resolveTimeToMs } from "../utils";
import { selectResourceByToken } from "./mutate/shared";
import type { CliContext, CommandAppContext } from "./runtime";

const RulesPath = "/api/prometheus/grafana/api/v1/rules";
const MaxRulePages = 50;

type ResolvedRule = { uid: string; title: string };

function wantsJson(ctx: CliContext, options: { json?: boolean }) {
  return Boolean(options.json) || ctx.output === "json";
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

/** Resolve UID or TITLE tokens the same way `alert-rule get` does (provisioning rule list). */
export async function resolveAlertRuleTokens(
  ctx: CliContext,
  app: CommandAppContext,
  tokens: string[],
): Promise<ResolvedRule[]> {
  if (tokens.length === 0) return [];
  const { fetchResources, resourceItems, selectResource } = app.runtime;
  const remote = await fetchResources(new GrafanaClient(ctx), ["alert-rules"]);
  const items = resourceItems(remote, "alert-rules");
  const resolved = new Map<string, ResolvedRule>();
  for (const token of tokens) {
    const rule = asObject(selectResourceByToken(items, "alert-rules", token, selectResource));
    const uid = asString(rule?.uid);
    if (!uid) throw new Error(`Alert rule ${token} has no uid`);
    resolved.set(uid, { uid, title: asString(rule?.title) || uid });
  }
  return [...resolved.values()];
}

async function fetchRuleRuntime(
  ctx: CliContext,
  params: URLSearchParams,
  pageSize: number,
): Promise<{ rules: RuleRuntime[]; truncated: boolean; pages: number }> {
  const client = new GrafanaClient(ctx);
  const rules: RuleRuntime[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const query = new URLSearchParams(params);
    query.set("group_limit", String(pageSize));
    if (token) query.set("group_next_token", token);
    const page = decodePrometheusRules(await client.request<unknown>("GET", `${RulesPath}?${query}`));
    rules.push(...page.rules);
    token = page.nextToken;
    pages += 1;
  } while (token && pages < MaxRulePages);
  return { rules, truncated: Boolean(token), pages };
}

function renderRuleRows(app: CommandAppContext, rules: RuleRuntime[], nowMs: number) {
  return app.runtime.renderTable(
    ["state", "health", "uid", "title", "folder/group", "last eval", "firing", "pending", "error"],
    rules.map((rule) => [
      rule.isPaused ? `${rule.state} (paused)` : rule.state,
      rule.health,
      rule.uid,
      truncate(rule.title, 48),
      `${rule.folder || rule.folderUid || ""}/${rule.group}`,
      rule.lastEvaluation ? `${formatAge(rule.lastEvaluation, nowMs)} ago` : "never",
      String(rule.counts.firing),
      String(rule.counts.pending),
      truncate(rule.lastError, 60),
    ]),
  );
}

function renderInstanceRows(app: CommandAppContext, rules: RuleRuntime[], nowMs: number) {
  const rows = rules.flatMap((rule) =>
    (rule.instances || []).map((instance) => [
      rule.uid,
      instance.state,
      instance.activeAt ? formatAge(instance.activeAt, nowMs) : "-",
      truncate(instance.value, 24),
      compactLabels(instance.labels, ["alertname", "grafana_folder"], 100),
    ]),
  );
  if (rows.length === 0) return "No alert instances.";
  return app.runtime.renderTable(["uid", "instance state", "active for", "value", "labels"], rows);
}

function attachStateCommand(scoped: Command, app: CommandAppContext) {
  const { collectList, runtime } = app;
  scoped
    .command("state [RULES...]")
    .description("Show alert rule runtime state (Prometheus-compatible rules API)")
    .option(
      "--state <state>",
      `rule state filter, repeatable or comma list: ${RuleStateFilters.join("|")}`,
      collectList,
      [],
    )
    .option(
      "--health <health>",
      `rule health filter, repeatable or comma list: ${RuleHealthFilters.join("|")}`,
      collectList,
      [],
    )
    .option("--folder <folderUid>", "filter by folder uid")
    .option("--group <name>", "filter by rule group, repeatable", collectList, [])
    .option(
      "--matcher <expr>",
      "filter rules by rule labels (k=v, k!=v, k=~re, k!~re), repeatable",
      collectList,
      [],
    )
    .option(
      "--instance-matcher <expr>",
      "filter returned alert instances by instance labels, repeatable",
      collectList,
      [],
    )
    .option("--paused", "only show paused rules")
    .option("--instances", "also show per-rule alert instances")
    .option("--fail-on <list>", `exit 1 when any rule matches: ${FailOnValues.join(",")}`, collectList, [])
    .option("--page-size <n>", "rule groups per API page", "100")
    .option("--json", "print {rules:[...]} as json")
    .action(async function alertRuleStateAction(tokens: string[], options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const states = validateChoices(splitListValues(options.state), RuleStateFilters, "--state");
      const health = validateChoices(splitListValues(options.health), RuleHealthFilters, "--health");
      const failOn = validateChoices(splitListValues(options.failOn), FailOnValues, "--fail-on");
      const ruleMatchers = (options.matcher as string[]).map((item) => parseLabelMatcher(item));
      const instanceMatchers = (options.instanceMatcher as string[]).map((item) => parseLabelMatcher(item));

      const params = new URLSearchParams();
      for (const rule of await resolveAlertRuleTokens(ctx, app, tokens)) params.append("rule_uid", rule.uid);
      if (options.folder) params.set("folder_uid", String(options.folder).trim());
      for (const group of options.group as string[]) params.append("rule_group", group);
      for (const state of states) params.append("state", state);
      for (const item of health) params.append("health", item);
      for (const matcher of ruleMatchers) params.append("rule_matcher", JSON.stringify(matcher));
      for (const matcher of instanceMatchers) params.append("matcher", JSON.stringify(matcher));
      // Totals are computed before the per-rule alert limit, so counts stay correct with limit_alerts=0.
      if (!options.instances) params.set("limit_alerts", "0");

      const result = await fetchRuleRuntime(ctx, params, parsePositiveInt(options.pageSize, 100));
      const rules = (options.paused ? result.rules.filter((rule) => rule.isPaused) : result.rules).map(
        (rule) => (options.instances ? rule : { ...rule, instances: undefined }),
      );
      if (result.truncated) {
        console.error(`[WARN] stopped after ${MaxRulePages} pages; narrow filters to see all rules`);
      }
      const failed = failingRules(rules, failOn);
      const nowMs = Date.now();

      if (wantsJson(ctx, options)) {
        printJson({
          rules,
          ...(result.truncated ? { truncated: true } : {}),
          ...(failOn.length > 0 ? { failOn, failed: failed.map((rule) => rule.uid) } : {}),
        });
      } else if (rules.length === 0) {
        runtime.printMessage(ctx, "No alert rules matched.");
      } else {
        runtime.printMessage(ctx, renderRuleRows(app, rules, nowMs));
        if (options.instances) runtime.printMessage(ctx, `\n${renderInstanceRows(app, rules, nowMs)}`);
        if (failed.length > 0) {
          runtime.printMessage(ctx, `\n[FAIL] ${failed.length} rule(s) match --fail-on ${failOn.join(",")}`);
        }
      }
      if (failed.length > 0) process.exitCode = 1;
    });
}

function attachHistoryCommand(scoped: Command, app: CommandAppContext) {
  const { collectList, runtime } = app;
  scoped
    .command("history <RULE>")
    .description("Show alert rule state transitions (state history)")
    .option("--from <time>", "start time", "now-24h")
    .option("--to <time>", "end time", "now")
    .option("--limit <n>", "max rows (newest first)", "100")
    .option("--label <k=v>", "filter by instance label, repeatable", collectList, [])
    .option("--json", "print decoded rows as json")
    .action(async function alertRuleHistoryAction(token: string, options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const [rule] = await resolveAlertRuleTokens(ctx, app, [token]);
      if (!rule) throw new Error(`No alert rule matched ${token}`);
      const nowMs = Date.now();
      const fromMs = resolveTimeToMs(String(options.from), nowMs);
      const toMs = resolveTimeToMs(String(options.to), nowMs);
      if (fromMs > toMs) throw new Error("--from must be before --to");
      const limit = parsePositiveInt(options.limit, 100);
      const labels = parseLabelFilters(options.label);

      // The history API takes from/to as epoch seconds.
      const params = new URLSearchParams({
        ruleUID: rule.uid,
        from: String(Math.floor(fromMs / 1000)),
        to: String(Math.ceil(toMs / 1000)),
        limit: String(limit),
      });
      for (const [key, value] of Object.entries(labels)) params.set(`labels_${key}`, value);
      const frame = await new GrafanaClient(ctx).request<unknown>("GET", `/api/v1/rules/history?${params}`);
      const rows = selectHistoryRows(decodeHistoryFrame(frame), { labels, limit });

      if (wantsJson(ctx, options)) {
        printJson({
          rule,
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          rows: rows.map(({ text: _text, ...row }) => row),
        });
        return;
      }
      if (rows.length === 0) {
        runtime.printMessage(ctx, `No state transitions for ${rule.uid} in range.`);
        return;
      }
      runtime.printMessage(
        ctx,
        runtime.renderTable(
          ["time", "transition", "labels", "values"],
          rows.map((row) => [
            formatLocalIso(row.timeMs),
            `${row.prev || "?"} -> ${row.next || "?"}`,
            compactLabels(row.labels, ["alertname", "grafana_folder"], 80),
            row.error ? truncate(`error: ${row.error}`, 60) : formatValues(row.values),
          ]),
        ),
      );
    });
}

const PauseHelp = `
Read-modify-write on /api/v1/provisioning/alert-rules/{uid}: GET, flip isPaused, PUT, GET readback.
There is no server-side version precondition, so an edit made between the GET and PUT is overwritten;
the window is one GET+PUT per rule. Provenance is preserved: X-Disable-Provenance is sent only for rules
without provenance. Rules already in the target state are skipped.`;

function attachPauseCommand(scoped: Command, app: CommandAppContext, paused: boolean) {
  const { runtime } = app;
  const name = paused ? "pause" : "resume";
  scoped
    .command(`${name} <RULES...>`)
    .description(paused ? "Pause alert rule evaluation" : "Resume paused alert rule evaluation")
    .option("--json", "print results as json")
    .addHelpText("after", PauseHelp)
    .action(async function alertRulePauseAction(tokens: string[], options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const client = new GrafanaClient(ctx);
      const results: JsonObject[] = [];
      for (const rule of await resolveAlertRuleTokens(ctx, app, tokens)) {
        const path = `/api/v1/provisioning/alert-rules/${encodeURIComponent(rule.uid)}`;
        const current = asObject(await client.request<unknown>("GET", path));
        if (!current) throw new Error(`Alert rule ${rule.uid} response is not an object`);
        const update = buildPauseUpdate(current, paused);
        const base = {
          uid: rule.uid,
          title: asString(current.title) || rule.title,
          from: update.from,
          to: update.to,
          provenance: update.provenance || "none",
        };
        if (!update.changed) {
          results.push({ ...base, action: "skipped" });
          continue;
        }
        if (ctx.dryRun) {
          results.push({ ...base, action: "dry-run", headers: update.headers, body: update.body });
          continue;
        }
        await client.request("PUT", path, update.body, [200], update.headers);
        const readback = asObject(await client.request<unknown>("GET", path));
        const readbackProvenance = asString(readback?.provenance) || "";
        if (readback?.isPaused !== paused || readbackProvenance !== update.provenance) {
          throw new Error(
            `Readback mismatch for ${rule.uid}: isPaused=${String(readback?.isPaused)} provenance=${
              readbackProvenance || "none"
            }`,
          );
        }
        results.push({ ...base, action: "updated" });
      }

      if (wantsJson(ctx, options)) {
        printJson({ type: name, dryRun: ctx.dryRun, results });
        return;
      }
      runtime.printMessage(
        ctx,
        runtime.renderTable(
          ["uid", "title", "isPaused", "action"],
          results.map((item) => [
            String(item.uid),
            truncate(String(item.title), 48),
            `${String(item.from)} -> ${String(item.to)}`,
            String(item.action),
          ]),
        ),
      );
      if (ctx.dryRun) {
        for (const item of results.filter((entry) => entry.action === "dry-run")) {
          runtime.printMessage(
            ctx,
            `[DRY-RUN] PUT ${item.uid} isPaused=${String(item.to)} headers=${JSON.stringify(item.headers)}`,
          );
        }
        runtime.printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
      }
    });
}

export function attachAlertRuleRuntimeOps(scoped: Command, app: CommandAppContext) {
  attachStateCommand(scoped, app);
  attachHistoryCommand(scoped, app);
  attachPauseCommand(scoped, app, true);
  attachPauseCommand(scoped, app, false);
}
