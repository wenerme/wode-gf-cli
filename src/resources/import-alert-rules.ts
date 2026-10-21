import type { GrafanaClient } from "../client";
import { type JsonObject, stripMeta } from "../core/json";
import { diffJson } from "../core/json-diff";
import { comparableAlertRule, rulerToProvisioning } from "../lib/alert-rule-versions";
import { applyProvisioningToRuler } from "../lib/alert-rule-write";
import { asObject, asString, getObjectField } from "../lib/json-narrow";

/**
 * Alert rule import that keeps groups intact.
 *
 * Grafana's single-rule provisioning writes drop the group index: a PUT moves the rule inside its group and a
 * POST inserts at an arbitrary position. So rules are planned per (folder, group) against one ruler read:
 * - unchanged rules are not written;
 * - a group that exists and contains no provisioned rule (nor do the groups rules move out of) is written once
 *   through the ruler API, like the Grafana UI: remote order is kept, new rules are appended in file order;
 * - other groups (new groups, groups with provisioned rules, rules without uid) use provisioning PUT/POST, with
 *   `X-Disable-Provenance` matching the stored provenance; PUT falls back to POST only on 404.
 * File-provisioned rules are refused. Failures are collected per rule; the rest of the import continues.
 *
 * A ruler group write replaces the group as read right before it: within that one round-trip, a concurrent edit
 * of a sibling is overwritten and a rule added to the group concurrently is deleted (same as the Grafana UI).
 * Moves are safe in either write order: Grafana resolves a moved uid across groups and renumbers the source.
 */
export type RuleImportAction = "create" | "update" | "unchanged" | "failed";
export type RuleImportItem = {
  key: string;
  title?: string;
  group: string;
  action: RuleImportAction;
  via?: "ruler-group" | "provisioning";
  moved?: boolean;
  error?: string;
};
export type RuleImportReport = { items: RuleImportItem[]; reordered: string[] };

const Ruler = "/api/ruler/grafana/api/v1/rules";
const Provisioning = "/api/v1/provisioning/alert-rules";

type Remote = { dto: JsonObject; folderUid: string; group: string; provenance: string; rule: JsonObject };
type Planned = RuleImportItem & { rule: JsonObject; remote?: Remote; folderUid: string };

const groupKey = (folderUid: string, group: string) => `${folderUid}/${group}`;
const errorText = (error: unknown) => (error as Error).message.replace(/\s+/g, " ").slice(0, 300);

async function readRuler(client: GrafanaClient) {
  const body = asObject(await client.request<unknown>("GET", Ruler, undefined, [200, 202])) || {};
  const byUid = new Map<string, Remote>();
  const groups = new Map<string, { body: JsonObject; uids: string[]; provisioned: boolean }>();
  for (const namespace of Object.values(body)) {
    for (const group of Array.isArray(namespace) ? namespace : []) {
      const rules = Array.isArray(asObject(group)?.rules) ? (asObject(group)?.rules as JsonObject[]) : [];
      const first = getObjectField(rules[0] || {}, "grafana_alert");
      const folderUid = asString(first?.namespace_uid) || "";
      const name = asString(asObject(group)?.name) || "";
      const uids: string[] = [];
      let provisioned = false;
      for (const dto of rules) {
        const ga = getObjectField(dto, "grafana_alert") || {};
        const uid = asString(ga.uid) || "";
        const provenance = asString(ga.provenance) || "";
        provisioned ||= provenance !== "";
        uids.push(uid);
        byUid.set(uid, { dto, folderUid, group: name, provenance, rule: rulerToProvisioning(dto) });
      }
      groups.set(groupKey(folderUid, name), { body: asObject(group) || {}, uids, provisioned });
    }
  }
  return { byUid, groups };
}

function plan(rules: JsonObject[], remote: Awaited<ReturnType<typeof readRuler>>): Planned[] {
  const seen = new Set<string>();
  return rules.map((raw) => {
    const rule = asObject(stripMeta(raw)) || {};
    const uid = asString(rule.uid);
    const folderUid = asString(rule.folderUID) || "";
    const group = asString(rule.ruleGroup) || "";
    const base = {
      key: uid || asString(rule.title) || "(unknown)",
      title: asString(rule.title),
      group: groupKey(folderUid, group),
      rule,
      folderUid,
    };
    if (uid && seen.has(uid)) return { ...base, action: "failed" as const, error: "duplicate uid in import" };
    if (uid) seen.add(uid);
    const existing = uid ? remote.byUid.get(uid) : undefined;
    if (!existing) return { ...base, action: "create" as const };
    if (existing.provenance && existing.provenance !== "api") {
      return {
        ...base,
        remote: existing,
        action: "failed" as const,
        error: `provisioned from ${existing.provenance}; change it at the source`,
      };
    }
    const moved = existing.folderUid !== folderUid || existing.group !== group;
    // Structural compare: key order differs between Grafana responses and files.
    const same = diffJson(comparableAlertRule(existing.rule), comparableAlertRule(rule)).length === 0;
    return {
      ...base,
      remote: existing,
      moved,
      action: same && !moved ? ("unchanged" as const) : ("update" as const),
    };
  });
}

