import type { PromQLExpression } from "./ast";
import { prepareGrafanaPromQLExpression } from "./grafana-template-normalize";
import type { GrafanaPromQLPreflightOptions, GrafanaPromQLPreflightResult } from "./grafana-types";
import { parsePromQL, validatePromQLSyntax } from "./index";

export { prepareGrafanaPromQLExpression } from "./grafana-template-normalize";
export { scanGrafanaPromQLTemplates } from "./grafana-template-scanner";
export type {
  GrafanaPromQLMacroMode,
  GrafanaPromQLPreflightOptions,
  GrafanaPromQLPreflightResult,
  GrafanaPromQLTemplateToken,
  GrafanaPromQLTemplateTokenKind,
} from "./grafana-types";
export {
  GrafanaPromQLMacroError,
  GrafanaPromQLMacroModes,
  parseGrafanaPromQLMacroMode,
} from "./grafana-types";

export function parseGrafanaPromQL(
  expression: string,
  options: GrafanaPromQLPreflightOptions = {},
): PromQLExpression {
  const preflight = prepareGrafanaPromQLExpression(expression, options);
  return parsePromQL(preflight.normalizedExpression);
}

export function validateGrafanaPromQLSyntax(
  expression: string,
  options: GrafanaPromQLPreflightOptions = {},
): GrafanaPromQLPreflightResult {
  const preflight = prepareGrafanaPromQLExpression(expression, options);
  validatePromQLSyntax(preflight.normalizedExpression);
  return preflight;
}

export function normalizeGrafanaPromQLTemplates(
  expression: string,
  options: GrafanaPromQLPreflightOptions = {},
): GrafanaPromQLPreflightResult {
  return prepareGrafanaPromQLExpression(expression, options);
}
