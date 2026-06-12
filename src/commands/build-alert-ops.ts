import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { GrafanaClient } from "../client";
import {
  type AlertRuleQueryResult,
  alertRuleLabels,
  alertRuleTitle,
  alertRuleUid,
  extractAlertRuleQueries,
  type JsonObject,
  lintAlertRuleThresholds,
  resultErrorMessage,
  resultHasFrames,
  validateAlertRuleExpressionRefs,
} from "../lib/alert-rule-ops";
import { asObject, asObjectArray } from "../lib/json-narrow";
import {
  findMatchingPolicyRoute,
  parseGroupBy,
  parsePolicyMatcher,
  routeLabel,
  upsertPolicyRoute,
} from "../lib/policy-route";
import { buildGrafanaMacros, resolveTemplateValue } from "../lib/template-vars";
import { type ResourceName, type ResourceSelector, ResourceSelectorSchema } from "../schema";
import { parsePositiveInt, parseVarAssignments, resolveTimeToMs } from "../utils";
import type { CliContext, CommandAppContext } from "./runtime";

type SelectResourceFn = (
  items: unknown[],
  resource: ResourceName,
  selector: ResourceSelector,
  allowMissing?: boolean,
) => unknown | undefined;

export function attachAlertRuleOps(scoped: Command, app: CommandAppContext) {
  const { collectList, runtime } = app;
  scoped
    .command("validate <TARGET>")
    .description("Validate alert rule datasource queries and expression refs")
    .option("--from <time>", "query time start", "now-1h")
    .option("--to <time>", "query time end", "now")
    .option("--timeout <ms>", "request timeout milliseconds", "60000")
    .option("--interval-ms <ms>", "grafana built-in interval in milliseconds", "60000")
    .option("--max-data-points <n>", "max datapoints", "1000")
    .option("--var <expr>", "variable override key=value, repeatable", collectList, [])
    .option("--json", "print validation result as json")
    .action(async function alertRuleValidateAction(target: string, options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const rules = await loadAlertRules(ctx, target, runtime);
      const result = await validateAlertRules(ctx, rules, runtime, {
        from: String(options.from || "now-1h"),
        to: String(options.to || "now"),
        timeoutMs: parsePositiveInt(options.timeout, 60_000),
        intervalMs: parsePositiveInt(options.intervalMs, 60_000),
        maxDataPoints: parsePositiveInt(options.maxDataPoints, 1_000),
        vars: parseVarAssignments(options.var || []),
      });
      printAlertRuleValidation(ctx, result, Boolean(options.json), runtime);
      setExitFromQueryResults(result.results, result.refIssues.length > 0);
    });

  scoped
    .command("lint <TARGET>")
    .description("Lint alert threshold evaluator semantics")
    .option("--json", "print warnings as json")
    .action(async function alertRuleLintAction(target: string, options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command, {
        requireUrl: !fs.existsSync(target),
      });
      const rules = await loadAlertRules(ctx, target, runtime);
      const warnings = rules.flatMap((rule) =>
        lintAlertRuleThresholds(rule).map((warning) => ({
          rule: alertRuleTitle(rule),
          uid: alertRuleUid(rule),
          ...warning,
        })),
      );
      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify({ warnings }, null, 2));
      } else if (warnings.length === 0) {
        runtime.printMessage(ctx, "[OK] no alert threshold semantic warnings");
      } else {
        for (const warning of warnings) {
          runtime.printMessage(ctx, `[WARN] ${warning.rule} / ${warning.message}`);
        }
      }
      if (warnings.length > 0) process.exitCode = 2;
    });

  scoped
    .command("check-closure <TARGET>")
    .description("Check alert operational asset closure")
    .option("--dashboard-dir <dir>", "local dashboard directory", "grafana/dashboard")
    .option("--docs-dir <dir>", "local alert docs directory", "docs/fusion/alters")
    .option("--json", "print closure result as json")
    .action(async function alertRuleClosureAction(target: string, options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command, {
        requireUrl: !fs.existsSync(target),
      });
      const rules = await loadAlertRules(ctx, target, runtime);
      const rule = rules[0];
      if (!rule) throw new Error("No alert rule found");
      const checks = await checkAlertClosure(ctx, rule, runtime, {
        dashboardDir: String(options.dashboardDir || "grafana/dashboard"),
        docsDir: String(options.docsDir || "docs/fusion/alters"),
      });
      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify({ rule: alertRuleTitle(rule), checks }, null, 2));
      } else {
        for (const check of checks) runtime.printMessage(ctx, `[${check.status}] ${check.message}`);
      }
      if (checks.some((check) => check.status === "ERROR")) process.exitCode = 1;
      else if (checks.some((check) => check.status === "WARN")) process.exitCode = 2;
    });
}

