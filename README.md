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
wode-gf-cli context list       # alias: wode-gf-cli ctx list
wode-gf-cli context current    # alias: wode-gf-cli ctx current
wode-gf-cli context use local  # alias: wode-gf-cli ctx use local
wode-gf-cli context set baseUrl=http://127.0.0.1:3300
printf '%s' "$GRAFANA_SERVICE_ACCOUNT_TOKEN" | wode-gf-cli auth login --context local --url http://127.0.0.1:3300 --service-account-token-stdin
printf '%s' "$GRAFANA_PASSWORD" | wode-gf-cli auth login --context local --url http://127.0.0.1:3300 --username admin --password-stdin
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

Project default context:

```yaml
# <nearest-git-root>/.wode/wode-gf-cli.yaml
context: local
```

The project config is discovered from the current working directory by walking up to the nearest `.git` root. Use it for non-secret defaults such as `context`; keep credentials in the global config or environment variables.

Priority notes:

- CLI flags override context / env values (`--url`, `--service-account-token`, `--username`, `--password`)
- `--context` / `WODE_GF_CLI_CONTEXT` override project config context
- project config context overrides the global default context
- context config overrides env values
- Shell env has higher priority than `.env` / `.env.local`
- prefer `--password-stdin` / `--service-account-token-stdin`; direct secret flags can be exposed in shell history and process listings
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

# Optional: check only resources declared locally, useful for partial dashboard-v2 directories
wode-gf-cli --context <context> diff -i ./grafana-export-v2/dashboard-v2 --resources dashboards --local-only

# 4) apply safely
wode-gf-cli --context <context> --dry-run import ./grafana-export
wode-gf-cli --context <context> import ./grafana-export
```

## Common Workflow

```bash
# pull/dump from remote
wode-gf-cli --context local export -o local/grafana-export

# export Grafana 13 dashboard resource API v2 dashboards (TabsLayout, schema v2)
wode-gf-cli --context local export -r dashboards --dashboard-api v2 -o local/grafana-export-v2

# pull defaults to --dashboard-api auto; tabs dashboards are pulled as v2 automatically
wode-gf-cli --context local pull local/example-dashboard.json -t dashboard --uid example-dashboard

# edit local JSON
wode-gf-cli --context local query dashboard --uid <uid> --json > local/dashboard.json
$EDITOR local/dashboard.json

# dry-run push
wode-gf-cli --context local --dry-run import local/grafana-export

# apply push
wode-gf-cli --context local import local/grafana-export

# v2 dashboard files under dashboard-v2/ or apiVersion=dashboard.grafana.app/v2beta1 use the v2 API on import
wode-gf-cli --context local import local/grafana-export-v2/dashboard-v2/example-dashboard.json

# diff local v2 dashboard source files against remote v2 resources without treating remote-only dashboards as removed
wode-gf-cli --context local diff -i local/grafana-export-v2/dashboard-v2 --resources dashboards --local-only

# validate panel queries in dashboard JSON files
wode-gf-cli --context local validate ./grafana --concurrency 4 --var env=prod
wode-gf-cli --context local validate ./grafana --concurrency 2 --timeout 60000
wode-gf-cli --context local validate ./grafana --interval-ms 60000
wode-gf-cli --context local validate ./grafana --tz Asia/Shanghai
wode-gf-cli --context local validate ./grafana --syntax-only --promql-macro-mode keep

# isolate one query in a remote panel
wode-gf-cli --context local panel validate <dashboard-uid>/<panel-id> --ref-id A

# quick datasource queries (uid or name)
wode-gf-cli --context local query xyz-mysql --sql 'select 1'
wode-gf-cli --context local query xyz-mysql --sql 'select ${__from:date:YYYYMMDD} as dt' --tz Asia/Shanghai
wode-gf-cli --context local query my-prom --expr 'up'
wode-gf-cli --context local query my-cls --query 'serviceType=logService' --query 'logServiceParams.Query=* | select trace_id limit 1' --query 'logServiceParams.TopicId=my-topic-id' --query 'logServiceParams.region=ap-shanghai' --query 'logServiceParams.SyntaxRule=1'

