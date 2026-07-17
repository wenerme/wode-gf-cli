import { Command } from "commander";
import { GrafanaClient } from "../client";
import { parseCommonOptions } from "../config/context";
import {
  contextAuthType,
  formatContextView,
  readCliConfig,
  resolveContextName,
  writeCliConfig,
} from "../config/store";
import { renderTable } from "../output/render";

export function buildContextAuthCommands(): Command[] {
  const contextCommand = new Command("context").alias("ctx").description("show and manage named contexts");
  contextCommand
    .command("list")
    .description("List contexts")
    .option("--json", "print contexts as json")
    .action(function contextListAction(options) {
      const config = readCliConfig();
      const globalOptions = this.optsWithGlobals() as { context?: string; name?: string };
      const currentContext = resolveContextName(globalOptions) || config.context || "default";
      const contexts = config.contexts.map((context) => ({
        current: context.name === currentContext,
        name: context.name || "default",
        baseUrl: context.baseUrl || null,
        authType: contextAuthType(context),
      }));
      if (options.json) {
        console.log(JSON.stringify({ context: currentContext, contexts }, null, 2));
        return;
      }
      console.log(
        renderTable(
          ["*", "name", "baseUrl", "auth"],
          contexts.map((context) => [
            context.current ? "*" : "",
            context.name,
            context.baseUrl || "",
            context.authType,
          ]),
        ),
      );
    });
  contextCommand
    .command("current")
    .description("Show current context")
    .option("--json", "print current context as json")
    .action(function contextCurrentAction(options) {
      const config = readCliConfig();
      const globalOptions = this.optsWithGlobals() as { context?: string; name?: string };
      const currentContext = resolveContextName(globalOptions) || config.context || "default";
      const view = formatContextView({ ...config, context: currentContext }, currentContext);
      if (options.json) {
        console.log(JSON.stringify(view, null, 2));
        return;
      }
      console.log(
        [
          `Name: ${view.name}`,
          `Current: ${view.current ? "yes" : "no"}`,
          `Base URL: ${view.baseUrl || "<none>"}`,
          `Auth Type: ${view.authType}`,
          `Service Account Token: ${view.serviceAccountTokenConfigured ? "<configured>" : "<none>"}`,
          `Username: ${view.username || "<none>"}`,
          `Password: ${view.passwordConfigured ? "<configured>" : "<none>"}`,
        ].join("\n"),
      );
    });
  contextCommand
    .command("use <NAME>")
    .description("Switch current context")
    .action(function contextUseAction(name: string) {
      const config = readCliConfig();
      if (!config.contexts.some((context) => context.name === name)) config.contexts.push({ name });
      config.context = name;
      writeCliConfig(config);
      console.log(`Using context ${name}`);
    });
  contextCommand
    .command("set <EXPR>")
    .description("Set context field, e.g. baseUrl=http://127.0.0.1:3300")
    .option("--context <NAME>", "target context name")
    .action(function contextSetAction(expr: string, options) {
      const index = expr.indexOf("=");
      if (index <= 0) throw new Error("Invalid context set expression, expect KEY=VALUE");
      const key = expr.slice(0, index).trim();
      const value = expr.slice(index + 1);
      const config = readCliConfig();
      const globalOptions = this.optsWithGlobals() as { context?: string };
      const requestedName = String(
        options.context || globalOptions.context || config.context || "default",
      ).trim();
      const name = requestedName || "default";
      let context = config.contexts.find((item) => item.name === name);
      if (!context) {
        context = { name };
        config.contexts.push(context);
      }
      context[key] = value;
      writeCliConfig(config);
      console.log(`Updated context ${name}: ${key}`);
    });

  const authCommand = new Command("auth").description("manage Grafana authentication");
  authCommand
    .command("login")
    .description("Store auth credentials into a context")
    .option("-c, --context <NAME>", "context name")
    .option("--url <url>", "Grafana URL")
    .option("--username <username>", "Grafana username")
    .option("--password <password>", "Grafana password")
    .option("--service-account-token <token>", "Grafana service account token")
    .action(function authLoginAction(options) {
      const config = readCliConfig();
      const mergedOptions = this.optsWithGlobals() as {
        context?: string;
        url?: string;
        username?: string;
        password?: string;
        serviceAccountToken?: string;
      };
      const requestedName = String(
        options.context || mergedOptions.context || config.context || "default",
      ).trim();
      const name = requestedName || "default";
      let context = config.contexts.find((item) => item.name === name);
      if (!context) {
        context = { name };
        config.contexts.push(context);
      }
      const url = options.url ?? mergedOptions.url;
      const username = options.username ?? mergedOptions.username;
      const password = options.password ?? mergedOptions.password;
      const token = options.serviceAccountToken ?? mergedOptions.serviceAccountToken;
      if (url) context.baseUrl = String(url).trim();
      if (username) context.username = String(username).trim();
      if (password !== undefined) context.password = String(password);
      if (token !== undefined) context.serviceAccountToken = String(token).trim();
      config.context = name;
      writeCliConfig(config);
      console.log(`Saved auth context ${name}`);
    });
  authCommand
    .command("whoami")
    .description("Show current Grafana identity")
    .option("--json", "print json")
    .action(async function authWhoamiAction(options) {
      const ctx = parseCommonOptions(this);
      const client = new GrafanaClient(ctx);
      const identity = await client.request<unknown>("GET", "/api/user", undefined, [200]);
      if (options.json || ctx.output === "json") {
        console.log(JSON.stringify(identity, null, 2));
        return;
      }
      console.log(JSON.stringify(identity, null, 2));
    });

  return [contextCommand, authCommand];
}
