# wode-gf-cli

CLI for exporting, importing, diffing, validating, patching, and rendering Grafana resources.

中文文档见 [README.zh-CN.md](./README.zh-CN.md).

## Install

Run directly without global install:

```bash
npx wode-gf-cli --help
bunx wode-gf-cli --help
pnpm dlx wode-gf-cli --help
```

Install globally:

```bash
npm i -g wode-gf-cli
# or
pnpm add -g wode-gf-cli
```

Local development install:

```bash
pnpm install
pnpm run build
```

Install built binary locally:

```bash
pnpm run install:bin
wode-gf-cli --help
```

## Build And Check

```bash
pnpm run lint
pnpm run build
pnpm run check
just promql-generate
just promql-test
```

## Configuration

You can configure Grafana connection by context config, CLI flags, or environment variables.

Config file:

- `~/.wode/wode-gf-cli.yaml`

Example:

```yaml
context: default
contexts:
  - name: default
    baseUrl: http://127.0.0.1:3300
    serviceAccountToken: glsa_xxx
  - name: local
    baseUrl: http://127.0.0.1:3300
    username: admin
    password: admin
```

Supported fields:

- `name`
- `baseUrl`
- `serviceAccountToken`
- `username`
- `password`

Base commands:

```bash
wode-gf-cli context list
wode-gf-cli context current
wode-gf-cli context use local
wode-gf-cli context set baseUrl=http://127.0.0.1:3300
wode-gf-cli auth login --context local --url http://127.0.0.1:3300 --service-account-token <token>
wode-gf-cli auth login --context local --url http://127.0.0.1:3300 --username admin --password admin
wode-gf-cli auth whoami --context local
```

Base env vars:

```bash
GRAFANA_URL
GRAFANA_SERVICE_ACCOUNT_TOKEN
GRAFANA_USERNAME
GRAFANA_PASSWORD
```

Context-based env vars (`--context <name>`; `--name` is compatibility alias only):

```bash
<CONTEXT>_GRAFANA_URL
<CONTEXT>_GRAFANA_SERVICE_ACCOUNT_TOKEN
<CONTEXT>_GRAFANA_USERNAME
<CONTEXT>_GRAFANA_PASSWORD
```

Example:

```bash
# CONTEXT=LOCAL
wode-gf-cli --context local export -o local/grafana-export

# resolves LOCAL_GRAFANA_URL / LOCAL_GRAFANA_SERVICE_ACCOUNT_TOKEN
```

Optional default context:

```bash
export WODE_GF_CLI_CONTEXT=local
wode-gf-cli export -o local/grafana-export
```

Priority notes:

- CLI flags override context / env values (`--url`, `--service-account-token`, `--username`, `--password`)
- context config overrides env values
- Shell env has higher priority than `.env` / `.env.local`
- `--name` remains only as a compatibility alias; new docs use `context`
- legacy config keys `profile` / `profiles` in `~/.wode/wode-gf-cli.yaml` are migrated to `context` / `contexts` automatically when read.

## Basic Workflow

```bash
# 1) export current remote state
wode-gf-cli --context <context> export -o ./grafana-export

# 2) edit local JSON files

# 3) validate and diff
wode-gf-cli --context <context> validate ./grafana-export
wode-gf-cli --context <context> diff -i ./grafana-export

# 4) apply safely
wode-gf-cli --context <context> --dry-run import ./grafana-export
wode-gf-cli --context <context> import ./grafana-export
```

## Common Workflow

