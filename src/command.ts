import { Command, type Help } from "commander";

function formatRows(rows: Array<[string, string]>): string {
  const width = rows.reduce((max, [term]) => Math.max(max, term.length), 0);
  return rows.map(([term, description]) => `${term.padEnd(width)}  ${description}`).join("\n");
}

function buildTopHelpText(cliName: string): string {
  return `QUICK START
${cliName} --name local list dashboard
${cliName} --name local export -o local/grafana-export
${cliName} --name local query dashboard --uid <uid> --json
${cliName} --name local query my-sql --sql 'select 1'

DISCOVER
${formatRows([
  ["list", "list dashboards / folders / connections"],
  ["query", "inspect one resource, or run datasource queries"],
  ["export", "pull remote resources into local split JSON"],
])}

REVIEW
${formatRows([
  ["diff", "compare local export with current Grafana"],
  ["validate", "validate dashboard queries via /api/ds/query"],
  ["render", "render panel or dashboard PNG"],
])}

CHANGE
${formatRows([
  ["import", "apply local JSON files/directories to Grafana"],
  ["patch", "patch one remote resource with path=value updates"],
  ["delete", "delete one remote resource"],
])}

RESOURCE COMMANDS
${formatRows([
  ["dashboard / dash", "list | search <TERM> | get <ID> | delete <ID>"],
  ["connection / conn", "list | search <TERM> | get <ID> | delete <ID>"],
  ["folder", "get <ID> | delete <ID>"],
  ["alert-rule", "get <ID> | delete <ID>"],
  ["contact-point", "get <ID> | delete <ID>"],
  ["policy", "get <ID> | delete <ID>"],
])}`;
}

function buildBottomHelpText(cliName: string): string {
  return `PATTERN
${formatRows([
  ["command", `${cliName} <command> [args] [--name <profile>] [--output text|json] [--dry-run]`],
  ["resource", `${cliName} <resource> <action> [args]`],
  ["example", `${cliName} query dashboard --uid <uid> --name local --json`],
])}

EXAMPLES
${cliName} --name local diff -i local/grafana-export --json
${cliName} --name local validate ./grafana --concurrency 4
${cliName} --name local render panel --dashboard-uid <uid> --panel-id 1 -o local/panel.png
${cliName} --name local --dry-run import local/grafana-export
${cliName} dashboard delete <uid>

QUERY MODES
${formatRows([
  ["--sql / --expr", "quick path for common datasource query fields"],
  ["--query path=value", "patch queries[0] fields (repeatable)"],
  ["--query-json / --query-file", "full query object passthrough (--query-file - for stdin)"],
])}

MORE HELP
${cliName} <command> --help
${cliName} query --help
${cliName} dashboard --help`;
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
    .option("-n, --name <name>", "profile name, e.g. prod -> PROD_GRAFANA_URL/SERVICE_ACCOUNT_TOKEN")
    .option("--url <url>", "Grafana URL")
    .option("--service-account-token <token>", "Grafana service account token")
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
