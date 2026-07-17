import { type JsonObject, stripMeta } from "../core/json";
import { asObject, asObjectArray, asString, getObjectField } from "../lib/json-narrow";

export const DashboardResourceApiBase = "/apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards";
const DashboardResourceApiVersionPrefix = "dashboard.grafana.app/";

export type DashboardApiMode = "classic" | "v2";

export function isDashboardResourceV2(value: unknown): boolean {
  const obj = asObject(value);
  if (!obj) return false;
  return (
    asString(obj.apiVersion)?.startsWith(DashboardResourceApiVersionPrefix) === true &&
    asString(obj.kind) === "Dashboard" &&
    Boolean(getObjectField(obj, "spec"))
  );
}

export function dashboardResourceV2Name(value: JsonObject): string | undefined {
  return asString(getObjectField(value, "metadata")?.name) || asString(getObjectField(value, "spec")?.uid);
}

export function dashboardResourceV2Title(value: JsonObject): string | undefined {
  return asString(getObjectField(value, "spec")?.title) || dashboardResourceV2Name(value);
}

function dashboardResourceV2HasLayoutKind(value: JsonObject, layoutKind: string): boolean {
  const visit = (layout: unknown): boolean => {
    const obj = asObject(layout);
    if (!obj) return false;
    if (asString(obj.kind) === layoutKind) return true;
    const spec = getObjectField(obj, "spec");
    for (const tab of asObjectArray(spec?.tabs)) {
      if (visit(getObjectField(tab, "spec")?.layout)) return true;
    }
    for (const row of asObjectArray(spec?.rows)) {
      if (visit(getObjectField(row, "spec")?.layout)) return true;
    }
    return false;
  };
  return visit(getObjectField(value, "spec")?.layout);
}

export function dashboardResourceV2HasTabs(value: JsonObject): boolean {
  return dashboardResourceV2HasLayoutKind(value, "TabsLayout");
}

function sanitizeStringMap(input: unknown, omitted: Set<string>): JsonObject | undefined {
  const obj = asObject(input);
  if (!obj) return undefined;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(obj)) {
    if (omitted.has(key)) continue;
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function assertDashboardResourceV2Transformations(input: JsonObject): void {
  if (asString(input.apiVersion) !== "dashboard.grafana.app/v2beta1") return;
  const elements = getObjectField(getObjectField(input, "spec"), "elements") || {};
  for (const [elementName, elementValue] of Object.entries(elements)) {
    const element = asObject(elementValue);
    if (asString(element?.kind) !== "Panel") continue;
    const panelSpec = getObjectField(element, "spec");
    const queryGroup = getObjectField(getObjectField(panelSpec, "data"), "spec");
    const transformations = queryGroup?.transformations;
    if (transformations === undefined) continue;
    if (!Array.isArray(transformations)) {
      throw new Error(`Dashboard v2beta1 panel "${elementName}" transformations must be an array`);
    }
    for (const [index, transformationValue] of transformations.entries()) {
      const transformation = asObject(transformationValue);
      if (!transformation) {
        throw new Error(
          `Dashboard v2beta1 panel "${elementName}" transformation[${index}] must be an object`,
        );
      }
      const kind = asString(transformation.kind);
      const spec = getObjectField(transformation, "spec");
      const id = asString(spec?.id);
      if (!kind || !id || kind !== id) {
        throw new Error(
          `Dashboard v2beta1 panel "${elementName}" transformation[${index}] must use the same non-empty transformation ID in kind and spec.id; stable v2 kind="Transformation"/group is not valid for v2beta1`,
        );
      }
      if (!asObject(spec?.options)) {
        throw new Error(
          `Dashboard v2beta1 panel "${elementName}" transformation[${index}] spec.options must be an object`,
        );
      }
    }
  }
}

export function sanitizeDashboardResourceV2(input: JsonObject): JsonObject {
  assertDashboardResourceV2Transformations(input);
  const clean = asObject(stripMeta(input));
  if (!clean) throw new Error("Dashboard v2 resource must be a JSON object");
  const metadata = getObjectField(clean, "metadata") || {};
  const sanitizedMetadata: JsonObject = {};
  const name = asString(metadata.name) || asString(getObjectField(clean, "spec")?.uid);
  const annotations = sanitizeStringMap(
    metadata.annotations,
    new Set(["grafana.app/createdBy", "grafana.app/updatedBy", "grafana.app/updatedTimestamp"]),
  );
  const labels = sanitizeStringMap(metadata.labels, new Set(["grafana.app/deprecatedInternalID"]));
  if (name) sanitizedMetadata.name = name;
  if (annotations) sanitizedMetadata.annotations = annotations;
  if (labels) sanitizedMetadata.labels = labels;
  return {
    apiVersion: asString(clean.apiVersion) || "dashboard.grafana.app/v2beta1",
    kind: "Dashboard",
    metadata: sanitizedMetadata,
    spec: getObjectField(clean, "spec") || {},
  };
}

export function dashboardResourceV2Path(name: string): string {
  return `${DashboardResourceApiBase}/${encodeURIComponent(name)}`;
}
