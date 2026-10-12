# wode-gf-cli

用于导出、导入、对比、校验、补丁更新和渲染 Grafana 资源的 CLI 工具。

英文文档见 [README.md](./README.md)。

## 安装

无需全局安装，直接执行：

```bash
npx wode-gf-cli --help
bunx wode-gf-cli --help
pnpm dlx wode-gf-cli --help
```

全局安装：

```bash
npm i -g wode-gf-cli
# 或
pnpm add -g wode-gf-cli
```

本地开发安装：

```bash
pnpm install
pnpm run build
```

本地安装构建产物：

```bash
pnpm run install:bin
wode-gf-cli --help
```

## 构建与检查

```bash
pnpm run lint
pnpm run build
pnpm run check
just promql-generate
just promql-test
```

## 配置

Grafana 连接信息可通过 context 配置、命令行参数或环境变量提供。

配置文件：

- `~/.wode/wode-gf-cli.yaml`

结构示例：

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

支持字段：

- `name`
- `baseUrl`
- `serviceAccountToken`
- `username`
- `password`

基础命令：

```bash
wode-gf-cli context list       # 别名：wode-gf-cli ctx list
wode-gf-cli context current    # 别名：wode-gf-cli ctx current
wode-gf-cli context use local  # 别名：wode-gf-cli ctx use local
wode-gf-cli context set baseUrl=http://127.0.0.1:3300
printf '%s' "$GRAFANA_SERVICE_ACCOUNT_TOKEN" | wode-gf-cli auth login --context local --url http://127.0.0.1:3300 --service-account-token-stdin
printf '%s' "$GRAFANA_PASSWORD" | wode-gf-cli auth login --context local --url http://127.0.0.1:3300 --username admin --password-stdin
wode-gf-cli auth whoami --context local
```

基础环境变量：

```bash
GRAFANA_URL
GRAFANA_SERVICE_ACCOUNT_TOKEN
GRAFANA_USERNAME
GRAFANA_PASSWORD
```

按 context 名的环境变量（`--context <name>`；`--name` 仅作兼容别名）：

```bash
<PROFILE>_GRAFANA_URL
<PROFILE>_GRAFANA_SERVICE_ACCOUNT_TOKEN
<PROFILE>_GRAFANA_USERNAME
<PROFILE>_GRAFANA_PASSWORD
```

示例：

```bash
# PROFILE=LOCAL
wode-gf-cli --context local export -o local/grafana-export

# 会解析 LOCAL_GRAFANA_URL / LOCAL_GRAFANA_SERVICE_ACCOUNT_TOKEN
```

可选默认 context：

```bash
export WODE_GF_CLI_CONTEXT=local
wode-gf-cli export -o local/grafana-export
```

项目默认 context：

```yaml
# <nearest-git-root>/.wode/wode-gf-cli.yaml
context: local
```

项目配置会从当前工作目录向上查找最近的 `.git` 根目录后读取。建议只放 `context` 这类非敏感默认值；凭据继续放全局配置或环境变量。

优先级说明：

- 命令行参数优先于 context / 环境变量（`--url`、`--service-account-token`、`--username`、`--password`）
- `--context` / `WODE_GF_CLI_CONTEXT` 优先于项目配置 context
- 项目配置 context 优先于全局默认 context
- context 配置优先于环境变量
- Shell 环境变量优先于 `.env` / `.env.local`
- 优先使用 `--password-stdin` / `--service-account-token-stdin`；直接传 secret 参数可能暴露在 shell 历史和进程列表中
- `--name` 仅保留为兼容别名；新配置与新文档统一使用 `context`
- `~/.wode/wode-gf-cli.yaml` 里若仍有旧键 `profile` / `profiles`，读取时会自动迁移为 `context` / `contexts`

## 基本工作流

