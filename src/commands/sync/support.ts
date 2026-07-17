import type { GrafanaClient } from "../../client";
import type { ExportBundle, ResourceName } from "../../schema";

const SyncResourceOrder = [
  "folders",
  "dashboards",
  "datasources",
  "alert-rules",
  "contact-points",
  "policies",
] as const satisfies readonly ResourceName[];

export function syncBundleResources(
  bundle: ExportBundle,
  resourceItems: (bundle: ExportBundle, resource: ResourceName) => unknown[],
): ResourceName[] {
  return SyncResourceOrder.filter((resource) => resourceItems(bundle, resource).length > 0);
}

export function parseDashboardApiMode(value: unknown, fallback: "classic" | "auto") {
  const mode = String(value || fallback)
    .trim()
    .toLowerCase();
  if (mode === "classic" || mode === "v2" || mode === "auto") return mode;
  throw new Error(`Unsupported --dashboard-api: ${String(value)}`);
}

function dashboardV2NameFromItem(item: unknown): string | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const object = item as Record<string, unknown>;
  const metadata =
    object.metadata && typeof object.metadata === "object"
      ? (object.metadata as Record<string, unknown>)
      : undefined;
  const spec =
    object.spec && typeof object.spec === "object" ? (object.spec as Record<string, unknown>) : undefined;
  const value = metadata?.name || spec?.uid || object.uid;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function fetchDashboardV2LocalSubset(
  client: GrafanaClient,
  localItems: unknown[],
  createEmptyBundle: () => ExportBundle,
): Promise<ExportBundle> {
  const bundle = createEmptyBundle();
  bundle.resources = ["dashboards"];
  bundle.dashboards = [];
  for (const item of localItems) {
    const name = dashboardV2NameFromItem(item);
    if (!name) continue;
    const apiPath = `/apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/${encodeURIComponent(name)}`;
    const response = await client.requestWithStatus<unknown>("GET", apiPath);
    if (response.status === 404) continue;
    if (response.status < 200 || response.status >= 300) {
      const message = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
      throw new Error(`${response.status} GET ${apiPath}: ${message}`);
    }
    if (response.data && typeof response.data === "object" && !Array.isArray(response.data)) {
      bundle.dashboards.push({ ...(response.data as Record<string, unknown>), __type: "dashboard-v2" });
    }
  }
  return bundle;
}
