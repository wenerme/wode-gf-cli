import type { GrafanaClient } from "../client";
import type { JsonObject } from "../core/json";
import { asObject, asObjectArray, asString, getObjectField } from "./json-narrow";

/**
 * Alert rule config versions: `GET /api/ruler/grafana/api/v1/rule/:uid/versions` (ruler DTOs, newest first).
 * Content is presented in the provisioning shape (`/api/v1/provisioning/alert-rules/:uid`), the same shape
 * export/import use, so a version can be diffed against or written back as a local file.
 *
 * There is no restore endpoint and no client precondition on rule writes; see alert-rule-write.ts for how a single
 * rule is written without reordering its group.
 */
export type AlertRuleVersion = {
  version: number;
  updated?: string;
  updatedBy?: string;
  message?: string;
  provenance?: string;
  rule: JsonObject;
};

const RulerBase = "/api/ruler/grafana/api/v1/rule";

/** Ruler DTO -> provisioning rule. Field names verified against definitions/{cortex-ruler,provisioning_alert_rules}.go. */
export function rulerToProvisioning(dto: JsonObject): JsonObject {
  const ga = getObjectField(dto, "grafana_alert") || {};
  const rule: JsonObject = {
    uid: ga.uid,
    title: ga.title,
    condition: ga.condition,
    data: ga.data,
    folderUID: ga.namespace_uid,
    ruleGroup: ga.rule_group,
    noDataState: ga.no_data_state,
    execErrState: ga.exec_err_state,
    for: dto.for,
    keep_firing_for: dto.keep_firing_for,
    labels: dto.labels,
    annotations: dto.annotations,
    isPaused: Boolean(ga.is_paused),
    notification_settings: ga.notification_settings ?? null,
    record: ga.record ?? null,
  };
  if (ga.missing_series_evals_to_resolve !== undefined) {
    rule.missingSeriesEvalsToResolve = ga.missing_series_evals_to_resolve;
  }
  return rule;
}

function toVersion(dto: JsonObject): AlertRuleVersion {
  const ga = getObjectField(dto, "grafana_alert") || {};
  const by = getObjectField(ga, "updated_by");
  return {
    version: Number(ga.version),
    updated: asString(ga.updated),
    updatedBy: asString(by?.name) || asString(by?.uid),
    message: asString(ga.message) || undefined,
    provenance: asString(ga.provenance) || undefined,
    rule: rulerToProvisioning(dto),
  };
}

/** Drops server bookkeeping and empty optional fields so provisioning GETs, versions and local files compare equal. */
export function comparableAlertRule(rule: JsonObject): JsonObject {
  const { id: _id, orgID: _org, updated: _updated, provenance: _prov, ...rest } = rule;
  // A key holding undefined is the same as no key (JSON files and Grafana responses never carry undefined).
  for (const key of Object.keys(rest)) if (rest[key] === undefined) delete rest[key];
  for (const key of ["labels", "annotations"] as const) {
    const value = asObject(rest[key]);
    if (!value || Object.keys(value).length === 0) delete rest[key];
  }
  for (const key of ["notification_settings", "record"] as const) if (rest[key] == null) delete rest[key];
  if (rest.keep_firing_for === "0s") delete rest.keep_firing_for;
  if (rest.isPaused === false) delete rest.isPaused;
  if (rest.missingSeriesEvalsToResolve === 0) delete rest.missingSeriesEvalsToResolve;
  if (Array.isArray(rest.data)) rest.data = rest.data.map(comparableQuery);
  return rest;
}

/** Values Grafana fills in on save, so a hand-written rule file compares equal to what Grafana stores. */
function comparableQuery(value: unknown): unknown {
  const query = asObject(value);
  if (!query) return value;
  const { queryType, relativeTimeRange, model, ...rest } = query;
  const out: JsonObject = { ...rest };
  if (queryType) out.queryType = queryType;
  const range = asObject(relativeTimeRange);
  if (range && (range.from || range.to)) out.relativeTimeRange = range;
  const m = asObject(model);
  if (m) {
    const { intervalMs, maxDataPoints, ...modelRest } = m;
    out.model = {
      ...modelRest,
      // Grafana stores 0/absent as these defaults (models/alert_query.go).
      ...(intervalMs !== undefined && intervalMs !== 0 && intervalMs !== 1000 ? { intervalMs } : {}),
      ...(maxDataPoints !== undefined && maxDataPoints !== 0 && maxDataPoints !== 43200
        ? { maxDataPoints }
        : {}),
    };
  } else if (model !== undefined) out.model = model;
  return out;
}

export async function resolveAlertRuleUid(client: GrafanaClient, token: string): Promise<string> {
  const direct = await client.requestWithStatus<unknown>("GET", `${RulerBase}/${encodeURIComponent(token)}`);
  if (direct.status === 200) return token;
  if (direct.status !== 404) {
    throw new Error(`${direct.status} GET ${RulerBase}/${token}: ${JSON.stringify(direct.data)}`);
  }
  const rules = asObjectArray(await client.request<unknown>("GET", "/api/v1/provisioning/alert-rules"));
  const hits = rules.filter((rule) => asString(rule.title) === token);
  if (hits.length === 1) return asString(hits[0]?.uid) as string;
  if (hits.length > 1) throw new Error(`Alert rule title "${token}" is ambiguous; use the uid`);
  throw new Error(`Alert rule not found: ${token}`);
}

export async function getCurrentAlertRule(client: GrafanaClient, uid: string): Promise<AlertRuleVersion> {
  const dto = asObject(await client.request<unknown>("GET", `${RulerBase}/${encodeURIComponent(uid)}`));
  if (!dto) throw new Error(`Alert rule ${uid} response is not an object`);
  return toVersion(dto);
}

export async function listAlertRuleVersions(client: GrafanaClient, uid: string): Promise<AlertRuleVersion[]> {
  const items = asObjectArray(
    await client.request<unknown>("GET", `${RulerBase}/${encodeURIComponent(uid)}/versions`),
  );
  return items.map(toVersion).sort((a, b) => b.version - a.version);
}

export async function getAlertRuleVersion(
  client: GrafanaClient,
  uid: string,
  version: number,
): Promise<AlertRuleVersion> {
  const hit = (await listAlertRuleVersions(client, uid)).find((item) => item.version === version);
  if (!hit) throw new Error(`Alert rule ${uid} has no version ${version}`);
  return hit;
}
