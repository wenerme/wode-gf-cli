import { Command } from "commander";

function buildHelpText(cliName: string): string {
  return `
Common workflows:

  # dump/pull from remote to local workspace
  ${cliName} --name local export -o local/grafana-export

  # local edit a single resource file
  ${cliName} query dashboard --uid <uid> --json > local/dashboard.json
  $EDITOR local/dashboard.json

  # import a single json file (auto infer by payload, or set --type)
  ${cliName} --name local import local/dashboard.json
  ${cliName} --name local import local/resource.json --type dashboard

  # diff local workspace against remote
  ${cliName} --name local --output json diff -i local/grafana-export

  # validate dashboard queries against Grafana datasource query API
  ${cliName} --name local validate ./grafana --concurrency 4

  # quick datasource queries (uid or name)
  ${cliName} --name local query my-sql --sql 'select 1'
  ${cliName} --name local query my-cls --query 'serviceType=logService' --query 'logServiceParams.Query=* | select trace_id limit 1' --query 'logServiceParams.TopicId=my-topic-id' --query 'logServiceParams.region=ap-shanghai' --query 'logServiceParams.SyntaxRule=1'
  ${cliName} --name local query my-prom --expr 'up'
  ${cliName} --name local query my-cls --query-file ./local/cls-query.json --json

  # quick list for discovery
  ${cliName} --name local list dashboard
  ${cliName} --name local list connection --json

  # query parameter modes
  --sql / --expr              quick path for common datasource query fields
  --query path=value          patch queries[0] fields (repeatable)
  --query-json / --query-file full query object passthrough (--query-file - for stdin)

  # render dashboard panel / dashboard image
  ${cliName} --name local render panel --dashboard-uid <uid> --panel-id 1 -o local/panel.png
  ${cliName} --name local render dashboard --dashboard-uid <uid> -o local/dashboard.png
  ${cliName} --name my-prod render panel --dashboard-uid <uid> --panel-id 1 --render-timeout 90000 -o local/panel.png
  # note: render requires Grafana image renderer plugin on target Grafana

  # push workflow: apply local changes to remote (use dry-run first)
  ${cliName} --name local --dry-run import local/grafana-export
  ${cliName} --name local import local/grafana-export
`;
}

export function createCommand(cliName: string) {
  const program = new Command(cliName);
  const collectList = (value: string, prev: string[]) => {
    prev.push(value);
    return prev;
  };

  program
    .description("Grafana resource tool (export/import/validate/diff/query/patch/delete/render)")
    .option("-n, --name <name>", "profile name, e.g. prod -> PROD_GRAFANA_URL/SERVICE_ACCOUNT_TOKEN")
    .option("--url <url>", "Grafana URL")
    .option("--service-account-token <token>", "Grafana service account token")
    .option("--timeout <ms>", "request timeout in milliseconds", "20000")
    .option("--dry-run", "show planned changes without writing")
    .option("--output <format>", "output format: text|json", "text")
    .option("-q, --quiet", "hide text progress logs")
    .option("--debug", "debug HTTP requests");

  program.addHelpText("after", buildHelpText(cliName));
  return { program, collectList };
}
