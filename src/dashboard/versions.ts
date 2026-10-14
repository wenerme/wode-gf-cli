import type { GrafanaClient } from "../client";
import type { JsonObject } from "../core/json";
import { asObject, asObjectArray, asString, getObjectField } from "../lib/json-narrow";
import { isDashboardResourceV2 } from "./model";

/**
 * Dashboard version history over the two Grafana APIs.
 *
 * - Listing uses the classic `/api/dashboards/uid/:uid/versions`, which works for every storage mode.
 * - Content uses the format the dashboard is maintained in: classic JSON, or the v2beta1 resource whose history
 *   comes from `labelSelector=grafana.app/get-history=true` (version = metadata.generation).
 * - Never `POST /restore`: it has no client precondition and round-trips v2-stored dashboards through v1.
 */
export type DashboardApi = "classic" | "v2";
const ApiV2 = "/apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards";
const ApiV1 = "/apis/dashboard.grafana.app/v1/namespaces/default/dashboards";
const MaxPages = 50;

export type DashboardVersionRow = {
  version: number;
  created?: string;
  createdBy?: string;
  message?: string;
  /** Classic list responses embed the dashboard JSON; reused for --check-layout without extra calls. */
  data?: JsonObject;
};

export type DashboardSnapshot = {
  api: DashboardApi;
  uid: string;
  version: number;
  folderUid?: string;
  /** Classic: dashboard JSON. v2: full v2beta1 resource. */
  document: JsonObject;
  /** Classic numeric id, v2 resourceVersion: what a precondition write needs. */
  id?: number;
  resourceVersion?: string;
};

async function getJson(client: GrafanaClient, path: string): Promise<{ status: number; data?: JsonObject }> {
  const response = await client.requestWithStatus<unknown>("GET", path);
  return { status: response.status, data: asObject(response.data) };
}

