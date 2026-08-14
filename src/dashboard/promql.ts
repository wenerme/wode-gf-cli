import type { JsonObject } from "../core/json";
import { sourceFileOf } from "../core/source-file";
import { calcClsIntervalSpec } from "../lib/cls-interval";
import { asObject, asString, getObjectField } from "../lib/json-narrow";
import { extractTemplatingValues, resolveTemplateValue, type TemplateVars } from "../lib/template-vars";
import { PromQLParseError } from "../promql";
import {
  GrafanaPromQLMacroError,
  type GrafanaPromQLMacroMode,
  validateGrafanaPromQLSyntax,
} from "../promql/grafana";
import { collectDashboardPanelContexts, extractPanelTargets, normalizeDashboardInput } from "./normalize";
import type { DashboardTarget, ValidateIssue } from "./types";

function promQLSyntaxIssue(
  dashboardTitle: string,
  panel: JsonObject,
  target: DashboardTarget,
  message: string,
  datasourceUid?: string,
  datasourceType?: string,
  sourceFile?: string,
): ValidateIssue {
  return {
    sourceFile,
    dashboardTitle,
    panelTitle: asString(panel.title) || "(untitled panel)",
    panelId: Number.parseInt(String(panel.id || "0"), 10) || 0,
    refId: target.refId,
    datasourceUid,
    datasourceType,
    kind: "promql-syntax",
    message,
  };
}

export function validatePanelTargetPromQLSyntax(
  dashboardTitle: string,
  panel: JsonObject,
  target: DashboardTarget,
  options: {
    macroMode?: GrafanaPromQLMacroMode;
    vars?: TemplateVars;
    fromMs?: number;
    toMs?: number;
    interval?: string;
    intervalMs?: number;
    rateInterval?: string;
    rangeMs?: number;
    datasourceUid?: string;
    datasourceType?: string;
    sourceFile?: string;
    onWarning?: (message: string) => void;
  } = {},
): ValidateIssue | undefined {
  const expr = asString(target.raw.expr);
  if (!expr) return undefined;
  try {
    const result = validateGrafanaPromQLSyntax(expr, {
      macroMode: options.macroMode,
      vars: options.vars,
      fromMs: options.fromMs,
      toMs: options.toMs,
      interval: options.interval,
      intervalMs: options.intervalMs,
      rateInterval: options.rateInterval,
      rangeMs: options.rangeMs,
    });
    for (const warning of result.warnings) options.onWarning?.(warning);
    return undefined;
  } catch (error) {
    const message =
      error instanceof PromQLParseError || error instanceof GrafanaPromQLMacroError
        ? error.message
        : String(error);
    return promQLSyntaxIssue(
      dashboardTitle,
      panel,
      target,
      message,
      options.datasourceUid,
      options.datasourceType,
      options.sourceFile,
    );
  }
}

export function validateDashboardPromQLSyntax(
  dashboards: JsonObject[],
  options: {
    macroMode?: GrafanaPromQLMacroMode;
    vars?: TemplateVars;
    fromMs?: number;
    toMs?: number;
    intervalMs?: number;
  } = {},
): ValidateIssue[] {
  const errors: ValidateIssue[] = [];
  const rangeMs =
    options.fromMs !== undefined && options.toMs !== undefined
      ? Math.max(0, options.toMs - options.fromMs)
      : undefined;
  const intervalMs = options.intervalMs ?? 60_000;
  for (const dashboardEntry of dashboards) {
    const normalized = normalizeDashboardInput(dashboardEntry);
    if (!normalized) {
      errors.push({
        sourceFile: sourceFileOf(dashboardEntry),
        dashboardTitle: "(unknown dashboard)",
        panelTitle: "(unknown panel)",
        panelId: 0,
        refId: "-",
        kind: "query-error",
        message: "Unsupported dashboard JSON format",
      });
      continue;
    }
    const rootVars = extractTemplatingValues(normalized.dashboard);
    for (const context of collectDashboardPanelContexts(dashboardEntry)) {
      const vars = {
        ...rootVars,
        ...extractTemplatingValues({ variables: context.variables }),
        ...(options.vars || {}),
      };
      for (const target of extractPanelTargets(context.panel)) {
        const issue = validatePanelTargetPromQLSyntax(normalized.title, context.panel, target, {
          macroMode: options.macroMode,
          vars,
          fromMs: options.fromMs,
          toMs: options.toMs,
          intervalMs,
          rangeMs,
          datasourceType: "prometheus",
          sourceFile: normalized.sourceFile,
        });
        if (issue) errors.push(issue);
      }
    }
  }
  return errors;
}

export function buildValidateQueryBody(
  target: DashboardTarget,
  options: {
    datasourceUid: string;
    vars: TemplateVars;
    fromMs: number;
    toMs: number;
    intervalMs: number;
  },
): JsonObject | undefined {
  const rawSql = asString(target.raw.rawSql) || asString(target.raw.rawQuery);
  const expr = asString(target.raw.expr);
  const logServiceParams = getObjectField(target.raw, "logServiceParams");
  const logServiceQuery = asString(logServiceParams?.Query);
  if (!rawSql && !expr && !logServiceQuery) return undefined;

  const maxDataPoints = Number.parseInt(String(target.raw.maxDataPoints || "1000"), 10) || 1000;
  const clsInterval = calcClsIntervalSpec(options.fromMs, options.toMs, maxDataPoints);
  const queryVars = {
    ...options.vars,
    ...(logServiceQuery
      ? {
          __interval: clsInterval.sql,
          __interval_ms: String(clsInterval.milliseconds),
        }
      : {}),
    __cls_interval: clsInterval.sql,
    __cls_interval_ms: String(clsInterval.milliseconds),
  };
  const targetDatasource = asObject(target.raw.datasource) || {};
  const queryTemplate: JsonObject = logServiceQuery
    ? {
        ...target.raw,
        refId: target.refId,
        datasource: { ...targetDatasource, uid: options.datasourceUid },
        intervalMs: options.intervalMs,
        maxDataPoints,
      }
    : {
        refId: target.refId,
        datasource: { uid: options.datasourceUid },
        rawSql,
        rawQuery: rawSql,
        expr,
        format: asString(target.raw.format) || "table",
        intervalMs: options.intervalMs,
        maxDataPoints,
      };
  return resolveTemplateValue(queryTemplate, queryVars) as JsonObject;
}

export function matchesValidationTarget(
  panelId: number,
  refId: string,
  onlyPanelIds: ReadonlySet<number>,
  skipPanelIds: ReadonlySet<number>,
  onlyRefIds: ReadonlySet<string>,
): boolean {
  if (onlyPanelIds.size > 0 && !onlyPanelIds.has(panelId)) return false;
  if (skipPanelIds.has(panelId)) return false;
  if (onlyRefIds.size > 0 && !onlyRefIds.has(refId)) return false;
  return true;
}