# list resources quickly
wode-gf-cli --context local list dashboard
wode-gf-cli --context local list connection --json
wode-gf-cli --context local list alert-rule --json
wode-gf-cli --context local policy get

# alert runtime (rule state, transitions, active instances, silences)
wode-gf-cli --context local alert-rule state --state firing,pending --matcher team=sre
wode-gf-cli --context local alert-rule state --fail-on firing,error --json
wode-gf-cli --context local alert-rule history <rule-uid> --from now-6h
wode-gf-cli --context local alert list --matcher team=sre
wode-gf-cli --context local --dry-run silence create --matcher team=sre --duration 2h --comment 'maintenance'
wode-gf-cli --context local --dry-run alert-rule pause <rule-uid>

# raw Grafana API escape hatch
wode-gf-cli --context local api /api/user --output json
wode-gf-cli --context local api /api/search --query type=dash-db --query limit=1 --output json

# full query object passthrough
wode-gf-cli --context local query my-cls --query-file ./local/cls-query.json --json

# read query object from stdin
cat ./local/cls-query.json | wode-gf-cli --context local query my-cls --query-file - --json

# render a panel image
wode-gf-cli --context local render panel --dashboard-uid <uid> --panel-id 1 -o local/panel.png
wode-gf-cli --context local render panel --dashboard-uid <uid> --panel-id 1 --from '2026-08-18T08:00:00+08:00' --to '2026-08-18T23:59:59+08:00' --tz Asia/Shanghai -o local/panel.png

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
- `--tz`: timezone for formatted `__from` / `__to` variables; defaults to `UTC`

Time behavior:
- Query and validate resolve absolute/relative input to epoch milliseconds before calling `/api/ds/query`.
- Render converts ISO absolute time to epoch milliseconds, preserves epoch milliseconds and Grafana relative expressions such as `now-6h`, and rejects invalid absolute time. Without `--tz`, the render URL leaves timezone selection to the Dashboard; naive ISO input uses `UTC` for deterministic parsing.
- Validate time formatter precedence is explicit `--tz`, then Dashboard timezone, then `UTC`.
- Supported time variable formatters include `date`, `date:iso`, `date:seconds`, and validated Moment-style patterns such as `date:YYYYMMDD`.

PromQL local checks:
- `validate --syntax-only` runs local PromQL preflight only, does not call Grafana, and does not need a configured URL.
- `push` / `import` check PromQL before writing dashboards; use `--skip-promql-check` only when you need to bypass local syntax checks.
- `--promql-macro-mode keep|preset|eval|strict` controls Grafana macro/template handling. Default `keep` accepts raw dashboard expressions. `preset` substitutes syntax-safe placeholders, `eval` uses `--var` / time context when available and warns on fallbacks, and `strict` rejects Grafana placeholders before parsing.

Dashboard layout (local, offline; classic `gridPos` and v2 Tabs/Rows/Grid/AutoGrid):
- `dashboard layout check [FILES|DIRS]` reports overlap, out-of-bounds, duplicate panel id, v2 missing/duplicate/orphan elements, and classic panels whose `panels[]` position disagrees with the row their `y` places them in (Grafana sorts by y/x before assigning rows). Exit 1 on errors, 2 on warnings.
- `dashboard layout show FILE` prints the tab/row/panel tree with coordinates; `dashboard layout diff BASE CANDIDATE` lists moved/resized/added/removed/reparented panels (exit 1 when layout changed), useful to prove a query-only edit kept the layout.
- `dashboard layout fix [FILES|DIRS]` rewrites coordinates to what Grafana actually renders (react-grid-layout vertical compaction per row/grid): overlaps are pushed down, negative `y` becomes 0, and `panels[]` is reordered to match rows. It only touches grids with errors, never moves a panel to another row or tab, and skips ambiguous layouts. Use `--dry-run` to preview.
- `validate --layout warn|error|off` and `import`/`push --layout warn|error|off` run the same lint. Default `warn` only prints and keeps exit codes unchanged; `error` fails before any write.
- `dashboard patch-file FILE` works on classic and v2 files (`--panel-id` maps to `spec.elements[*].spec.id` on v2), honors `--dry-run`, fails when an operation matches nothing (`--allow-no-match`), refuses patches that introduce new layout errors (`--allow-layout-errors`), supports `--forbid-layout-change`, and writes atomically only when content changed.

