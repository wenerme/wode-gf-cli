# wode-gf-cli

CLI for exporting, importing, diffing, and patching Grafana resources.

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
```

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
