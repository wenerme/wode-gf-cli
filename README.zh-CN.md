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
wode-gf-cli context list
wode-gf-cli context current
wode-gf-cli context use local
wode-gf-cli context set baseUrl=http://127.0.0.1:3300
wode-gf-cli context set password=secret --context local
wode-gf-cli auth login --context local --url http://127.0.0.1:3300 --service-account-token <token>
wode-gf-cli auth login --context local --url http://127.0.0.1:3300 --username admin --password admin
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

优先级说明：

- 命令行参数优先于 context / 环境变量（`--url`、`--service-account-token`、`--username`、`--password`）
- context 配置优先于环境变量
- Shell 环境变量优先于 `.env` / `.env.local`
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

# 4) 安全应用变更
wode-gf-cli --context <context> --dry-run import ./grafana-export
wode-gf-cli --context <context> import ./grafana-export
```

## 常用工作流

```bash
# 从远端拉取/导出
wode-gf-cli --context local export -o local/grafana-export

# 编辑本地 JSON
wode-gf-cli --context local query dashboard --uid <uid> --json > local/dashboard.json
$EDITOR local/dashboard.json

# dry-run 推送
wode-gf-cli --context local --dry-run import local/grafana-export

# 应用变更
wode-gf-cli --context local import local/grafana-export

# 校验 dashboard JSON 中的 panel 查询
wode-gf-cli --context local validate ./grafana --concurrency 4 --var env=prod
wode-gf-cli --context local validate ./grafana --concurrency 2 --timeout 60000
wode-gf-cli --context local validate ./grafana --interval-ms 60000

# 快速数据源查询（uid 或 name）
wode-gf-cli --context local query xyz-mysql --sql 'select 1'
wode-gf-cli --context local query my-prom --expr 'up'
wode-gf-cli --context local query my-cls --query 'serviceType=logService' --query 'logServiceParams.Query=* | select trace_id limit 1' --query 'logServiceParams.TopicId=my-topic-id' --query 'logServiceParams.region=ap-shanghai' --query 'logServiceParams.SyntaxRule=1'

# 快速列出资源
wode-gf-cli --context local list dashboard
wode-gf-cli --context local list connection --json

# 完整 query 对象透传
wode-gf-cli --context local query my-cls --query-file ./local/cls-query.json --json

# 从 stdin 读取 query 对象
cat ./local/cls-query.json | wode-gf-cli --context local query my-cls --query-file - --json

# 渲染 panel 图片
wode-gf-cli --context local render panel --dashboard-uid <uid> --panel-id 1 -o local/panel.png

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
