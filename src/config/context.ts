import type { Command } from "commander";
import { type GrafanaCliContext, GrafanaCliContextSchema } from "../schema";
import { envValue, normalizePrefix } from "./env";
import { getNamedContext, resolveContextName } from "./store";

export type OutputFormat = "text" | "json";
export type RuntimeContext = GrafanaCliContext & { output: OutputFormat; quiet: boolean };

export function parseCommonOptions(cmd: Command, cfg?: { requireUrl?: boolean }): RuntimeContext {
  const options = cmd.optsWithGlobals() as {
    name?: string;
    context?: string;
    url?: string;
    serviceAccountToken?: string;
    username?: string;
    password?: string;
    timeout?: string;
    dryRun?: boolean;
    debug?: boolean;
    output?: string;
    quiet?: boolean;
  };

  const contextName = resolveContextName(options);
  if (options.name?.trim()) {
    console.warn("[WARN] --name is deprecated; prefer --context");
  }
  if (!options.context?.trim() && !options.name?.trim() && process.env.WODE_GF_CLI_NAME?.trim()) {
    console.warn("[WARN] WODE_GF_CLI_NAME is deprecated; prefer WODE_GF_CLI_CONTEXT");
  }
  const prefix = contextName ? normalizePrefix(contextName) : undefined;
  const { context } = getNamedContext(contextName);

  const url =
    options.url ||
    context.baseUrl ||
    envValue(
      [
        prefix ? `${prefix}_GRAFANA_URL` : "",
        contextName ? `${contextName}_GRAFANA_URL` : "",
        "GRAFANA_URL",
      ].filter(Boolean),
    );

  const apiKey =
    options.serviceAccountToken ||
    context.serviceAccountToken ||
    envValue(
      [
        prefix ? `${prefix}_GRAFANA_SERVICE_ACCOUNT_TOKEN` : "",
        contextName ? `${contextName}_GRAFANA_SERVICE_ACCOUNT_TOKEN` : "",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN",
      ].filter(Boolean),
    );

  const username =
    options.username ||
    context.username ||
    envValue(
      [
        prefix ? `${prefix}_GRAFANA_USERNAME` : "",
        contextName ? `${contextName}_GRAFANA_USERNAME` : "",
        "GRAFANA_USERNAME",
      ].filter(Boolean),
    );
  const password =
    options.password ||
    context.password ||
    envValue(
      [
        prefix ? `${prefix}_GRAFANA_PASSWORD` : "",
        contextName ? `${contextName}_GRAFANA_PASSWORD` : "",
        "GRAFANA_PASSWORD",
      ].filter(Boolean),
    );

  if (cfg?.requireUrl !== false && !url) {
    throw new Error("Missing Grafana URL. Set config/env/--url before running Grafana commands");
  }

  const timeoutMs = Math.max(1000, Number.parseInt(options.timeout || "20000", 10) || 20000);
  const output: OutputFormat = options.output === "json" ? "json" : "text";
  const parsed = GrafanaCliContextSchema.parse({
    contextName,
    url: url || "",
    apiKey,
    username,
    password,
    timeoutMs,
    dryRun: Boolean(options.dryRun),
    debug: Boolean(options.debug),
  });

  return { ...parsed, output, quiet: Boolean(options.quiet) };
}