/** True when a group can be written through the ruler API without Grafana refusing or reordering. */
function rulerEligible(items: Planned[], remote: Awaited<ReturnType<typeof readRuler>>, key: string) {
  const group = remote.groups.get(key);
  if (!group || group.provisioned) return false;
  if (items.some((item) => !asString(item.rule.uid))) return false;
  return items.every(
    (item) =>
      !item.moved ||
      !remote.groups.get(groupKey(item.remote?.folderUid || "", item.remote?.group || ""))?.provisioned,
  );
}

async function writeRulerGroup(client: GrafanaClient, items: Planned[], folderUid: string, name: string) {
  // Fresh read right before the write: earlier writes in this import (moves) may have changed the group.
  const path = `${Ruler}/${encodeURIComponent(folderUid)}/${encodeURIComponent(name)}`;
  const current = asObject(await client.request<unknown>("GET", path, undefined, [200, 202])) || {};
  const changes = new Map(items.map((item) => [asString(item.rule.uid) as string, item]));
  const existing = (Array.isArray(current.rules) ? (current.rules as JsonObject[]) : []).map((dto) => {
    const uid = asString(getObjectField(dto, "grafana_alert")?.uid) || "";
    const item = changes.get(uid);
    if (!item) return dto;
    changes.delete(uid);
    return applyProvisioningToRuler(dto, item.rule);
  });
  // Remaining: new rules and rules moving in, appended in file order.
  const added = [...changes.values()].map((item) =>
    applyProvisioningToRuler(item.remote?.dto || {}, item.rule),
  );
  await client.request(
    "POST",
    `${Ruler}/${encodeURIComponent(folderUid)}`,
    { ...current, name, rules: [...existing, ...added] },
    [202],
  );
}

async function writeProvisioning(client: GrafanaClient, item: Planned) {
  const uid = asString(item.rule.uid);
  // Keep stored provenance: rules without it need the header, `api` rules must not send it (409 otherwise).
  const headers: Record<string, string> = item.remote?.provenance ? {} : { "X-Disable-Provenance": "true" };
  if (item.action === "update" && uid) {
    const path = `${Provisioning}/${encodeURIComponent(uid)}`;
    const put = await client.requestWithStatus<unknown>("PUT", path, item.rule, headers);
    if (put.status === 200) return;
    // Only a vanished rule falls through to create; anything else (409 provenance, 400 validation) is the answer.
    if (put.status !== 404) throw new Error(`${put.status} PUT ${path}: ${JSON.stringify(put.data)}`);
  }
  // New rules are created without provenance so they stay editable in the UI (as before).
  await client.request("POST", Provisioning, item.rule, [201], { "X-Disable-Provenance": "true" });
}

export async function importAlertRules(
  client: GrafanaClient,
  rules: JsonObject[],
  options: { dryRun: boolean },
): Promise<RuleImportReport> {
  const remote = await readRuler(client);
  const planned = plan(rules, remote);
  const byGroup = new Map<string, Planned[]>();
  for (const item of planned) {
    if (item.action !== "create" && item.action !== "update") continue;
    byGroup.set(item.group, [...(byGroup.get(item.group) || []), item]);
  }
  const touched = new Set<string>();
  for (const [key, items] of byGroup) {
    const via = rulerEligible(items, remote, key) ? "ruler-group" : "provisioning";
    for (const item of items) {
      item.via = via;
      touched.add(key);
      if (item.moved && item.remote) touched.add(groupKey(item.remote.folderUid, item.remote.group));
    }
    if (options.dryRun) continue;
    if (via === "ruler-group") {
      const name = asString(items[0]?.rule.ruleGroup) || "";
      try {
        await writeRulerGroup(client, items, items[0]?.folderUid || "", name);
      } catch (error) {
        for (const item of items) Object.assign(item, { action: "failed", error: errorText(error) });
      }
      continue;
    }
    for (const item of items) {
      try {
        await writeProvisioning(client, item);
      } catch (error) {
        Object.assign(item, { action: "failed", error: errorText(error) });
      }
    }
  }
  const reordered: string[] = [];
  if (!options.dryRun && touched.size > 0) {
    const after = await readRuler(client);
    for (const key of touched) {
      // Existing groups: their previous order; new groups: the file order of the imported rules.
      const before =
        remote.groups.get(key)?.uids ||
        planned.filter((item) => item.group === key).map((item) => asString(item.rule.uid) || "");
      const now = after.groups.get(key)?.uids || [];
      const kept = now.filter((uid) => before.includes(uid));
      if (kept.join("\u0000") !== before.filter((uid) => now.includes(uid)).join("\u0000"))
        reordered.push(key);
    }
  }
  return {
    items: planned.map(({ rule: _rule, remote: _remote, folderUid: _folder, ...item }) => item),
    reordered,
  };
}
