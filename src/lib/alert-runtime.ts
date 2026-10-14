import { asObject, asObjectArray, asString } from "./json-narrow";

export type JsonObject = Record<string, unknown>;

/** Rule-level states accepted by `state=` on the Prometheus-compatible rules API (api_prometheus.go). */
export const RuleStateFilters = [
  "firing",
  "alerting",
  "pending",
  "inactive",
  "normal",
  "recovering",
  "nodata",
  "error",
] as const;
/** Health values accepted by `health=` (api_prometheus.go GetHealthFromQuery). */
export const RuleHealthFilters = ["ok", "error", "nodata", "unknown"] as const;
export const FailOnValues = ["firing", "pending", "recovering", "error", "nodata"] as const;
export type FailOn = (typeof FailOnValues)[number];

export type RuleInstance = {
  state: string;
  activeAt?: string;
  value?: string;
  labels: Record<string, string>;
};

export type RuleRuntime = {
  uid: string;
  title: string;
  folderUid?: string;
  folder?: string;
  group: string;
  type?: string;
  state: string;
  health: string;
  isPaused: boolean;
  lastError?: string;
  lastEvaluation?: string;
  evaluationTime?: number;
  interval?: number;
  counts: Record<string, number>;
  labels: Record<string, string>;
  instances?: RuleInstance[];
};

export type RulesPage = { rules: RuleRuntime[]; nextToken?: string };