export function attachPolicyRouteOps(scoped: Command, app: CommandAppContext) {
  const { collectList, runtime } = app;
  const route = scoped.command("route").description("Manage notification policy routes");
  route
    .command("upsert")
    .description("Insert or update one notification policy route by matcher")
    .requiredOption("--receiver <name>", "receiver/contact point name")
    .requiredOption("--matcher <expr>", "matcher expression, repeatable", collectList, [])
    .option("--group-by <list>", "comma-separated group_by labels")
    .option("--group-wait <duration>", "group_wait duration")
    .option("--group-interval <duration>", "group_interval duration")
    .option("--repeat-interval <duration>", "repeat_interval duration")
    .option("-i, --in <file>", "local policy root JSON; default remote")
    .option("-o, --out <file>", "write updated local policy JSON")
    .option("--json", "print updated policy/result as json")
    .action(async function policyRouteUpsertAction(options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command, { requireUrl: !options.in });
      const matchers = (options.matcher || []).map((item: string) => parsePolicyMatcher(item));
      const policy = options.in ? loadPolicyFile(String(options.in)) : await fetchPolicy(ctx);
      const result = upsertPolicyRoute(policy, {
        receiver: String(options.receiver),
        matchers,
        groupBy: parseGroupBy(options.groupBy),
        groupWait: options.groupWait,
        groupInterval: options.groupInterval,
        repeatInterval: options.repeatInterval,
      });

      if (options.out) writeJsonFile(String(options.out), result.policy);
      if (!options.in && !ctx.dryRun) {
        await new GrafanaClient(ctx).request("PUT", "/api/v1/provisioning/policies", result.policy, [202]);
      }

      if (options.json || ctx.output === "json") {
        console.log(
          JSON.stringify(
            { action: result.action, path: result.path, route: result.route, policy: result.policy },
            null,
            2,
          ),
        );
      } else {
        runtime.printMessage(
          ctx,
          `${ctx.dryRun ? "[DRY-RUN] " : ""}policy route ${result.action}: ${result.path}`,
        );
        runtime.printMessage(ctx, routeLabel(result.route));
        if (options.in && !options.out && !ctx.dryRun) {
          writeJsonFile(String(options.in), result.policy);
          runtime.printMessage(ctx, `Updated ${path.resolve(String(options.in))}`);
        }
      }
    });
}

export async function validateAlertRules(
  ctx: CliContext,
  rules: JsonObject[],
  _runtime: CommandAppContext["runtime"],
  options: {
    from: string;
    to: string;
    timeoutMs: number;
    intervalMs: number;
    maxDataPoints: number;
    vars: Record<string, string>;
  },
) {
  const nowMs = Date.now();
  const fromMs = resolveTimeToMs(options.from, nowMs);
  const toMs = resolveTimeToMs(options.to, nowMs);
  const vars = {
    ...buildGrafanaMacros({
      from: fromMs,
      to: toMs,
      intervalMs: options.intervalMs,
      maxDataPoints: options.maxDataPoints,
    }),
    ...options.vars,
  };
  const client = new GrafanaClient({ ...ctx, timeoutMs: options.timeoutMs });
  const results: Array<AlertRuleQueryResult & { rule: string }> = [];
  const refIssues = rules.flatMap((rule) =>
    validateAlertRuleExpressionRefs(rule).map((issue) => ({ rule: alertRuleTitle(rule), ...issue })),
  );

  for (const rule of rules) {
    const ruleName = alertRuleTitle(rule);
    const queries = extractAlertRuleQueries(rule, vars);
    if (queries.length === 0) {
      results.push({ rule: ruleName, refId: "-", status: "skip", message: "no datasource query found" });
      continue;
    }
    for (const query of queries) {
      const payload = {
        from: String(fromMs),
        to: String(toMs),
        queries: [resolveTemplateValue(query.query, vars)],
      };
      const response = await client.requestWithStatus<JsonObject>("POST", "/api/ds/query", payload);
      const error = resultErrorMessage(response.data, query.refId);
      if (error) {
        results.push({
          rule: ruleName,
          refId: query.refId,
          datasourceUid: query.datasourceUid,
          datasourceType: query.datasourceType,
          status: "error",
          message: error,
        });
        continue;
      }
      if (response.status !== 200) {
        results.push({
          rule: ruleName,
          refId: query.refId,
          datasourceUid: query.datasourceUid,
          datasourceType: query.datasourceType,
          status: "error",
          message: `HTTP ${response.status}: ${formatData(response.data)}`,
        });
        continue;
      }
      if (!resultHasFrames(response.data, query.refId)) {
        results.push({
          rule: ruleName,
          refId: query.refId,
          datasourceUid: query.datasourceUid,
          datasourceType: query.datasourceType,
          status: "no-data",
          message: "no data returned",
        });
        continue;
      }
      results.push({
        rule: ruleName,
        refId: query.refId,
        datasourceUid: query.datasourceUid,
        datasourceType: query.datasourceType,
        status: "ok",
        message: "query ok",
      });
    }
  }
  return { results, refIssues };
}

