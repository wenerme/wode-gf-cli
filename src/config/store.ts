import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../output/files";
import { CliConfigSchema } from "../schema";
import { envValue } from "./env";

export type CliConfigData = { context: string; contexts: Array<Record<string, string>> };

export function getConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return path.resolve(".wode/wode-gf-cli.yaml");
  return path.join(home, ".wode", "wode-gf-cli.yaml");
}

export function findGitRoot(startDir = process.cwd()): string | undefined {
  let current = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function getProjectConfigPath(startDir = process.cwd()): string | undefined {
  const root = findGitRoot(startDir);
  return root ? path.join(root, ".wode", "wode-gf-cli.yaml") : undefined;
}

export function parseSimpleYamlConfig(content: string): CliConfigData {
  const lines = content.split("\n");
  const contexts: Array<Record<string, string>> = [];
  let current: Record<string, string> | undefined;
  let activeContext = "default";
  let inContexts = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ").trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!rawLine.startsWith(" ") && trimmed.startsWith("context:")) {
      activeContext = trimmed.slice("context:".length).trim() || "default";
      inContexts = false;
      current = undefined;
      continue;
    }
    if (!rawLine.startsWith(" ") && trimmed === "contexts:") {
      inContexts = true;
      current = undefined;
      continue;
    }
    if (!inContexts) continue;

    if (trimmed.startsWith("- ")) {
      current = {};
      contexts.push(current);
      const rest = trimmed.slice(2).trim();
      if (rest) {
        const index = rest.indexOf(":");
        if (index > 0) current[rest.slice(0, index).trim()] = rest.slice(index + 1).trim();
      }
      continue;
    }

    if (!current) continue;
    const index = trimmed.indexOf(":");
    if (index <= 0) continue;
    current[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }

  return CliConfigSchema.parse({ context: activeContext, contexts });
}

export function migrateLegacyConfig(content: string): string {
  return content.replace(/^profile:\s*/m, "context: ").replace(/^profiles:\s*$/m, "contexts:");
}

export function readCliConfig(): CliConfigData {
  const file = getConfigPath();
  try {
    const content = fs.readFileSync(file, "utf8");
    const migrated = migrateLegacyConfig(content);
    const parsed = parseSimpleYamlConfig(migrated);
    const config: CliConfigData = {
      context: parsed.context,
      contexts: parsed.contexts.map((context) => ({ ...context })),
    };
    if (!config.contexts.some((ctx) => ctx.name === config.context)) {
      config.contexts.push({ name: config.context });
    }
    if (migrated !== content) writeCliConfig(config);
    return config;
  } catch {
    const parsed = CliConfigSchema.parse({ context: "default", contexts: [{ name: "default" }] });
    return { context: parsed.context, contexts: parsed.contexts.map((context) => ({ ...context })) };
  }
}

export function readProjectCliConfig(startDir = process.cwd()): { path?: string; context?: string } {
  const file = getProjectConfigPath(startDir);
  if (!file) return {};
  try {
    const parsed = parseSimpleYamlConfig(migrateLegacyConfig(fs.readFileSync(file, "utf8")));
    return { path: file, context: parsed.context || undefined };
  } catch {
    return { path: file };
  }
}

export function serializeCliConfig(config: CliConfigData): string {
  const lines = [`context: ${config.context}`, "contexts:"];
  const seen = new Set<string>();
  for (const rawCtx of config.contexts) {
    const name = String(rawCtx.name || "default").trim() || "default";
    if (seen.has(name)) continue;
    seen.add(name);
    const ctx: Record<string, string> = { ...rawCtx, name };
    lines.push(`  - name: ${name}`);
    for (const [key, value] of Object.entries(ctx)) {
      if (key === "name" || value === undefined || value === "") continue;
      lines.push(`    ${key}: ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function contextAuthType(ctx: Record<string, string>): string {
  const hasToken = Boolean(ctx.serviceAccountToken?.trim());
  const hasBasic = Boolean(ctx.username?.trim()) || Boolean(ctx.password?.trim());
  if (hasToken && hasBasic) return "token+basic";
  if (hasToken) return "token";
  if (hasBasic) return "basic";
  return "none";
}

export function formatContextView(config: CliConfigData, name: string) {
  const context = config.contexts.find((ctx) => ctx.name === name) || { name };
  return {
    name,
    current: config.context === name,
    baseUrl: context.baseUrl || null,
    authType: contextAuthType(context),
    serviceAccountTokenConfigured: Boolean(context.serviceAccountToken?.trim()),
    username: context.username || null,
    passwordConfigured: Boolean(context.password?.trim()),
  };
}

export function writeCliConfig(config: CliConfigData): void {
  const file = getConfigPath();
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, serializeCliConfig(config), "utf8");
}

export function resolveContextName(options: { context?: string; name?: string } = {}): string | undefined {
  return (
    options.context?.trim() ||
    options.name?.trim() ||
    envValue(["WODE_GF_CLI_CONTEXT", "WODE_GF_CLI_NAME"]) ||
    readProjectCliConfig().context
  );
}

export function getNamedContext(name: string | undefined) {
  const config = readCliConfig();
  const selectedName = name || config.context || "default";
  const context = config.contexts.find((ctx) => ctx.name === selectedName);
  return { config, context: context || { name: selectedName } };
}