```bash
# 1) 导出当前远端状态
wode-gf-cli --context <context> export -o ./grafana-export

# 2) 编辑本地 JSON 文件

# 3) 校验并对比
wode-gf-cli --context <context> validate ./grafana-export
wode-gf-cli --context <context> diff -i ./grafana-export

# 可选：只检查本地声明的资源，适合部分 dashboard-v2 目录
wode-gf-cli --context <context> diff -i ./grafana-export-v2/dashboard-v2 --resources dashboards --local-only

# 4) 安全应用变更
wode-gf-cli --context <context> --dry-run import ./grafana-export
wode-gf-cli --context <context> import ./grafana-export
```

## 常用工作流

```bash
# 从远端拉取/导出
wode-gf-cli --context local export -o local/grafana-export

# 导出 Grafana 13 dashboard resource API v2（TabsLayout、schema v2）
wode-gf-cli --context local export -r dashboards --dashboard-api v2 -o local/grafana-export-v2

# pull 默认是 --dashboard-api auto；tabs dashboard 会自动按 v2 拉取
wode-gf-cli --context local pull local/example-dashboard.json -t dashboard --uid example-dashboard

# 编辑本地 JSON
wode-gf-cli --context local query dashboard --uid <uid> --json > local/dashboard.json
$EDITOR local/dashboard.json

# dry-run 推送
wode-gf-cli --context local --dry-run import local/grafana-export

# 应用变更
wode-gf-cli --context local import local/grafana-export

# dashboard-v2/ 下或 apiVersion=dashboard.grafana.app/v2beta1 的 v2 dashboard 文件会在 import 时走 v2 API
wode-gf-cli --context local import local/grafana-export-v2/dashboard-v2/example-dashboard.json

# 对比本地 v2 dashboard source 与远端 v2 resource，不把远端其他 dashboard 当作 removed
wode-gf-cli --context local diff -i local/grafana-export-v2/dashboard-v2 --resources dashboards --local-only

# 校验 dashboard JSON 中的 panel 查询
wode-gf-cli --context local validate ./grafana --concurrency 4 --var env=prod
wode-gf-cli --context local validate ./grafana --concurrency 2 --timeout 60000
wode-gf-cli --context local validate ./grafana --interval-ms 60000
wode-gf-cli --context local validate ./grafana --tz Asia/Shanghai
wode-gf-cli --context local validate ./grafana --syntax-only --promql-macro-mode keep

# 隔离校验远端 panel 的单个 query
wode-gf-cli --context local panel validate <dashboard-uid>/<panel-id> --ref-id A

# 快速数据源查询（uid 或 name）
wode-gf-cli --context local query xyz-mysql --sql 'select 1'
wode-gf-cli --context local query xyz-mysql --sql 'select ${__from:date:YYYYMMDD} as dt' --tz Asia/Shanghai
wode-gf-cli --context local query my-prom --expr 'up'
wode-gf-cli --context local query my-cls --query 'serviceType=logService' --query 'logServiceParams.Query=* | select trace_id limit 1' --query 'logServiceParams.TopicId=my-topic-id' --query 'logServiceParams.region=ap-shanghai' --query 'logServiceParams.SyntaxRule=1'

# 快速列出资源
wode-gf-cli --context local list dashboard
wode-gf-cli --context local list connection --json
wode-gf-cli --context local list alert-rule --json
wode-gf-cli --context local policy get

# 原始 Grafana API 逃生口
wode-gf-cli --context local api /api/user --output json
wode-gf-cli --context local api /api/search --query type=dash-db --query limit=1 --output json

# 完整 query 对象透传
wode-gf-cli --context local query my-cls --query-file ./local/cls-query.json --json

# 从 stdin 读取 query 对象
cat ./local/cls-query.json | wode-gf-cli --context local query my-cls --query-file - --json

# 渲染 panel 图片
wode-gf-cli --context local render panel --dashboard-uid <uid> --panel-id 1 -o local/panel.png
wode-gf-cli --context local render panel --dashboard-uid <uid> --panel-id 1 --from '2026-08-18T08:00:00+08:00' --to '2026-08-18T23:59:59+08:00' --tz Asia/Shanghai -o local/panel.png

# 渲染 dashboard 图片
wode-gf-cli --context local render dashboard --dashboard-uid <uid> -o local/dashboard.png

# Grafana 渲染较慢时可增大超时（默认 60000ms）
wode-gf-cli --context my-prod render panel --dashboard-uid <uid> --panel-id 1 --render-timeout 90000 -o local/panel.png

# 注意：render 依赖目标 Grafana 安装 image renderer plugin
```