async function loadAlertRules(
  ctx: CliContext,
  target: string,
  runtime: CommandAppContext["runtime"],
): Promise<JsonObject[]> {
  if (fs.existsSync(target)) {
    const bundle = runtime.collectBundle([path.resolve(target)], "alert-rules");
    return asObjectArray(runtime.resourceItems(bundle, "alert-rules"));
  }
  const remote = await runtime.fetchResources(new GrafanaClient(ctx), ["alert-rules"]);
  const selected = selectByToken(
    runtime.resourceItems(remote, "alert-rules"),
    "alert-rules",
    target,
    runtime.selectResource,
  );
  const obj = asObject(selected);
  return obj ? [obj] : [];
}

function selectByToken(
  items: unknown[],
  resource: ResourceName,
  token: string,
  selectResource: SelectResourceFn,
) {
  const selectors = [
    ResourceSelectorSchema.parse({ uid: token, where: [] }),
    ResourceSelectorSchema.parse({ title: token, where: [] }),
    ResourceSelectorSchema.parse({ name: token, where: [] }),
  ];
  let last: Error | undefined;
  for (const selector of selectors) {
    try {
      return selectResource(items, resource, selector, false);
    } catch (error) {
      last = error as Error;
    }
  }
  throw last || new Error(`No ${resource} matched selector`);
}

function printAlertRuleValidation(
  ctx: CliContext,
  result: Awaited<ReturnType<typeof validateAlertRules>>,
  json: boolean,
  runtime: CommandAppContext["runtime"],
) {
  if (json || ctx.output === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const issue of result.refIssues) runtime.printMessage(ctx, `[ERROR] ${issue.rule} / ${issue.message}`);
  for (const item of result.results) {
    const level = item.status === "ok" ? "OK" : item.status === "error" ? "ERROR" : "WARN";
    runtime.printMessage(ctx, `[${level}] ${item.rule} / refId=${item.refId} / ${item.message}`);
  }
}

function setExitFromQueryResults(results: AlertRuleQueryResult[], hasRefError: boolean) {
  if (hasRefError || results.some((item) => item.status === "error")) process.exitCode = 1;
  else if (results.some((item) => item.status === "no-data" || item.status === "skip")) process.exitCode = 2;
}

async function fetchPolicy(ctx: CliContext): Promise<JsonObject> {
  const policy = await new GrafanaClient(ctx).request<unknown>("GET", "/api/v1/provisioning/policies");
  const obj = asObject(policy);
  if (!obj) throw new Error("Policy response is not an object");
  return obj;
}

function loadPolicyFile(file: string): JsonObject {
  const obj = asObject(JSON.parse(fs.readFileSync(path.resolve(file), "utf8")));
  if (!obj) throw new Error("Policy file must be a JSON object");
  return obj;
}

function writeJsonFile(file: string, value: unknown) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatData(data: unknown): string {
  return typeof data === "string" ? data : JSON.stringify(data);
}

async function checkAlertClosure(
  ctx: CliContext,
  rule: JsonObject,
  _runtime: CommandAppContext["runtime"],
  options: { dashboardDir: string; docsDir: string },
): Promise<Array<{ status: "OK" | "WARN" | "ERROR"; message: string }>> {
  const checks: Array<{ status: "OK" | "WARN" | "ERROR"; message: string }> = [];
  const title = alertRuleTitle(rule);
  const uid = alertRuleUid(rule);
  checks.push({ status: "OK", message: `alert rule exists: ${uid || title}` });

  try {
    const policy = await fetchPolicy(ctx);
    const matched = findMatchingPolicyRoute(policy, alertRuleLabels(rule));
    checks.push(
      matched
        ? { status: "OK", message: `policy route matched: ${routeLabel(matched)}` }
        : { status: "WARN", message: "no policy route matches alert labels" },
    );
  } catch (error) {
    checks.push({ status: "WARN", message: `policy route check skipped: ${(error as Error).message}` });
  }

  const dashboardHit = scanJsonFiles(options.dashboardDir, [uid, title, "trigger points"].filter(Boolean));
  checks.push(
    dashboardHit
      ? { status: "OK", message: `dashboard reference found: ${dashboardHit}` }
      : { status: "WARN", message: "no dashboard panel/link mentions alert uid/title or trigger points" },
  );

  const docHit = scanMarkdownFiles(options.docsDir, [uid, title].filter(Boolean));
  checks.push(
    docHit
      ? { status: "OK", message: `docs mention alert: ${docHit}` }
      : { status: "WARN", message: `no ${options.docsDir}/*.md mentions alert uid/title` },
  );
  return checks;
}

function scanJsonFiles(dir: string, needles: string[]): string | undefined {
  return scanFiles(dir, ".json", needles);
}

function scanMarkdownFiles(dir: string, needles: string[]): string | undefined {
  return scanFiles(dir, ".md", needles);
}

function scanFiles(dir: string, suffix: string, needles: string[]): string | undefined {
  if (!fs.existsSync(dir) || needles.length === 0) return undefined;
  const queue = [path.resolve(dir)];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) queue.push(full);
      else if (stat.isFile() && name.endsWith(suffix)) {
        const content = fs.readFileSync(full, "utf8");
        if (needles.some((needle) => needle && content.includes(needle))) return full;
      }
    }
  }
  return undefined;
}
