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

Install built binary to `~/bin`:

```bash
pnpm run install:bin
wode-gf-cli --help
```

## Build And Check

```bash
pnpm run lint
pnpm run build
pnpm run check
```

## Configuration

You can configure Grafana connection by CLI flags or environment variables.

Base env vars:

```bash
GRAFANA_URL
GRAFANA_SERVICE_ACCOUNT_TOKEN
```

Profile-based env vars (used with `--name <profile>`):

```bash
<PROFILE>_GRAFANA_URL
<PROFILE>_GRAFANA_SERVICE_ACCOUNT_TOKEN
```

Example:

```bash
# PROFILE=LOCAL
wode-gf-cli --name local export -o local/grafana-export

# resolves LOCAL_GRAFANA_URL / LOCAL_GRAFANA_SERVICE_ACCOUNT_TOKEN
```

Optional default profile:

```bash
export WODE_GF_CLI_NAME=local
wode-gf-cli export -o local/grafana-export
```

Priority notes:

- CLI flags override env values (`--url`, `--service-account-token`)
- Shell env has higher priority than `.env` / `.env.local`

## Basic Workflow

```bash
# 1) export current remote state
wode-gf-cli --name <profile> export -o ./grafana-export

# 2) edit local JSON files

# 3) validate and diff
wode-gf-cli --name <profile> validate ./grafana-export
wode-gf-cli --name <profile> diff -i ./grafana-export

# 4) apply safely
wode-gf-cli --name <profile> --dry-run import ./grafana-export
wode-gf-cli --name <profile> import ./grafana-export
```

## Common Workflow

```bash
# pull/dump from remote
wode-gf-cli --name local export -o local/grafana-export

# edit local JSON
wode-gf-cli query dashboard --uid <uid> --json > local/dashboard.json
$EDITOR local/dashboard.json

# dry-run push
wode-gf-cli --name local --dry-run import local/grafana-export

# apply push
wode-gf-cli --name local import local/grafana-export

# validate panel queries in dashboard JSON files
wode-gf-cli --name local validate ./grafana --concurrency 4 --var env=prod
wode-gf-cli --name local validate ./grafana --concurrency 2 --timeout 60000
wode-gf-cli --name local validate ./grafana --interval-ms 60000

# quick datasource queries (uid or name)
wode-gf-cli --name local query xyz-mysql --sql 'select 1'
wode-gf-cli --name local query my-prom --expr 'up'
wode-gf-cli --name local query my-cls --query 'serviceType=logService' --query 'logServiceParams.Query=* | select trace_id limit 1' --query 'logServiceParams.TopicId=my-topic-id' --query 'logServiceParams.region=ap-shanghai' --query 'logServiceParams.SyntaxRule=1'

# list resources quickly
wode-gf-cli --name local list dashboard
wode-gf-cli --name local list connection --json

# full query object passthrough
wode-gf-cli --name local query my-cls --query-file ./local/cls-query.json --json

# read query object from stdin
cat ./local/cls-query.json | wode-gf-cli --name local query my-cls --query-file - --json

# render a panel image
wode-gf-cli --name local render panel --dashboard-uid <uid> --panel-id 1 -o local/panel.png

# render a dashboard image
wode-gf-cli --name local render dashboard --dashboard-uid <uid> -o local/dashboard.png

# slow Grafana render can increase timeout (default 60000ms)
wode-gf-cli --name my-prod render panel --dashboard-uid <uid> --panel-id 1 --render-timeout 90000 -o local/panel.png

# note: render requires Grafana image renderer plugin on target Grafana
```

You can set default profile via env:

```bash
export WODE_GF_CLI_NAME=local
wode-gf-cli export -o local/grafana-export
```

`query` parameter hints:
- `--sql`: quick SQL-like query field (`rawSql`)
- `--expr`: quick expression query field (`expr`)
- `--query path=value`: patch any field in query object (repeatable)
- `--query-json` / `--query-file`: full query object passthrough

## Single JSON Import

```bash
# auto-infer resource type
wode-gf-cli --name local import local/single-dashboard.json

# explicit type (recommended when ambiguous)
wode-gf-cli --name local import local/resource.json --type dashboard
```

Type resolution order:

1. `__type` in JSON payload
2. directory-based hint / `--type`
3. payload shape inference
