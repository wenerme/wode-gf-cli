import type { GrafanaClient } from "../client";
import type { JsonObject } from "../core/json";
import { asObject, asObjectArray, asString, getObjectField } from "./json-narrow";

/**
 * Alert rule config versions: `GET /api/ruler/grafana/api/v1/rule/:uid/versions` (ruler DTOs, newest first).
 * Content is presented in the provisioning shape (`/api/v1/provisioning/alert-rules/:uid`), the same shape
 * export/import use, so a version can be diffed against or written back as a local file.
 *
 * There is no restore endpoint and no client precondition on provisioning PUT. Restore therefore re-reads the
 * rule version immediately before writing and verifies the readback; the remaining window is one round-trip.
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
  for (const key of ["labels", "annotations"] as const) {
    const value = asObject(rest[key]);
    if (!value || Object.keys(value).length === 0) delete rest[key];
  }
  for (const key of ["notification_settings", "record"] as const) if (rest[key] == null) delete rest[key];
  if (rest.keep_firing_for === "0s") delete rest.keep_firing_for;
  if (rest.isPaused === false) delete rest.isPaused;
  return rest;
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

/**
 * Writes `target` over `current` in place (current folder/group are kept). Provenance is preserved: rules without
 * provenance are written with `X-Disable-Provenance`, `api` rules without it; file-provisioned rules are refused.
 */
export async function writeAlertRuleVersion(
  client: GrafanaClient,
  current: AlertRuleVersion,
  target: JsonObject,
): Promise<AlertRuleVersion> {
  const uid = asString(current.rule.uid) as string;
  // The versions list omits provenance; the single-rule GET carries it.
  const latest = await getCurrentAlertRule(client, uid);
  if (latest.version !== current.version) {
    throw new Error(
      `Alert rule ${uid} changed after version ${current.version} was read (now ${latest.version}); re-run to review`,
    );
  }
  if (latest.provenance && latest.provenance !== "api") {
    throw new Error(`Alert rule ${uid} is provisioned from ${latest.provenance}; change it at the source`);
  }
  const body = { ...target, uid, folderUID: current.rule.folderUID, ruleGroup: current.rule.ruleGroup };
  // Grafana answers 409 provenanceMismatch when the header does not match the stored provenance.
  const headers: Record<string, string> = latest.provenance ? {} : { "X-Disable-Provenance": "true" };
  await client.request(
    "PUT",
    `/api/v1/provisioning/alert-rules/${encodeURIComponent(uid)}`,
    body,
    [200],
    headers,
  );
  return getCurrentAlertRule(client, uid);
}
