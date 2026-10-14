import { Command } from "commander";
import { GrafanaClient } from "../client";
import {
  compactLabels,
  decodeAlertmanagerAlerts,
  formatAge,
  formatDuration,
  selectActiveAlerts,
  truncate,
} from "../lib/alert-runtime";
import {
  buildSilencePayload,
  decodeSilence,
  decodeSilences,
  formatMatcher,
  parseDurationMs,
  parseLabelMatcher,
  type Silence,
} from "../lib/alert-silence";
import { asObject, asString } from "../lib/json-narrow";
import { resolveTimeToMs } from "../utils";
import type { CommandAppContext } from "./runtime";
import { printJson, wantsJson } from "./versions-shared";

const AmBase = "/api/alertmanager/grafana/api/v2";
const DefaultCreatedBy = "wode-gf-cli";

function matcherFilters(values: string[]): string[] {
  return values.map((value) => formatMatcher(parseLabelMatcher(value)));
}

export function buildAlertCommand(app: CommandAppContext): Command {
  const { collectList, runtime } = app;
  const alert = new Command("alert")
    .alias("alerts")
    .description("inspect active alert instances (Alertmanager)");
  alert
    .command("list")
    .description("List active alert instances from the Grafana Alertmanager")
    .option("--matcher <expr>", "label matcher (k=v, k!=v, k=~re, k!~re), repeatable", collectList, [])
    .option("--receiver <regex>", "only alerts routed to receivers matching regex")
    .option("--silenced", "include silenced alerts")
    .option("--inhibited", "include inhibited alerts")
    .option("--json", "print {alerts:[...]} as json")
    .action(async function alertListAction(options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const params = new URLSearchParams({ active: "true", silenced: "true", inhibited: "true" });
      for (const filter of matcherFilters(options.matcher)) params.append("filter", filter);
      if (options.receiver) params.set("receiver", String(options.receiver));
      const response = await new GrafanaClient(ctx).request<unknown>("GET", `${AmBase}/alerts?${params}`);
      const selected = selectActiveAlerts(decodeAlertmanagerAlerts(response), {
        silenced: Boolean(options.silenced),
        inhibited: Boolean(options.inhibited),
      });
      const hidden = { silenced: selected.hiddenSilenced, inhibited: selected.hiddenInhibited };

      if (wantsJson(ctx, options)) {
        printJson({ alerts: selected.alerts, hidden });
        return;
      }
      const nowMs = Date.now();
      if (selected.alerts.length === 0) runtime.printMessage(ctx, "No active alerts matched.");
      else {
        runtime.printMessage(
          ctx,
          runtime.renderTable(
            ["state", "since", "alertname", "severity", "labels", "receivers", "silencedBy"],
            selected.alerts.map((item) => [
              item.state,
              formatAge(item.startsAt, nowMs),
              truncate(item.alertname, 40),
              item.severity || "",
              compactLabels(item.labels, ["alertname", "severity", "grafana_folder"], 70),
              item.receivers.join(","),
              String(item.silencedBy.length),
            ]),
          ),
        );
      }
      const hints = [
        hidden.silenced > 0 ? `${hidden.silenced} silenced (--silenced)` : "",
        hidden.inhibited > 0 ? `${hidden.inhibited} inhibited (--inhibited)` : "",
      ].filter(Boolean);
      if (hints.length > 0) runtime.printMessage(ctx, `Hidden: ${hints.join(", ")}`);
    });
  return alert;
}

function renderSilences(app: CommandAppContext, silences: Silence[], nowMs: number) {
  return app.runtime.renderTable(
    ["id", "state", "ends", "matchers", "createdBy", "comment"],
    silences.map((item) => {
      const endsMs = item.endsAt ? Date.parse(item.endsAt) : Number.NaN;
      const ends = Number.isFinite(endsMs)
        ? endsMs >= nowMs
          ? `in ${formatDuration(endsMs - nowMs)}`
          : `${formatDuration(nowMs - endsMs)} ago`
        : "-";
      return [
        item.id,
        item.state,
        ends,
        truncate(item.matchers.map(formatMatcher).join(","), 60),
        item.createdBy || "",
        truncate(item.comment, 40),
      ];
    }),
  );
}

async function currentLogin(client: GrafanaClient): Promise<string> {
  try {
    const user = asObject(await client.request<unknown>("GET", "/api/user"));
    return asString(user?.login) || DefaultCreatedBy;
  } catch {
    return DefaultCreatedBy;
  }
}

async function getSilence(client: GrafanaClient, id: string): Promise<Silence | undefined> {
  const result = await client.requestWithStatus<unknown>(
    "GET",
    `${AmBase}/silence/${encodeURIComponent(id)}`,
  );
  if (result.status === 404) return undefined;
  if (result.status !== 200) {
    throw new Error(`${result.status} GET ${AmBase}/silence/${id}: ${JSON.stringify(result.data)}`);
  }
  return decodeSilence(result.data);
}