export function splitListValues(values: string[] | undefined): string[] {
  return (values || [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function validateChoices<T extends string>(
  values: string[],
  allowed: readonly T[],
  flag: string,
): T[] {
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new Error(`Invalid ${flag} value: ${value}. Allowed: ${allowed.join(", ")}`);
    }
  }
  return values as T[];
}

export function stringRecord(value: unknown, dropPrivate = false): Record<string, string> {
  const obj = asObject(value);
  const result: Record<string, string> = {};
  if (!obj) return result;
  for (const [key, item] of Object.entries(obj)) {
    if (dropPrivate && key.startsWith("__") && key.endsWith("__")) continue;
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

function numberRecord(value: unknown): Record<string, number> {
  const obj = asObject(value);
  const result: Record<string, number> = {};
  if (!obj) return result;
  for (const [key, item] of Object.entries(obj)) {
    if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
  }
  return result;
}

/** Go zero time ("0001-01-01T00:00:00Z") means the rule never evaluated. */
function evaluatedAt(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms > 0 ? text : undefined;
}

/** Normalize rule instance totals (lowercase eval.State names) to stable count keys. */
function ruleCounts(totals: Record<string, number>): Record<string, number> {
  return {
    firing: totals.alerting ?? 0,
    pending: totals.pending ?? 0,
    recovering: totals.recovering ?? 0,
    nodata: totals.nodata ?? 0,
    error: totals.error ?? 0,
    normal: totals.normal ?? 0,
  };
}

/** Decode `GET /api/prometheus/grafana/api/v1/rules` into flat rule rows. */
export function decodePrometheusRules(response: unknown): RulesPage {
  const body = asObject(response);
  if (!body) throw new Error("Rules response is not an object");
  if (body.status === "error") {
    throw new Error(`Rules API error: ${asString(body.error) || asString(body.errorType) || "unknown"}`);
  }
  const data = asObject(body.data);
  const rules: RuleRuntime[] = [];
  for (const group of asObjectArray(data?.groups)) {
    const groupName = asString(group.name) || "";
    const folderUid = asString(group.folderUid);
    const folder = asString(group.file);
    const interval = typeof group.interval === "number" ? group.interval : undefined;
    for (const rule of asObjectArray(group.rules)) {
      const alerts = Array.isArray(rule.alerts) ? asObjectArray(rule.alerts) : undefined;
      rules.push({
        uid: asString(rule.uid) || "",
        title: asString(rule.name) || "",
        folderUid: asString(rule.folderUid) || folderUid,
        folder,
        group: groupName,
        type: asString(rule.type),
        state: asString(rule.state) || "unknown",
        health: asString(rule.health) || "unknown",
        isPaused: rule.isPaused === true,
        lastError: asString(rule.lastError),
        lastEvaluation: evaluatedAt(rule.lastEvaluation),
        evaluationTime: typeof rule.evaluationTime === "number" ? rule.evaluationTime : undefined,
        interval,
        counts: ruleCounts(numberRecord(rule.totals)),
        labels: stringRecord(rule.labels),
        instances: alerts?.map((alert) => ({
          state: asString(alert.state) || "unknown",
          activeAt: evaluatedAt(alert.activeAt),
          value: asString(alert.value),
          labels: stringRecord(alert.labels, true),
        })),
      });
    }
  }
  return { rules, nextToken: asString(data?.groupNextToken) };
}

export function ruleMatchesFailOn(rule: RuleRuntime, failOn: FailOn): boolean {
  if (failOn === "firing") return rule.state === "firing" || rule.counts.firing > 0;
  if (failOn === "pending") return rule.state === "pending" || rule.counts.pending > 0;
  if (failOn === "recovering") return rule.state === "recovering" || rule.counts.recovering > 0;
  if (failOn === "error") return rule.health === "error" || rule.counts.error > 0;
  return rule.health === "nodata" || rule.counts.nodata > 0;
}

export function failingRules(rules: RuleRuntime[], failOn: FailOn[]): RuleRuntime[] {
  if (failOn.length === 0) return [];
  return rules.filter((rule) => failOn.some((item) => ruleMatchesFailOn(rule, item)));
}

// ---------- state history ----------

export type HistoryRow = {
  time: string;
  timeMs: number;
  prev: string;
  next: string;
  labels: Record<string, string>;
  values?: Record<string, unknown>;
  error?: string;
  text?: string;
};

/**
 * Grafana's annotation historian builds the frame with `time.Unix(item.Time, 0)` while item.Time is epoch
 * milliseconds, so the JSON time column is 1000x too large (looks like microseconds). Loki-backed frames
 * carry real epoch milliseconds. Normalize both by magnitude: anything beyond year ~5138 in ms is scaled.
 */
export function normalizeHistoryTimeMs(raw: number): number {
  return raw > 1e14 ? Math.round(raw / 1000) : raw;
}

/** Parse the `{k=v, k2=v2}` label block embedded in annotation text. */
export function parseAnnotationTextLabels(text: string): Record<string, string> {
  const match = /\{([^{}]*)\}/.exec(text);
  const result: Record<string, string> = {};
  if (!match?.[1]) return result;
  for (const part of match[1].split(/,\s*/)) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function frameColumns(frame: JsonObject): Map<string, unknown[]> {
  const schema = asObject(frame.schema);
  const data = asObject(frame.data);
  const fields = asObjectArray(schema?.fields);
  const values = Array.isArray(data?.values) ? (data.values as unknown[]) : [];
  const columns = new Map<string, unknown[]>();
  fields.forEach((field, index) => {
    const name = asString(field.name);
    const column = values[index];
    if (name) columns.set(name, Array.isArray(column) ? column : []);
  });
  return columns;
}

/**
 * Decode the `GET /api/v1/rules/history` dataframe. Supports the annotation backend shape
 * (time/text/prev/next/data) and the Loki backend shape (time/line/labels). Null cells decode as empty.
 */
export function decodeHistoryFrame(response: unknown): HistoryRow[] {
  const frame = asObject(response);
  if (!frame) return [];
  const columns = frameColumns(frame);
  const times = columns.get("time") || [];
  const rows: HistoryRow[] = [];
  for (let index = 0; index < times.length; index += 1) {
    const rawTime = times[index];
    if (typeof rawTime !== "number" || !Number.isFinite(rawTime)) continue;
    const timeMs = normalizeHistoryTimeMs(rawTime);
    const row: HistoryRow = { time: new Date(timeMs).toISOString(), timeMs, prev: "", next: "", labels: {} };
    if (columns.has("line")) {
      const line = asObject(parseJsonValue(columns.get("line")?.[index]));
      row.prev = asString(line?.previous) || "";
      row.next = asString(line?.current) || "";
      row.labels = stringRecord(line?.labels, true);
      row.values = asObject(line?.values);
      row.error = asString(line?.error);
    } else {
      const text = asString(columns.get("text")?.[index]);
      const data = asObject(parseJsonValue(columns.get("data")?.[index]));
      row.prev = asString(columns.get("prev")?.[index]) || "";
      row.next = asString(columns.get("next")?.[index]) || "";
      row.labels = text ? stringRecord(parseAnnotationTextLabels(text), true) : {};
      row.values = asObject(data?.values);
      row.error = asString(data?.error);
      row.text = text;
    }
    rows.push(row);
  }
  return rows;
}

export function parseLabelFilters(values: string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values || []) {
    const index = value.indexOf("=");
    const key = index > 0 ? value.slice(0, index).trim() : "";
    if (!key || /[!~]$/.test(key)) throw new Error(`Invalid --label value: ${value}. Use key=value`);
    result[key] = value.slice(index + 1).trim();
  }
  return result;
}

/** Client-side label filter, sort newest first, then limit. Annotation backend ignores label filters. */
export function selectHistoryRows(
  rows: HistoryRow[],
  options: { labels: Record<string, string>; limit: number },
): HistoryRow[] {
  const entries = Object.entries(options.labels);
  return rows
    .filter((row) => entries.every(([key, value]) => row.labels[key] === value))
    .sort((a, b) => b.timeMs - a.timeMs)
    .slice(0, options.limit);
}

// ---------- alertmanager alerts ----------

export type ActiveAlert = {
  fingerprint: string;
  state: string;
  startsAt?: string;
  endsAt?: string;
  updatedAt?: string;
  alertname: string;
  severity?: string;
  ruleUid?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  receivers: string[];
  silencedBy: string[];
  inhibitedBy: string[];
  generatorURL?: string;
};

export function decodeAlertmanagerAlerts(response: unknown): ActiveAlert[] {
  if (!Array.isArray(response)) throw new Error("Alertmanager alerts response is not an array");
  return asObjectArray(response).map((alert) => {
    const rawLabels = stringRecord(alert.labels);
    const status = asObject(alert.status);
    const strings = (value: unknown) =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    return {
      fingerprint: asString(alert.fingerprint) || "",
      state: asString(status?.state) || "unknown",
      startsAt: asString(alert.startsAt),
      endsAt: asString(alert.endsAt),
      updatedAt: asString(alert.updatedAt),
      alertname: rawLabels.alertname || "",
      severity: rawLabels.severity,
      ruleUid: rawLabels.__alert_rule_uid__,
      labels: stringRecord(rawLabels, true),
      annotations: stringRecord(alert.annotations, true),
      receivers: asObjectArray(alert.receivers)
        .map((item) => asString(item.name))
        .filter((item): item is string => Boolean(item)),
      silencedBy: strings(status?.silencedBy),
      inhibitedBy: strings(status?.inhibitedBy),
      generatorURL: asString(alert.generatorURL),
    };
  });
}

/** Keep active alerts, plus silenced/inhibited ones only when requested. Returns hidden counts for hints. */
export function selectActiveAlerts(
  alerts: ActiveAlert[],
  options: { silenced: boolean; inhibited: boolean },
): { alerts: ActiveAlert[]; hiddenSilenced: number; hiddenInhibited: number } {
  let hiddenSilenced = 0;
  let hiddenInhibited = 0;
  const kept = alerts.filter((alert) => {
    const silenced = alert.silencedBy.length > 0;
    const inhibited = alert.inhibitedBy.length > 0;
    if (silenced && !options.silenced) {
      hiddenSilenced += 1;
      return false;
    }
    if (inhibited && !options.inhibited) {
      hiddenInhibited += 1;
      return false;
    }
    return true;
  });
  return { alerts: kept, hiddenSilenced, hiddenInhibited };
}

// ---------- pause / resume ----------

export type PauseUpdate = {
  changed: boolean;
  from: boolean;
  to: boolean;
  provenance: string;
  body: JsonObject;
  headers: Record<string, string>;
};

/**
 * Build a provisioning PUT that only flips isPaused and keeps provenance unchanged:
 * - stored provenance none: send `X-Disable-Provenance` (without it Grafana promotes the rule to `api`)
 * - stored provenance set (e.g. `api`): omit the header (with it Grafana answers 409 provenanceMismatch)
 */
export function buildPauseUpdate(rule: JsonObject, paused: boolean): PauseUpdate {
  const from = rule.isPaused === true;
  const provenance = asString(rule.provenance) || "";
  const { provenance: _provenance, ...rest } = rule;
  return {
    changed: from !== paused,
    from,
    to: paused,
    provenance,
    body: { ...rest, isPaused: paused },
    headers: provenance ? {} : { "X-Disable-Provenance": "true" },
  };
}

// ---------- formatting ----------

export function formatAge(fromIso: string | undefined, nowMs = Date.now()): string {
  if (!fromIso) return "-";
  const ms = Date.parse(fromIso);
  if (!Number.isFinite(ms)) return "-";
  return formatDuration(nowMs - ms);
}

export function formatDuration(deltaMs: number): string {
  const sign = deltaMs < 0 ? "-" : "";
  let seconds = Math.floor(Math.abs(deltaMs) / 1000);
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  if (days > 0) return `${sign}${days}d${hours}h`;
  if (hours > 0) return `${sign}${hours}h${minutes}m`;
  if (minutes > 0) return `${sign}${minutes}m${seconds}s`;
  return `${sign}${seconds}s`;
}

export function compactLabels(labels: Record<string, string>, omit: string[] = [], max = 80): string {
  const text = Object.entries(labels)
    .filter(([key]) => !omit.includes(key))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return truncate(text, max);
}

export function truncate(text: string | undefined, max: number): string {
  if (!text) return "";
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, Math.max(0, max - 3))}...` : single;
}

/** ISO-8601 in the local timezone with offset, e.g. 2026-01-02T03:04:05+08:00. */
export function formatLocalIso(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function formatValues(values: Record<string, unknown> | undefined, max = 60): string {
  if (!values) return "";
  return truncate(
    Object.entries(values)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(","),
    max,
  );
}
