# wode-gf-cli

`wode-gf-cli` 是一个用于导出、导入、对比和修改 Grafana 资源的命令行工具。

English doc: [README.md](./README.md)

## 功能

- 导出资源到本地 JSON（按资源拆分目录，便于审阅和 git diff）
- 从本地 JSON 导入 Grafana
- 本地与远端资源差异对比
- 单资源查询、补丁更新、删除
- 支持 `--dry-run`、`--output json`、`--quiet`，便于自动化/agent 调用

支持的资源：

- `folders`
- `dashboards`
- `datasources`
- `alert-rules`
- `contact-points`
- `policies`

## 环境要求

- Node.js 18+
- Bun 1.3+（用于构建与本地开发运行）
- pnpm 10+

## 安装

### 作为包执行

- `npx wode-gf-cli --help`
- `bunx wode-gf-cli --help`

### 本地开发

```bash
pnpm install
pnpm run build
```

### 安装到 `~/bin`

```bash
pnpm run install:bin
wode-gf-cli --help
```

## 配置

可通过参数或环境变量配置 Grafana 连接。

通用环境变量：

- `GRAFANA_URL`
- `GRAFANA_SERVICE_ACCOUNT_TOKEN`

支持 profile 前缀（`--name`）：

- `PPIO_GRAFANA_URL`
- `PPIO_GRAFANA_SERVICE_ACCOUNT_TOKEN`

例如：

```bash
wode-gf-cli --name ppio export -o ./grafana-export
```

## 常用命令

```bash
# 导出所有资源
wode-gf-cli export -o ./grafana-export

# 仅导出 dashboards,datasources
wode-gf-cli export -r dashboards,datasources -o ./grafana-export

# 导入本地目录
wode-gf-cli import ./grafana-export

# 导入单个 JSON（自动推断资源类型）
wode-gf-cli --name local import local/single-dashboard.json

# 导入单个 JSON（显式指定类型，建议在自动推断不明确时使用）
wode-gf-cli --name local import local/resource.json --type dashboard

# 对比本地与远端
wode-gf-cli diff -i ./grafana-export

# 查询单个 dashboard
wode-gf-cli query dashboard --uid <uid> --json

# 打补丁
wode-gf-cli patch dashboard --uid <uid> --set dashboard.title="New Title"

# 删除单个资源
wode-gf-cli delete contact-point --uid <uid>
```

说明：

- 单文件导入优先按 `__type` 识别。
- 若无 `__type`，会按目录/`--type`/内容结构做推断。
- 为了避免歧义，建议在通用文件名场景使用 `--type`。

## Agent 友好模式

- `--output json`：输出结构化 JSON，便于脚本/agent 解析
- `--quiet`：减少文本日志噪音
- `--dry-run`：只打印计划动作，不写入 Grafana

示例：

```bash
wode-gf-cli --output json --quiet --dry-run import ./grafana-export
```

## 脚本

- `pnpm run dev`: 直接运行源码入口
- `pnpm run build`: 使用 Bun 构建 `dist/wode-gf-cli.js`
- `pnpm run lint`: Biome 检查
- `pnpm run format`: Biome 自动修复与格式化
- `pnpm run check`: lint + build
- `pnpm run install:bin`: 构建并安装到 `~/bin/wode-gf-cli`

## 远程仓库约定

- `origin`: `https://github.com/wenerme/wode-gf-cli`
- `dev`: `https://github.com/wenertech/wode-gf-cli`

建议流程：先推送到 `dev` 验证，再同步到 `origin`。