export function buildSilenceCommand(app: CommandAppContext): Command {
  const { collectList, runtime } = app;
  const silence = new Command("silence").alias("silences").description("manage Alertmanager silences");

  silence
    .command("list")
    .description("List silences (expired hidden unless --all)")
    .option("--matcher <expr>", "label matcher filter, repeatable", collectList, [])
    .option("--all", "include expired silences")
    .option("--json", "print {silences:[...]} as json")
    .action(async function silenceListAction(options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const params = new URLSearchParams();
      for (const filter of matcherFilters(options.matcher)) params.append("filter", filter);
      const query = params.size > 0 ? `?${params}` : "";
      const response = await new GrafanaClient(ctx).request<unknown>("GET", `${AmBase}/silences${query}`);
      const silences = decodeSilences(response, { all: Boolean(options.all) });
      if (wantsJson(ctx, options)) printJson({ silences });
      else if (silences.length === 0) runtime.printMessage(ctx, "No silences matched.");
      else runtime.printMessage(ctx, renderSilences(app, silences, Date.now()));
    });

  silence
    .command("create")
    .description("Create a silence; refuses empty or match-everything matcher sets")
    .option(
      "--matcher <expr>",
      "label matcher (k=v, k!=v, k=~re, k!~re), required, repeatable",
      collectList,
      [],
    )
    .option("--duration <duration>", "silence length, e.g. 30m, 2h, 1h30m, 1d")
    .option("--until <time>", "silence end time (ISO, epoch, or now+2h)")
    .requiredOption("--comment <text>", "why the silence exists")
    .option("--created-by <name>", "author; defaults to current Grafana login")
    .option("--json", "print result as json")
    .action(async function silenceCreateAction(options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      if (Boolean(options.duration) === Boolean(options.until)) {
        throw new Error("Specify exactly one of --duration or --until");
      }
      const client = new GrafanaClient(ctx);
      const nowMs = Date.now();
      const endMs = options.duration
        ? nowMs + parseDurationMs(String(options.duration))
        : resolveTimeToMs(String(options.until), nowMs);
      const payload = buildSilencePayload({
        matchers: (options.matcher as string[]).map((item) => parseLabelMatcher(item)),
        nowMs,
        endMs,
        createdBy: asString(options.createdBy) || (await currentLogin(client)),
        comment: String(options.comment || ""),
      });

      if (ctx.dryRun) {
        if (wantsJson(ctx, options)) printJson({ type: "dry-run", action: "silence-create", payload });
        else {
          runtime.printMessage(ctx, `[DRY-RUN] POST ${AmBase}/silences`);
          runtime.printMessage(ctx, JSON.stringify(payload, null, 2));
        }
        return;
      }
      const created = asObject(
        await client.request<unknown>("POST", `${AmBase}/silences`, payload, [200, 202]),
      );
      const id = asString(created?.silenceID);
      if (!id) throw new Error(`Silence create returned no silenceID: ${JSON.stringify(created)}`);
      const readback = await getSilence(client, id);
      if (wantsJson(ctx, options)) printJson({ type: "silence-create", id, silence: readback });
      else {
        runtime.printMessage(ctx, `Created silence ${id} (${readback?.state || "unknown"})`);
        if (readback) runtime.printMessage(ctx, renderSilences(app, [readback], Date.now()));
      }
    });

  silence
    .command("expire <IDS...>")
    .description("Expire silences by id (skips already expired)")
    .option("--json", "print results as json")
    .action(async function silenceExpireAction(ids: string[], options) {
      const ctx = runtime.parseCommonOptions(this as unknown as Command);
      const client = new GrafanaClient(ctx);
      const results: Array<{ id: string; from: string; action: string; silence?: Silence; error?: string }> =
        [];
      for (const id of ids) {
        try {
          const current = await getSilence(client, id);
          if (!current) throw new Error("silence not found");
          if (current.state === "expired") {
            results.push({ id, from: current.state, action: "skipped", silence: current });
            continue;
          }
          if (ctx.dryRun) {
            results.push({ id, from: current.state, action: "dry-run", silence: current });
            continue;
          }
          await client.request("DELETE", `${AmBase}/silence/${encodeURIComponent(id)}`, undefined, [200]);
          const readback = await getSilence(client, id);
          if (readback && readback.state !== "expired") throw new Error(`readback state=${readback.state}`);
          results.push({ id, from: current.state, action: "expired", silence: readback || current });
        } catch (error) {
          results.push({ id, from: "?", action: "failed", error: (error as Error).message });
        }
      }
      if (results.some((item) => item.action === "failed")) process.exitCode = 1;
      if (wantsJson(ctx, options)) {
        printJson({ type: "silence-expire", dryRun: ctx.dryRun, results });
        return;
      }
      for (const item of results) {
        const prefix = item.action === "dry-run" ? "[DRY-RUN] " : "";
        const outcome =
          item.action === "failed"
            ? `failed: ${item.error}`
            : item.action === "skipped"
              ? "skipped (already expired)"
              : "expired";
        const matchers = item.silence?.matchers.map(formatMatcher).join(",") || "";
        runtime.printMessage(ctx, `${prefix}${item.id} ${item.from} -> ${outcome}  ${matchers}`);
      }
      if (ctx.dryRun) runtime.printMessage(ctx, "Dry-run mode enabled, no changes were sent.");
    });

  return silence;
}