```bash
# pull/dump from remote
wode-gf-cli --context local export -o local/grafana-export

# edit local JSON
wode-gf-cli --context local query dashboard --uid <uid> --json > local/dashboard.json
$EDITOR local/dashboard.json

# dry-run push
wode-gf-cli --context local --dry-run import local/grafana-export

# apply push
wode-gf-cli --context local import local/grafana-export

# validate panel queries in dashboard JSON files
wode-gf-cli --context local validate ./grafana --concurrency 4 --var env=prod
wode-gf-cli --context local validate ./grafana --concurrency 2 --timeout 60000
wode-gf-cli --context local validate ./grafana --interval-ms 60000
wode-gf-cli --context local validate ./grafana --syntax-only --promql-macro-mode keep

# quick datasource queries (uid or name)
wode-gf-cli --context local query xyz-mysql --sql 'select 1'
wode-gf-cli --context local query my-prom --expr 'up'
wode-gf-cli --context local query my-cls --query 'serviceType=logService' --query 'logServiceParams.Query=* | select trace_id limit 1' --query 'logServiceParams.TopicId=my-topic-id' --query 'logServiceParams.region=ap-shanghai' --query 'logServiceParams.SyntaxRule=1'

# list resources quickly
wode-gf-cli --context local list dashboard
wode-gf-cli --context local list connection --json
wode-gf-cli --context local list alert-rule --json
wode-gf-cli --context local policy get

# raw Grafana API escape hatch
wode-gf-cli --context local api /api/user --output json
wode-gf-cli --context local api /api/search --query type=dash-db --query limit=1 --output json

# full query object passthrough
wode-gf-cli --context local query my-cls --query-file ./local/cls-query.json --json

# read query object from stdin
cat ./local/cls-query.json | wode-gf-cli --context local query my-cls --query-file - --json

# render a panel image
wode-gf-cli --context local render panel --dashboard-uid <uid> --panel-id 1 -o local/panel.png

# render a panel with Retina/HDPI output while keeping the same layout size
wode-gf-cli --context local render panel --dashboard-uid <uid> --panel-id 1 --width 1600 --height 900 --hdpi -o local/panel@2x.png

# pass extra Grafana render URL parameters
wode-gf-cli --context local render panel --dashboard-uid <uid> --panel-id 1 --render-param kiosk=1 -o local/panel.png

# render a dashboard image
wode-gf-cli --context local render dashboard --dashboard-uid <uid> -o local/dashboard.png

# slow Grafana render can increase timeout (default 60000ms)
wode-gf-cli --context my-prod render panel --dashboard-uid <uid> --panel-id 1 --render-timeout 90000 -o local/panel.png

# note: render requires Grafana image renderer plugin on target Grafana
```

You can set default context via env:

```bash
export WODE_GF_CLI_CONTEXT=local
wode-gf-cli export -o local/grafana-export
```

`query` parameter hints:
- `--sql`: quick SQL-like query field (`rawSql`)
- `--expr`: quick expression query field (`expr`)
- `--query path=value`: patch any field in query object (repeatable)
- `--query-json` / `--query-file`: full query object passthrough

PromQL local checks:
- `validate --syntax-only` runs local PromQL preflight only and does not call Grafana.
- `push` / `import` check PromQL before writing dashboards; use `--skip-promql-check` only when you need to bypass local syntax checks.
- `--promql-macro-mode keep|preset|eval|strict` controls Grafana macro/template handling. Default `keep` accepts raw dashboard expressions. `preset` substitutes syntax-safe placeholders, `eval` uses `--var` / time context when available and warns on fallbacks, and `strict` rejects Grafana placeholders before parsing.

Resource/API notes:
- Alerting resources are available through `alert-rule`, `contact-point`, and `policy`; export/import can include `alert-rules,contact-points,policies`.
- `api <path|url>` is a raw Grafana API escape hatch using the active context auth. It supports `-X`, `-H`, `--query`, `-f`, `--json`, `-d`, `--data-file`, `-i`, `--raw`, `--fail`, and `-o`.

## Single JSON Import

```bash
# auto-infer resource type
wode-gf-cli --context local import local/single-dashboard.json

# explicit type (recommended when ambiguous)
wode-gf-cli --context local import local/resource.json --type dashboard
```

Type resolution order:

1. `__type` in JSON payload
2. directory-based hint / `--type`
3. payload shape inference