Versions (dashboard and alert rule config history):
- `dashboard versions list <ID> [--check-layout]` lists versions newest first; `--check-layout` lints every version and marks where layout errors were `introduced` or `fixed`. `alert-rule versions list <UID>` also shows which top-level fields each version changed.
- `versions get <ID> <VERSION>` prints a version in import-ready shape (classic export item, v2 resource, or provisioning rule). `VERSION` is a number, `current`, or `current~N`.
- `versions diff <ID> <FROM> [TO]` is a structural diff (arrays keyed by `id`/`refId`/`uid`, so one inserted panel is one change). Each side can be a version, `current[~N]`, or a local file; `dashboard versions diff --layout` compares layout only. Exit 2 when different, 1 on errors.
- `versions restore <ID> <VERSION>` writes the old content as a new version with a precondition: classic `overwrite:false` with the current id/version, v2 PUT with the current `resourceVersion`, so a concurrent save fails with a clear error instead of being overwritten. It never calls Grafana `/restore`, which has no precondition and rewrites v2 dashboards through v1. Restore always writes in the stored format (refuses a conversion unless `--allow-format-change`). Supports `--expect-version N` (abort unless current is what you reviewed), `--dry-run`, and layout preflight (`--layout`); it verifies the readback and exits 2 if Grafana normalized the save. Alert rules keep their current folder/group and provenance; Grafana has no rule write precondition, so the version is re-checked right before the PUT.
- Dashboards maintained as v2 (native v2 storage, or a v2 local file) are read through the v2beta1 history; use `--dashboard-api classic|v2` to override.

Resource/API notes:
- Alerting resources are available through `alert-rule`, `contact-point`, and `policy`; export/import can include `alert-rules,contact-points,policies`.
- `alert-rule state [RULES]` shows runtime state/health, last evaluation, firing/pending counts, and last error. Filters: `--state`, `--health`, `--folder`, `--group`, `--matcher` (rule labels), `--instance-matcher`, `--paused`; `--instances` adds alert instances; `--fail-on firing,pending,recovering,error,nodata` exits 2 on a match (1 = the command failed, including a truncated rule list). `--state` takes rule states only; use `--health error|nodata` for those. With `--instance-matcher`, counts and `--fail-on` use only the matched instances.
- `alert-rule history <RULE>` lists state transitions (`--from` default `now-24h`, `--to`, `--limit`, `--label k=v`). The default annotation history backend ignores label filters and returns at most 100 transitions; filters are applied locally and a capped result is flagged `truncated`.
- `alert list` (alias `alerts`) lists active Alertmanager instances; silenced/inhibited ones are hidden unless `--silenced`/`--inhibited`.
- `silence list [--all] | create | expire <ID>` manages silences. Matchers use `k=v`, `k!=v`, `k=~re`, `k!~re`; `create` refuses zero matchers or sets where every matcher matches the empty string. `createdBy` defaults to the current Grafana login.
- `alert-rule pause|resume <RULES...>` flips `isPaused` only, skips rules already in that state, verifies by readback, and keeps provenance. All writes honor `--dry-run`.
- Single-rule writes (`pause`/`resume`, `versions restore`) keep the order of rules in the group: Grafana's single-rule provisioning PUT drops the group index, so groups without provisioned rules are re-submitted through the ruler API like the Grafana UI does (this bumps the version of every rule in the group). Groups containing provisioned rules fall back to the PUT, and a reorder is reported with exit 2.
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
