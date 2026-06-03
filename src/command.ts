import { Command, type Help } from "commander";

function formatRows(rows: Array<[string, string]>): string {
  const width = rows.reduce((max, [term]) => Math.max(max, term.length), 0);
  return rows.map(([term, description]) => `${term.padEnd(width)}  ${description}`).join("\n");
}

function buildTopHelpText(cliName: string): string {
  return `QUICK START
${cliName} auth login --context local --url http://127.0.0.1:3300 --service-account-token <token>
${cliName} auth whoami --context local
${cliName} context list
${cliName} --context local list dashboard
${cliName} --context local pull local/dashboard.json
${cliName} --context local push local/dashboard.json
${cliName} --context local query my-sql --sql 'select 1'

DISCOVER
${formatRows([
  ["list", "list dashboards / folders / connections"],
  ["query", "inspect one resource, or run datasource queries"],
  ["api", "call raw Grafana API paths"],
  ["export", "pull remote resources into local split JSON"],
  ["pull", "refresh one local JSON file from remote"],
  ["context", "list | current | use <NAME> | set KEY=VALUE"],
  ["auth", "login | whoami"],
])}

REVIEW
${formatRows([
  ["diff", "compare local export with current Grafana"],
  ["validate", "validate dashboard queries via /api/ds/query"],
  ["render", "render panel or dashboard PNG"],
  ["panel / p", "list DASH | get DASH/PANEL | inspect DASH/PANEL"],
])}

CHANGE
${formatRows([
  ["push", "apply local JSON files/directories to Grafana"],
  ["import", "apply local JSON files/directories to Grafana"],
  ["patch", "patch one remote resource with path=value updates"],
  ["panel / p", "patch DASH/PANEL | edit DASH/PANEL | render DASH/PANEL"],
  ["delete", "delete one remote resource"],
  ["api", "escape hatch for unsupported Grafana APIs"],
])}

RESOURCE COMMANDS
${formatRows([
  ["dashboard / dash / d", "list | search <TERM> | get <ID> | move <ID> <FOLDER> | delete <ID>"],
  ["connection / conn", "list | search <TERM> | get <ID> | delete <ID>"],
  [
    "folder",
    "list [--tree] | search <TERM> | get <ID|TITLE> | create <TITLE> | rename <ID|TITLE> <TITLE> | delete <ID|TITLE>",
  ],
  ["alert-rule", "get <ID> | delete <ID>"],
  ["contact-point", "get <ID> | delete <ID>"],
  ["policy", "get"],
  [
    "panel / p",
    "list DASH | get DASH/PANEL | inspect DASH/PANEL | patch DASH/PANEL | edit DASH/PANEL | validate DASH/PANEL | render DASH/PANEL",
  ],
  ["user", "list [--search <TERM>]"],
])}`;
}

function buildBottomHelpText(cliName: string): string {
  return `PATTERN
${formatRows([
  ["command", `${cliName} <command> [args] [--context <name>] [--output text|json] [--dry-run]`],
  ["resource", `${cliName} <resource> <action> [args]`],
  ["example", `${cliName} query dashboard --uid <uid> --context local --json`],
  ["api", `${cliName} api /api/v1/provisioning/policies --context local`],
])}

WORKFLOW
1. auth/context   ${cliName} auth login --context local --url <url> --service-account-token <token>
2. discover       ${cliName} --context local list dashboard
3. pull/edit      ${cliName} --context local pull local/dashboard.json
4. review         ${cliName} --context local diff --resource dashboard -i local/dashboard.json --json
5. validate       ${cliName} --context local validate ./grafana --concurrency 4
6. dry-run        ${cliName} --context local --dry-run push local/dashboard.json
7. apply          ${cliName} --context local push local/dashboard.json

QUERY MODES
${formatRows([
  ["--sql / --expr", "quick path for common datasource query fields"],
  ["--query path=value", "patch queries[0] fields (repeatable)"],
  ["--query-json / --query-file", "full query object passthrough (--query-file - for stdin)"],
])}`;
}

function buildOptionsText(program: Command, helper: Help): string {
  return formatRows(
    helper
      .visibleOptions(program)
      .map((option) => [helper.optionTerm(option), helper.optionDescription(option)]),
  );
}

function buildRootHelpInformation(program: Command, cliName: string): string {
  const helper = program.createHelp();
  const description = program.description();
  return [
    `Usage: ${helper.commandUsage(program)}`,
    description,
    buildTopHelpText(cliName),
    "Options:",
    buildOptionsText(program, helper),
    buildBottomHelpText(cliName),
    "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createCommand(cliName: string) {
  const program = new Command(cliName);
  const collectList = (value: string, prev: string[]) => {
    prev.push(value);
    return prev;
  };

  program
    .description("Grafana resource tool for discover/export/diff/import/query/render")
    .showSuggestionAfterError(true)
    .showHelpAfterError()
    .option("-n, --name <name>", "deprecated alias of --context (prefer --context)")
    .option("-c, --context <name>", "context name from ~/.wode/wode-gf-cli.yaml")
    .option("--url <url>", "Grafana URL")
    .option("--service-account-token <token>", "Grafana service account token")
    .option("--username <username>", "Grafana username for basic auth")
    .option("--password <password>", "Grafana password for basic auth")
    .option("--timeout <ms>", "request timeout in milliseconds", "20000")
    .option("--dry-run", "show planned changes without writing")
    .option("--output <format>", "output format: text|json", "text")
    .option("-q, --quiet", "hide text progress logs")
    .option("--debug", "debug HTTP requests");

  program.helpInformation = function rootHelpInformation() {
    return buildRootHelpInformation(this, cliName);
  };

  return { program, collectList };
}