function fail(status: number, path: string, data: unknown): never {
  throw new Error(`${status} GET ${path}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
}

/** Accepts a uid or an exact (unique) title. */
export async function resolveDashboardUid(client: GrafanaClient, token: string): Promise<string> {
  const direct = await client.requestWithStatus<unknown>(
    "GET",
    `/api/dashboards/uid/${encodeURIComponent(token)}`,
  );
  if (direct.status === 200) return token;
  if (direct.status !== 404) fail(direct.status, `/api/dashboards/uid/${token}`, direct.data);
  const hits = asObjectArray(
    await client.request<unknown>(
      "GET",
      `/api/search?type=dash-db&limit=5000&query=${encodeURIComponent(token)}`,
    ),
  ).filter((hit) => asString(hit.title) === token);
  if (hits.length === 1) return asString(hits[0]?.uid) as string;
  if (hits.length > 1) throw new Error(`Dashboard title "${token}" is ambiguous; use the uid`);
  throw new Error(`Dashboard not found: ${token}`);
}

/**
 * Storage format: v2 when the v2beta1 view is native (no conversion or stored v2*), otherwise classic.
 * Only 404 (dashboard or v2 API absent, i.e. older Grafana) means classic; any other failure is an error, because
 * guessing classic for a v2 dashboard gives a lossy view and, on restore, a lossy write.
 */
export async function detectDashboardApi(client: GrafanaClient, uid: string): Promise<DashboardApi> {
  const path = `${ApiV2}/${encodeURIComponent(uid)}`;
  const response = await getJson(client, path);
  if (response.status === 404) return "classic";
  if (response.status !== 200 || !response.data) {
    throw new Error(
      `Cannot detect storage format of ${uid} (${response.status} GET ${path}); pass --dashboard-api classic|v2`,
    );
  }
  const conversion = getObjectField(getObjectField(response.data, "status"), "conversion");
  if (!conversion) return "v2";
  return asString(conversion.storedVersion)?.startsWith("v2") ? "v2" : "classic";
}

const grafanaMessage = (data: unknown) =>
  asString(asObject(data)?.message) || (typeof data === "string" ? data : JSON.stringify(data));

export async function listDashboardVersions(
  client: GrafanaClient,
  uid: string,
  limit: number,
): Promise<DashboardVersionRow[]> {
  const rows: DashboardVersionRow[] = [];
  let token = "";
  for (let page = 0; page < MaxPages && rows.length < limit; page += 1) {
    const path = `/api/dashboards/uid/${encodeURIComponent(uid)}/versions?limit=${Math.min(100, limit - rows.length)}${
      token ? `&continueToken=${encodeURIComponent(token)}` : ""
    }`;
    const response = await client.requestWithStatus<unknown>("GET", path);
    // A "Restored from version <non-number>" message anywhere in history makes this endpoint 404 for good.
    if (response.status === 404 && page === 0) return listFromK8sHistory(client, uid, limit);
    if (response.status !== 200) fail(response.status, path, response.data);
    const body = response.data;
    // Older Grafana returned a bare array without paging.
    const items = Array.isArray(body) ? asObjectArray(body) : asObjectArray(asObject(body)?.versions);
    for (const item of items) {
      rows.push({
        version: Number(item.version),
        created: asString(item.created),
        createdBy: asString(item.createdBy),
        message: asString(item.message) || undefined,
        data: asObject(item.data),
      });
    }
    token = Array.isArray(body) ? "" : asString(asObject(body)?.continueToken) || "";
    if (!token || items.length === 0) break;
  }
  return rows.slice(0, limit);
}

/** Same rows from the v1 k8s history (metadata and classic-shaped spec). */
async function listFromK8sHistory(
  client: GrafanaClient,
  uid: string,
  limit: number,
): Promise<DashboardVersionRow[]> {
  const rows: DashboardVersionRow[] = [];
  for await (const item of k8sHistory(client, uid, ApiV1)) {
    const metadata = getObjectField(item, "metadata") || {};
    const annotations = getObjectField(metadata, "annotations") || {};
    const failed = getObjectField(getObjectField(item, "status"), "conversion")?.failed;
    rows.push({
      version: Number(metadata.generation),
      created: asString(annotations["grafana.app/updatedTimestamp"]) || asString(metadata.creationTimestamp),
      createdBy:
        asString(annotations["grafana.app/updatedBy"]) || asString(annotations["grafana.app/createdBy"]),
      message: asString(annotations["grafana.app/message"]) || undefined,
      data: failed ? undefined : getObjectField(item, "spec"),
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

export async function getCurrentDashboard(
  client: GrafanaClient,
  uid: string,
  api: DashboardApi,
): Promise<DashboardSnapshot> {
  if (api === "v2") {
    const path = `${ApiV2}/${encodeURIComponent(uid)}`;
    const response = await getJson(client, path);
    if (response.status !== 200 || !response.data) fail(response.status, path, response.data);
    return v2Snapshot(uid, response.data, true);
  }
  const path = `/api/dashboards/uid/${encodeURIComponent(uid)}`;
  const response = await getJson(client, path);
  const dashboard = getObjectField(response.data, "dashboard");
  if (response.status !== 200 || !dashboard) fail(response.status, path, response.data);
  const meta = getObjectField(response.data, "meta");
  return {
    api,
    uid,
    version: Number(dashboard.version ?? meta?.version),
    folderUid: asString(meta?.folderUid) || undefined,
    document: dashboard,
    id: typeof dashboard.id === "number" ? dashboard.id : undefined,
  };
}

function v2Snapshot(uid: string, resource: JsonObject, current: boolean): DashboardSnapshot {
  const metadata = getObjectField(resource, "metadata") || {};
  const conversion = getObjectField(getObjectField(resource, "status"), "conversion");
  if (conversion?.failed) {
    throw new Error(
      `Dashboard ${uid} generation ${metadata.generation} cannot be read as v2 (${asString(conversion.error) || "conversion failed"}); use --dashboard-api classic`,
    );
  }
  return {
    api: "v2",
    uid,
    version: Number(metadata.generation),
    folderUid: asString(getObjectField(metadata, "annotations")?.["grafana.app/folder"]) || undefined,
    document: resource,
    resourceVersion: current ? asString(metadata.resourceVersion) : undefined,
  };
}

export async function getDashboardVersion(
  client: GrafanaClient,
  uid: string,
  version: number,
  api: DashboardApi,
): Promise<DashboardSnapshot> {
  if (api === "classic") {
    const path = `/api/dashboards/uid/${encodeURIComponent(uid)}/versions/${version}`;
    const response = await getJson(client, path);
    const data = getObjectField(response.data, "data");
    if (response.status === 200 && data)
      return { api, uid, version: Number(response.data?.version ?? version), document: data };
    // The legacy endpoint fails for versions whose message it cannot parse; the v1 history still has them.
    for await (const item of k8sHistory(client, uid, ApiV1)) {
      const spec = getObjectField(item, "spec");
      if (Number(getObjectField(item, "metadata")?.generation) === version && spec)
        return { api, uid, version, document: spec };
    }
    fail(response.status, path, response.data);
  }
  for await (const item of k8sHistory(client, uid)) {
    if (Number(getObjectField(item, "metadata")?.generation) === version) return v2Snapshot(uid, item, false);
  }
  throw new Error(`Dashboard ${uid} has no version ${version}`);
}

async function* k8sHistory(client: GrafanaClient, uid: string, base = ApiV2): AsyncGenerator<JsonObject> {
  let token = "";
  for (let page = 0; page < MaxPages; page += 1) {
    const path = `${base}?labelSelector=${encodeURIComponent("grafana.app/get-history=true")}&fieldSelector=${encodeURIComponent(
      `metadata.name=${uid}`,
    )}&limit=100${token ? `&continue=${encodeURIComponent(token)}` : ""}`;
    const response = await getJson(client, path);
    if (response.status !== 200 || !response.data) fail(response.status, path, response.data);
    for (const item of asObjectArray(response.data.items)) yield item;
    token = asString(getObjectField(response.data, "metadata")?.continue) || "";
    if (!token) return;
  }
}

/** Native v2 history (newest first), for layout checks that the lossy classic view cannot answer. */
export async function listDashboardSnapshotsV2(client: GrafanaClient, uid: string, limit: number) {
  const out: DashboardSnapshot[] = [];
  for await (const item of k8sHistory(client, uid)) {
    out.push(v2Snapshot(uid, item, false));
    if (out.length >= limit) break;
  }
  return out;
}

/** What a version "is", without bookkeeping that every save changes. */
export function comparableDashboard(snapshot: Pick<DashboardSnapshot, "api" | "document">): JsonObject {
  if (snapshot.api === "v2") return getObjectField(snapshot.document, "spec") || {};
  const { id: _id, version: _version, iteration: _iteration, ...rest } = snapshot.document;
  return rest;
}

/** Local file -> comparable document. Accepts export items, raw dashboards, v2 resources, and bundles. */
export function comparableFromLocal(
  value: unknown,
  uid: string,
): { api: DashboardApi; document: JsonObject } {
  const items = Array.isArray(value) ? value : [value];
  for (const raw of items) {
    const item = asObject(raw);
    if (!item) continue;
    if (isDashboardResourceV2(item)) {
      if (asString(getObjectField(item, "metadata")?.name) !== uid && items.length > 1) continue;
      return { api: "v2", document: comparableDashboard({ api: "v2", document: item }) };
    }
    const dashboard = getObjectField(item, "dashboard");
    if (dashboard && isDashboardResourceV2(dashboard)) return comparableFromLocal(dashboard, uid);
    const body = dashboard || item;
    if (items.length > 1 && asString(body.uid) !== uid) continue;
    if (Array.isArray(body.panels) || typeof body.title === "string") {
      return { api: "classic", document: comparableDashboard({ api: "classic", document: body }) };
    }
  }
  throw new Error(`No dashboard ${uid} found in local file`);
}

/**
 * Precondition write of `target` over `current`. Classic: overwrite:false + current id/version (stale -> 409).
 * v2: PUT with current resourceVersion (stale -> 409). Returns the version Grafana reports.
 */
export async function writeDashboardVersion(
  client: GrafanaClient,
  current: DashboardSnapshot,
  target: DashboardSnapshot,
  message: string,
): Promise<number> {
  if (current.api !== target.api) throw new Error("current and target must use the same dashboard API");
  if (current.api === "classic") {
    const response = await client.requestWithStatus<unknown>("POST", "/api/dashboards/db", {
      dashboard: { ...target.document, id: current.id, uid: current.uid, version: current.version },
      folderUid: current.folderUid,
      overwrite: false,
      message,
    });
    if (response.status === 409 || response.status === 412) {
      throw new Error(
        `Dashboard ${current.uid} was not written: ${response.status} ${grafanaMessage(response.data)} (usually a save after version ${current.version} was read; re-run to review the new state)`,
      );
    }
    if (response.status !== 200)
      throw new Error(`${response.status} POST /api/dashboards/db: ${JSON.stringify(response.data)}`);
    return Number(asObject(response.data)?.version);
  }
  const metadata = getObjectField(current.document, "metadata") || {};
  const annotations = { ...(getObjectField(metadata, "annotations") || {}), "grafana.app/message": message };
  const { status: _status, ...base } = current.document;
  const body = {
    ...base,
    metadata: { ...metadata, annotations, resourceVersion: current.resourceVersion },
    spec: getObjectField(target.document, "spec"),
  };
  const path = `${ApiV2}/${encodeURIComponent(current.uid)}`;
  const response = await client.requestWithStatus<unknown>("PUT", path, body);
  if (response.status === 409) {
    throw new Error(
      `Dashboard ${current.uid} was not written: 409 ${grafanaMessage(response.data)} (usually a save after generation ${current.version} was read; re-run to review the new state)`,
    );
  }
  if (response.status !== 200)
    throw new Error(`${response.status} PUT ${path}: ${JSON.stringify(response.data)}`);
  return Number(getObjectField(asObject(response.data), "metadata")?.generation);
}
