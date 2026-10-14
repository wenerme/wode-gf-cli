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

# 告警运行态（rule 状态、状态变迁、活跃实例、静默）
wode-gf-cli --context local alert-rule state --state firing,pending --matcher team=sre
wode-gf-cli --context local alert-rule state --fail-on firing,error --json
wode-gf-cli --context local alert-rule history <rule-uid> --from now-6h
wode-gf-cli --context local alert list --matcher team=sre
wode-gf-cli --context local --dry-run silence create --matcher team=sre --duration 2h --comment 'maintenance'
wode-gf-cli --context local --dry-run alert-rule pause <rule-uid>

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
- `dashboard layout fix [FILES|DIRS]` 把坐标改写为 Grafana 实际渲染的位置（按 row/grid 做 react-grid-layout 垂直压紧）：重叠的往下推，负 `y` 改为 0，并按 row 重排 `panels[]`。只修有错误的 grid，不会把 panel 移到别的 row 或 tab，遇到歧义布局会跳过。可用 `--dry-run` 预览。
- `validate --layout warn|error|off` 与 `import`/`push --layout warn|error|off` 使用同一套检查。默认 `warn` 只打印、不改变退出码；`error` 在任何写入前失败。
- `dashboard patch-file FILE` 支持 classic 与 v2 文件（v2 上 `--panel-id` 匹配 `spec.elements[*].spec.id`），遵守 `--dry-run`；任一操作零匹配时失败（`--allow-no-match` 放行）；拒绝引入新布局错误的补丁（`--allow-layout-errors` 放行）；支持 `--forbid-layout-change`；只有内容变化时才原子写入。

版本（dashboard 与 alert rule 配置历史）：

- `dashboard versions list <ID> [--check-layout]` 按新到旧列出版本；`--check-layout` 对每个版本做布局检查，并标出布局错误在哪一版 `introduced`、哪一版 `fixed`。`alert-rule versions list <UID>` 还会列出每一版改了哪些顶层字段。
- `versions get <ID> <VERSION>` 以可直接 import 的形状输出某个版本（classic 导出项、v2 resource 或 provisioning rule）。`VERSION` 可以是版本号、`current` 或 `current~N`。
- `versions diff <ID> <FROM> [TO]` 做结构化 diff（数组按 `id`/`refId`/`uid` 对齐，插入一个 panel 只算一处变化）。两边都可以是版本、`current[~N]` 或本地文件；`dashboard versions diff --layout` 只比较布局。有差异时退出 2，出错时退出 1。
- `versions restore <ID> <VERSION>` 把旧内容作为新版本写回，并带前置条件：classic 用 `overwrite:false` 加当前 id/version，v2 用当前 `resourceVersion` 做 PUT。期间若有人保存过，会明确报错，而不是覆盖对方。它不调用 Grafana 的 `/restore`，因为那个接口没有前置条件，而且会把 v2 dashboard 经 v1 转换后改写。restore 总是按存储格式写入（若会转换格式则拒绝，除非加 `--allow-format-change`）。支持 `--expect-version N`（当前版本不是你审过的那一版就中止）、`--dry-run` 和布局预检（`--layout`）；写入后会回读校验，若 Grafana 规范化了内容则退出 2。Alert rule 保留当前的 folder/group 和 provenance；Grafana 的 rule 写入没有前置条件，所以会在 PUT 前再核对一次版本。
- 以 v2 维护的 dashboard（v2 原生存储，或本地文件是 v2）通过 v2beta1 history 读取；可用 `--dashboard-api classic|v2` 指定。

资源/API 说明：

- Alerting 资源可通过 `alert-rule`、`contact-point`、`policy` 管理；export/import 可包含 `alert-rules,contact-points,policies`。
- `alert-rule state [RULES]` 显示运行态 state/health、最近评估时间、firing/pending 数和 lastError。过滤：`--state`、`--health`、`--folder`、`--group`、`--matcher`（rule labels）、`--instance-matcher`、`--paused`；`--instances` 附带告警实例；`--fail-on firing,pending,recovering,error,nodata` 命中时退出 2（退出 1 表示命令本身失败，rule 列表被截断也算）。`--state` 只接受 rule 状态，error/nodata 请用 `--health`。带 `--instance-matcher` 时，计数和 `--fail-on` 只看匹配到的实例。
- `alert-rule history <RULE>` 列出状态变迁（`--from` 默认 `now-24h`、`--to`、`--limit`、`--label k=v`）。默认的 annotation 历史后端会忽略 label 过滤，且最多返回 100 条变迁；过滤在本地完成，结果被截断时会标记 `truncated`。
- `alert list`（别名 `alerts`）列出 Alertmanager 活跃实例；默认隐藏 silenced/inhibited，可用 `--silenced`/`--inhibited` 显示。
- `silence list [--all] | create | expire <ID>` 管理静默。matcher 语法为 `k=v`、`k!=v`、`k=~re`、`k!~re`；`create` 拒绝零 matcher 或所有 matcher 都匹配空值的组合。`createdBy` 默认为当前 Grafana 登录名。
- `alert-rule pause|resume <RULES...>` 只切换 `isPaused`，已处于目标状态则跳过，写后回读校验，且不改变 provenance。所有写操作都支持 `--dry-run`。
- 单条 rule 的写入（`pause`/`resume`、`versions restore`）会保持组内规则顺序：Grafana 的单条 provisioning PUT 会丢掉组内序号，所以组内没有 provisioned rule 时，改为像 Grafana UI 一样经 ruler API 整组提交（组内每条 rule 的版本号都会 +1）。组内有 provisioned rule 时退回 PUT，若顺序被改会提示并退出 2。
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