`query` 参数说明：

- `--sql`：快捷 SQL 类查询字段（`rawSql`）
- `--expr`：快捷表达式查询字段（`expr`）
- `--query path=value`：对 query 对象任意字段打补丁（可重复）
- `--query-json` / `--query-file`：完整 query 对象透传
- `--tz`：格式化 `__from` / `__to` 变量使用的时区，默认 `UTC`

时间行为：

- query 与 validate 在调用 `/api/ds/query` 前，将绝对时间或相对时间统一解析为 epoch 毫秒。
- render 将 ISO 绝对时间转换为 epoch 毫秒，保留 epoch 毫秒及 `now-6h` 等 Grafana 相对表达式，并拒绝非法绝对时间。未指定 `--tz` 时，render URL 交由 Dashboard 决定时区；无 offset 的 ISO 输入按 `UTC` 确定性解析。
- validate 的 formatter 时区优先级为显式 `--tz`、Dashboard timezone、`UTC`。
- 时间变量支持 `date`、`date:iso`、`date:seconds` 及经过校验的 Moment 风格格式，例如 `date:YYYYMMDD`。

PromQL 本地检查：

- `validate --syntax-only` 只运行本地 PromQL 预检查，不调用 Grafana，也不需要配置 URL。
- `push` / `import` 写入 dashboard 前会先检查 PromQL；仅在需要绕过本地语法检查时使用 `--skip-promql-check`。
- `--promql-macro-mode keep|preset|eval|strict` 控制 Grafana 宏/模板处理。默认 `keep` 接受原始 dashboard 表达式；`preset` 使用语法安全占位值；`eval` 在可用时使用 `--var` / 时间上下文并对 fallback 给出 warning；`strict` 在解析前拒绝 Grafana placeholder。

Dashboard 布局（本地离线；支持 classic `gridPos` 与 v2 Tabs/Rows/Grid/AutoGrid）：

- `dashboard layout check [FILES|DIRS]` 检查重叠、越界、重复 panel id、v2 缺失/重复/孤立 element，以及 classic panel 在 `panels[]` 中的位置与其 `y` 所属 row 不一致的情况（Grafana 先按 y/x 排序再分配 row）。有 error 退出 1，仅 warning 退出 2。
- `dashboard layout show FILE` 输出 tab/row/panel 树和坐标；`dashboard layout diff BASE CANDIDATE` 列出移动、改尺寸、新增、删除、换容器的 panel（布局变化时退出 1），可用于证明纯查询修改没有改布局。
- `validate --layout warn|error|off` 与 `import`/`push --layout warn|error|off` 使用同一套检查。默认 `warn` 只打印、不改变退出码；`error` 在任何写入前失败。
- `dashboard patch-file FILE` 支持 classic 与 v2 文件（v2 上 `--panel-id` 匹配 `spec.elements[*].spec.id`），遵守 `--dry-run`；任一操作零匹配时失败（`--allow-no-match` 放行）；拒绝引入新布局错误的补丁（`--allow-layout-errors` 放行）；支持 `--forbid-layout-change`；只有内容变化时才原子写入。

资源/API 说明：

- Alerting 资源可通过 `alert-rule`、`contact-point`、`policy` 管理；export/import 可包含 `alert-rules,contact-points,policies`。
- `api <path|url>` 是原始 Grafana API 逃生口，使用当前 context 认证，支持 `-X`、`-H`、`--query`、`-f`、`--json`、`-d`、`--data-file`、`-i`、`--raw`、`--fail`、`-o`。

## 导入单个 JSON

```bash
# 自动推断资源类型
wode-gf-cli --context local import local/single-dashboard.json

# 显式指定类型（有歧义时推荐）
wode-gf-cli --context local import local/resource.json --type dashboard
```

类型解析顺序：

1. JSON 中的 `__type`
2. 基于目录的提示 / `--type`
3. 基于 payload 结构推断
