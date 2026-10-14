import type { Command } from "commander";
import { GrafanaClient } from "../client";
import { getCurrentAlertRule } from "../lib/alert-rule-versions";
import { orderChanged, writeAlertRule } from "../lib/alert-rule-write";
import {
  compactLabels,
  decodeHistoryFrame,
  decodePrometheusRules,
  FailOnValues,
  failingRules,
  formatAge,
  formatLocalIso,
  formatValues,
  historyTruncated,
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
import { printJson, wantsJson } from "./versions-shared";

const RulesPath = "/api/prometheus/grafana/api/v1/rules";
const MaxRulePages = 50;

type ResolvedRule = { uid: string; title: string };

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
  filteredTotals: boolean,
): Promise<{ rules: RuleRuntime[]; truncated: boolean; pages: number }> {
  const client = new GrafanaClient(ctx);
  const rules: RuleRuntime[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const query = new URLSearchParams(params);
    query.set("group_limit", String(pageSize));
    if (token) query.set("group_next_token", token);
    const page = decodePrometheusRules(await client.request<unknown>("GET", `${RulesPath}?${query}`), {
      filteredTotals,
    });
    rules.push(...page.rules);
    pages += 1;
    // Grafana returns the same token again when it detects a paging loop (api_prometheus.go).
    if (page.nextToken && page.nextToken === token) return { rules, truncated: true, pages };
    token = page.nextToken;
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
    .option("--fail-on <list>", `exit 2 when any rule matches: ${FailOnValues.join(",")}`, collectList, [])
    .option("--page-size <n>", "rule groups per API page", "100")
    .option("--json", "print {rules:[...]} as json")
    .action(async function alertRuleStateAction(tokens: string[], options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const rawStates = splitListValues(options.state);
      const healthLike = rawStates.filter((item) => item === "error" || item === "nodata");
      if (healthLike.length > 0) {
        throw new Error(
          `--state ${healthLike.join(",")} never matches rules in Grafana; use --health ${healthLike.join(",")}`,
        );
      }
      const states = validateChoices(rawStates, RuleStateFilters, "--state");
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

      const filtered = instanceMatchers.length > 0;
      const result = await fetchRuleRuntime(ctx, params, parsePositiveInt(options.pageSize, 100), filtered);
      const rules = (options.paused ? result.rules.filter((rule) => rule.isPaused) : result.rules).map(
        (rule) => (options.instances ? rule : { ...rule, instances: undefined }),
      );
      if (result.truncated) {
        console.error(`[WARN] stopped after ${MaxRulePages} pages; narrow filters to see all rules`);
      }
      const failed = failingRules(rules, failOn, filtered);
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
      // 2 = a rule matched --fail-on (1 stays "the command failed"); incomplete data cannot pass a gate.
      if (failed.length > 0) process.exitCode = 2;
      if (failOn.length > 0 && result.truncated) {
        console.error("[ERROR] rule list truncated; --fail-on cannot be evaluated on incomplete data");
        process.exitCode = 1;
      }
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
      // Server-side label filters only help the Loki backend and reject quotes; local filtering is authoritative.
      for (const [key, value] of Object.entries(labels)) {
        if (/^[\w.:/@-]*$/.test(value)) params.set(`labels_${key}`, value);
      }
      const frame = await new GrafanaClient(ctx).request<unknown>("GET", `/api/v1/rules/history?${params}`);
      const decoded = decodeHistoryFrame(frame);
      const truncated = historyTruncated(decoded);
      const rows = selectHistoryRows(decoded, { labels, limit });
      if (truncated) {
        console.error(
          "[WARN] the annotation history backend returns at most 100 transitions; older ones (and label matches among them) are missing. Narrow --from/--to",
        );
      }

      if (wantsJson(ctx, options)) {
        printJson({
          rule,
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          ...(truncated ? { truncated: true } : {}),
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
Flips isPaused and nothing else. Rules in groups without provisioned rules are written by re-submitting the
ruler group (like the Grafana UI), which keeps the order of rules in the group; groups containing provisioned
rules fall back to the provisioning PUT, which Grafana may reorder (reported, exit 2). There is no server-side
precondition: the rule version is re-checked right before writing and verified by readback. Provenance is kept;
file-provisioned rules are refused. Rules already in the target state are skipped. Exit 1 if any rule failed.`;

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
        const base: JsonObject = { uid: rule.uid, title: rule.title, to: paused };
        try {
          const current = await getCurrentAlertRule(client, rule.uid);
          const from = current.rule.isPaused === true;
          Object.assign(base, {
            title: String(current.rule.title || rule.title),
            from,
            provenance: current.provenance || "none",
          });
          if (from === paused) {
            results.push({ ...base, action: "skipped" });
            continue;
          }
          if (current.provenance && current.provenance !== "api") {
            throw new Error(`provisioned from ${current.provenance}; change it at the source`);
          }
          if (ctx.dryRun) {
            results.push({ ...base, action: "dry-run" });
            continue;
          }
          const written = await writeAlertRule(
            client,
            rule.uid,
            { ...current.rule, isPaused: paused },
            current.version,
          );
          if (
            written.rule.rule.isPaused !== paused ||
            (written.rule.provenance || "none") !== base.provenance
          ) {
            throw new Error(
              `readback mismatch: isPaused=${String(written.rule.rule.isPaused)} provenance=${written.rule.provenance || "none"}`,
            );
          }
          const reordered = orderChanged(written);
          results.push({
            ...base,
            action: "updated",
            via: written.path,
            ...(reordered ? { reordered: written.orderAfter } : {}),
          });
        } catch (error) {
          results.push({ ...base, action: "failed", error: (error as Error).message });
        }
      }
      if (results.some((item) => item.action === "failed")) process.exitCode = 1;
      else if (results.some((item) => item.reordered)) process.exitCode = 2;

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
            `${String(item.from ?? "?")} -> ${String(item.to)}`,
            item.error ? `failed: ${truncate(String(item.error), 60)}` : String(item.action),
          ]),
        ),
      );
      for (const item of results.filter((entry) => entry.reordered)) {
        runtime.printMessage(
          ctx,
          `[WARN] Grafana reordered the group of ${String(item.uid)} (provisioned group): ${String(item.reordered)}`,
        );
      }
      if (ctx.dryRun) runtime.printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
    });
}

export function attachAlertRuleRuntimeOps(scoped: Command, app: CommandAppContext) {
  attachStateCommand(scoped, app);
  attachHistoryCommand(scoped, app);
  attachPauseCommand(scoped, app, true);
  attachPauseCommand(scoped, app, false);
}
