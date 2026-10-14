import type { GrafanaClient } from "../client";
import type { JsonObject } from "../core/json";
import { type AlertRuleVersion, getCurrentAlertRule } from "./alert-rule-versions";
import { asObject, asObjectArray, asString, getObjectField } from "./json-narrow";

/**
 * Single-rule writes that keep the group intact.
 *
 * `PUT /api/v1/provisioning/alert-rules/:uid` drops the rule's group index, so the rule jumps inside its group
 * (verified on 13.1.0: last rule of 3 became second). The Grafana UI instead re-submits the whole ruler group
 * (`POST /api/ruler/grafana/api/v1/rules/:folderUid`), which keeps order (Grafana then bumps the version of every
 * rule in the group); Grafana refuses that path when any rule in the group is provisioned. So: ruler group when nothing in the group is
 * provisioned, otherwise the provisioning PUT (provenance header matched), and report a changed order.
 *
 * Neither path has a client precondition. The rule version is re-checked against the group read right before
 * writing. The ruler path replaces the whole group from that read: during the one round-trip between the read and
 * the POST, a concurrent edit of a sibling is overwritten and a rule added to the group concurrently is deleted.
 */
export type RuleWriteResult = {
  path: "ruler-group" | "provisioning";
  rule: AlertRuleVersion;
  orderBefore: string[];
  orderAfter: string[];
};

const RulerRules = "/api/ruler/grafana/api/v1/rules";

type RulerGroup = { body: JsonObject; rules: JsonObject[] };

async function getRulerGroup(client: GrafanaClient, folderUid: string, group: string): Promise<RulerGroup> {
  // Grafana answers this GET with 202 (verified on 13.1.0).
  const path = `${RulerRules}/${encodeURIComponent(folderUid)}/${encodeURIComponent(group)}`;
  const body = asObject(await client.request<unknown>("GET", path, undefined, [200, 202]));
  if (!body) throw new Error(`Rule group ${folderUid}/${group} response is not an object`);
  return { body, rules: asObjectArray(body.rules) };
}

const uidOf = (dto: JsonObject) => asString(getObjectField(dto, "grafana_alert")?.uid) || "";

/** Provisioning-shaped spec -> the ruler DTO of the same rule (location fields are left as stored). */
export function applyProvisioningToRuler(dto: JsonObject, rule: JsonObject): JsonObject {
  const ga = { ...(getObjectField(dto, "grafana_alert") || {}) };
  const set = (key: string, value: unknown) => {
    if (value !== undefined) ga[key] = value;
  };
  set("title", rule.title);
  set("condition", rule.condition);
  set("data", rule.data);
  set("no_data_state", rule.noDataState);
  set("exec_err_state", rule.execErrState);
  set("is_paused", rule.isPaused === true);
  set("notification_settings", rule.notification_settings ?? undefined);
  set("record", rule.record ?? undefined);
  // Absent means "default", but the ruler API treats a missing value as "keep current"; 0 resets it.
  ga.missing_series_evals_to_resolve = rule.missingSeriesEvalsToResolve ?? 0;
  if (rule.notification_settings === null) delete ga.notification_settings;
  if (rule.record === null) delete ga.record;
  return {
    ...dto,
    for: rule.for ?? dto.for,
    keep_firing_for: rule.keep_firing_for ?? dto.keep_firing_for,
    labels: rule.labels ?? {},
    annotations: rule.annotations ?? {},
    grafana_alert: ga,
  };
}

/** Writes `spec` (provisioning shape) over rule `uid`, which must still be at `expectVersion`. */
export async function writeAlertRule(
  client: GrafanaClient,
  uid: string,
  spec: JsonObject,
  expectVersion: number,
): Promise<RuleWriteResult> {
  const latest = await getCurrentAlertRule(client, uid);
  if (latest.version !== expectVersion) {
    throw new Error(
      `Alert rule ${uid} changed after version ${expectVersion} was read (now ${latest.version}); re-run to review`,
    );
  }
  if (latest.provenance && latest.provenance !== "api") {
    throw new Error(`Alert rule ${uid} is provisioned from ${latest.provenance}; change it at the source`);
  }
  const folderUid = asString(latest.rule.folderUID) as string;
  const groupName = asString(latest.rule.ruleGroup) as string;
  const group = await getRulerGroup(client, folderUid, groupName);
  const orderBefore = group.rules.map(uidOf);
  const target = group.rules.find((dto) => uidOf(dto) === uid);
  if (!target)
    throw new Error(`Alert rule ${uid} is not in group ${folderUid}/${groupName} any more; re-run to review`);
  const groupVersion = Number(getObjectField(target, "grafana_alert")?.version);
  if (groupVersion !== expectVersion) {
    throw new Error(
      `Alert rule ${uid} changed after version ${expectVersion} was read (now ${groupVersion}); re-run to review`,
    );
  }
  const provisioned = group.rules.some((dto) => asString(getObjectField(dto, "grafana_alert")?.provenance));

  let path: RuleWriteResult["path"];
  if (!provisioned) {
    path = "ruler-group";
    const rules = group.rules.map((dto) => (uidOf(dto) === uid ? applyProvisioningToRuler(dto, spec) : dto));
    await client.request(
      "POST",
      `${RulerRules}/${encodeURIComponent(folderUid)}`,
      { ...group.body, rules },
      [202],
    );
  } else {
    path = "provisioning";
    const body = { ...spec, uid, folderUID: folderUid, ruleGroup: groupName };
    // Grafana answers 409 provenanceMismatch when the header does not match the stored provenance.
    const headers: Record<string, string> = latest.provenance ? {} : { "X-Disable-Provenance": "true" };
    await client.request(
      "PUT",
      `/api/v1/provisioning/alert-rules/${encodeURIComponent(uid)}`,
      body,
      [200],
      headers,
    );
  }
  const [rule, after] = await Promise.all([
    getCurrentAlertRule(client, uid),
    getRulerGroup(client, folderUid, groupName),
  ]);
  return { path, rule, orderBefore, orderAfter: after.rules.map(uidOf) };
}

export const orderChanged = (result: RuleWriteResult) =>
  result.orderBefore.join("\u0000") !== result.orderAfter.join("\u0000");
