---
name: wode-gf-cli
description: Use when operating Grafana resources with wode-gf-cli, including export/import/validate/diff/query/patch/delete/render workflows and troubleshooting datasource/query validation issues.
---

# wode-gf-cli Skill

You are an expert operator for `wode-gf-cli`.

Critical rules:
- Use `--dry-run` first for destructive or broad changes.
- Run `validate` before `import` when changing dashboard JSON.
- Do not assume datasource UID; verify from dashboard context or explicit flags.

## Install and run

Use one of these methods:

```bash
# Global install
npm i -g wode-gf-cli

# One-shot execution
npx wode-gf-cli --help
bunx wode-gf-cli --help
pnpm dlx wode-gf-cli --help
```

## Common Workflows

### 1) Export resources

```bash
wode-gf-cli --name <profile> export -o ./grafana-export
wode-gf-cli --url <grafana-url> --service-account-token <token> export -o ./grafana-export
```

### 2) Validate dashboard queries

```bash
wode-gf-cli --name <profile> validate ./grafana-export --concurrency 4 --var env=prod
wode-gf-cli --name <profile> validate ./grafana-export --timeout 60000
```

Exit code:
- `0`: all good
- `1`: query errors found (`HTTP 200` + `results[refId].error`)
- `2`: warnings only (skipped panels / unresolved datasource / non-200 datasource response)

### 3) Diff and import

```bash
wode-gf-cli --name <profile> --output json diff -i ./grafana-export
wode-gf-cli --name <profile> --dry-run import ./grafana-export
wode-gf-cli --name <profile> import ./grafana-export
```

### 4) Query datasource or resource

```bash
# quick datasource query (uid or name)
wode-gf-cli --name <profile> query my-sql --sql 'select 1'
wode-gf-cli --name <profile> query my-prom --expr 'up'

# full query object passthrough
wode-gf-cli --name <profile> query my-ds --query-file ./query.json --json

# read query object from stdin
cat ./query.json | wode-gf-cli --name <profile> query my-ds --query-file - --json

# query a single resource
wode-gf-cli --name <profile> query dashboard --uid <uid> --json
```

`query` supports:
- `--sql` / `--expr` for quick path
- `--query path=value` (repeatable) to patch arbitrary query fields
- `--query-json` / `--query-file` for full passthrough
- `--query-file -` to read query object from stdin

### 5) Render images

```bash
wode-gf-cli --name <profile> render panel --dashboard-uid <uid> --panel-id 1 -o ./panel.png
wode-gf-cli --name <profile> render dashboard --dashboard-uid <uid> -o ./dashboard.png
wode-gf-cli --name <profile> render panel --dashboard-uid <uid> --panel-id 1 --render-timeout 90000 -o ./panel.png
```

Note: render requires Grafana image renderer plugin on the target Grafana instance.

### 6) Patch and delete

```bash
wode-gf-cli --name <profile> patch dashboard --uid <uid> --set dashboard.title="New Title"
wode-gf-cli --name <profile> delete contact-point --uid <uid>
```

### 7) List resources

```bash
wode-gf-cli --name <profile> list dashboard
wode-gf-cli --name <profile> list connection --json
```

### 8) Import single JSON file

```bash
# auto infer type
wode-gf-cli --name <profile> import ./dashboard.json

# explicit fallback type when needed
wode-gf-cli --name <profile> import ./resource.json --type dashboard
```

## Validate command notes

`validate [sources...]` supports file or directory sources (default `./grafana/`).

Helpful options:

```bash
--skip-panel-ids <ids>   # e.g. 10,11,12
--from <time>            # default now-1h
--to <time>              # default now
--concurrency <n>        # default 4
--fail-fast
--var <key=value>        # repeatable
```

Variable handling behavior:
- Uses dashboard templating `current.value` first.
- Uses CLI overrides from `--var key=value`.
- Replaces `${var}` and `$var` patterns.
- Handles `$__from` / `$__to` placeholders.

Datasource handling behavior:
- For mixed datasource panels (`-- Mixed --`), it resolves from `target.datasource.uid`.
- For datasource variables (like `${ds}`), it resolves from templating values.

## Quick Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `Missing Grafana URL` | Profile/env not set | set `GRAFANA_URL` (or profile-prefixed env) or pass `--url` |
| `Skip target: datasource uid unresolved` | mixed datasource or unresolved `${ds}` | set `--var ds=<uid>` or fix templating current value |
| many `HTTP 400/404` warnings in validate | datasource/query context mismatch | treat as warning first; narrow by panels with `--skip-panel-ids` and re-check |
| `Selector matched multiple ...` | query/delete selector too broad | add `--uid`/`--name`/`--title`/`--where` |

## Safe Operation Defaults

- For batch updates: `validate -> diff -> import --dry-run -> import`.
- Prefer JSON output for automation:

```bash
wode-gf-cli --name <profile> --output json --quiet validate ./grafana-export
```
