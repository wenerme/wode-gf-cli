import { GrafanaClient, mapLimit } from "../client";
import type { RuntimeContext } from "../config/context";
import type { JsonObject } from "../core/json";
import { sourceFileOf } from "../core/source-file";
import { asObject, asObjectArray, asString, getObjectField } from "../lib/json-narrow";
import {
  buildGrafanaMacros,
  extractTemplatingValues,
  findUnresolvedTemplateTokens,
  resolveDatasourceUid,
} from "../lib/template-vars";
import { renderFramesText } from "../output/render";
import type { GrafanaPromQLMacroMode } from "../promql/grafana";
import { msToInterval, resolveTimeToMs } from "../utils";
import {
  assertDashboardResourceV2Transformations,
  dashboardResourceV2Title,
  isDashboardResourceV2,
} from "./model";
import { collectDashboardPanels, extractPanelTargets, normalizeDashboardInput } from "./normalize";
import { buildValidateQueryBody, matchesValidationTarget, validatePanelTargetPromQLSyntax } from "./promql";
import type { DashboardTarget, ValidateIssue } from "./types";

function isPrometheusDatasourceType(value: string | undefined): boolean {
  return String(value || "").toLowerCase() === "prometheus";
}

export async function validateDashboards(
  ctx: RuntimeContext,
  dashboards: JsonObject[],
  options: {
    from: string;
    to: string;
    timeoutMs: number;
    intervalMs: number;
    concurrency: number;
    failFast: boolean;
    syntaxOnly?: boolean;
    skipPanelIds: number[];
    onlyPanelIds?: number[];
    onlyRefIds?: string[];
    datasourceTypes?: string[];
    skipTypes?: string[];
    vars: Record<string, string>;
    promqlMacroMode?: GrafanaPromQLMacroMode;
  },
): Promise<{ errors: ValidateIssue[]; warnings: ValidateIssue[] }> {
  const warnings: ValidateIssue[] = [];
  const errors: ValidateIssue[] = [];
  const client = new GrafanaClient({ ...ctx, timeoutMs: options.timeoutMs });
  const skipSet = new Set(options.skipPanelIds);
  const onlySet = new Set(options.onlyPanelIds || []);
  const onlyRefSet = new Set(options.onlyRefIds || []);
  const onlyDatasourceTypes = new Set(options.datasourceTypes || []);
  const skipDatasourceTypes = new Set(options.skipTypes || []);
  const nowMs = Date.now();
  const fromMs = resolveTimeToMs(options.from, nowMs);
  const toMs = resolveTimeToMs(options.to, nowMs);
  const rangeMs = Math.max(0, toMs - fromMs);
  const datasourceTypeByUid = new Map<string, string>();
  if (onlyDatasourceTypes.size > 0 || skipDatasourceTypes.size > 0) {
    for (const datasource of asObjectArray(await client.request<unknown[]>("GET", "/api/datasources"))) {
      const uid = asString(datasource.uid);
      const type = asString(datasource.type);
      if (uid && type) datasourceTypeByUid.set(uid, type);
    }
  }

  for (const dashboardEntry of dashboards) {
    if (isDashboardResourceV2(dashboardEntry)) {
      try {
        assertDashboardResourceV2Transformations(dashboardEntry);
      } catch (error) {
        errors.push({
          sourceFile: sourceFileOf(dashboardEntry),
          dashboardTitle: dashboardResourceV2Title(dashboardEntry) || "(untitled dashboard)",
          panelTitle: "(dashboard v2 schema)",
          panelId: 0,
          refId: "-",
          kind: "query-error",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
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
    const dashboardTitle = normalized.title;
    const dashboardVars = {
      ...extractTemplatingValues(normalized.dashboard),
      ...buildGrafanaMacros({ from: fromMs, to: toMs, intervalMs: options.intervalMs }),
      ...options.vars,
    };

    const tasks: Array<{ panel: JsonObject; target: DashboardTarget }> = [];
    for (const panel of collectDashboardPanels(dashboardEntry)) {
      for (const target of extractPanelTargets(panel)) tasks.push({ panel, target });
    }

    await mapLimit(tasks, options.concurrency, async ({ panel, target }) => {
      const panelId = Number.parseInt(String(panel.id || "0"), 10) || 0;
      if (!matchesValidationTarget(panelId, target.refId, onlySet, skipSet, onlyRefSet)) return;

      const panelDatasource = getObjectField(panel, "datasource");
      const targetDatasource = getObjectField(target.raw, "datasource");
      const datasourceUid = resolveDatasourceUid(
        asString(panelDatasource?.uid),
        asString(targetDatasource?.uid),
        dashboardVars,
      );
      const targetDatasourceType = asString(targetDatasource?.type) || asString(panelDatasource?.type);
      const datasourceType = datasourceUid
        ? datasourceTypeByUid.get(datasourceUid) || targetDatasourceType
        : targetDatasourceType;
      if (datasourceType && onlyDatasourceTypes.size > 0 && !onlyDatasourceTypes.has(datasourceType)) return;
      if (datasourceType && skipDatasourceTypes.has(datasourceType)) return;

      if (isPrometheusDatasourceType(datasourceType)) {
        const syntaxIssue = validatePanelTargetPromQLSyntax(dashboardTitle, panel, target, {
          macroMode: options.promqlMacroMode,
          vars: dashboardVars,
          fromMs,
          toMs,
          intervalMs: options.intervalMs,
          rangeMs,
          rateInterval: msToInterval(Math.max(options.intervalMs * 4, 240_000)),
          datasourceUid,
          datasourceType,
          onWarning: (message) =>
            warnings.push({
              sourceFile: normalized.sourceFile,
              dashboardTitle,
              panelTitle: asString(panel.title) || "(untitled panel)",
              panelId,
              refId: target.refId,
              datasourceUid,
              datasourceType,
              kind: "promql-macro",
              message,
            }),
        });
        if (syntaxIssue) {
          errors.push(syntaxIssue);
          if (options.failFast) {
            throw new Error(
              `PromQL syntax validation failed at ${dashboardTitle} / ${String(panel.title || panelId)} / ${target.refId}`,
            );
          }
          return;
        }
      }
      if (options.syntaxOnly) return;

      if (!datasourceUid) {
        warnings.push({
          sourceFile: normalized.sourceFile,
          dashboardTitle,
          panelTitle: asString(panel.title) || "(untitled panel)",
          panelId,
          refId: target.refId,
          message: "Skip target: datasource uid unresolved",
          kind: "skip",
        });
        return;
      }

      const queryBody = buildValidateQueryBody(target, {
        datasourceUid,
        vars: dashboardVars,
        fromMs,
        toMs,
        intervalMs: options.intervalMs,
      });
      if (!queryBody) return;
      const unresolvedTokens = findUnresolvedTemplateTokens(queryBody);
      if (unresolvedTokens.length > 0) {
        warnings.push({
          sourceFile: normalized.sourceFile,
          dashboardTitle,
          panelTitle: asString(panel.title) || "(untitled panel)",
          panelId,
          refId: target.refId,
          datasourceUid,
          datasourceType,
          kind: "skip",
          message: `unresolved template tokens: ${unresolvedTokens.join(", ")}`,
        });
      }

      const response = await client.requestWithStatus<JsonObject>("POST", "/api/ds/query", {
        from: String(fromMs),
        to: String(toMs),
        queries: [queryBody],
      });
      const data = asObject(response.data);
      const results = data ? getObjectField(data, "results") : undefined;
      const result = results ? getObjectField(results, target.refId) : undefined;
      const queryError = result
        ? asString(result.error) || asString(result.errorMessage) || asString(result.message)
        : undefined;
      if (queryError) {
        errors.push({
          sourceFile: normalized.sourceFile,
          dashboardTitle,
          panelTitle: asString(panel.title) || "(untitled panel)",
          panelId,
          refId: target.refId,
          datasourceUid,
          datasourceType,
          kind: "query-error",
          message: queryError,
        });
        if (options.failFast) {
          throw new Error(
            `Validation failed at ${dashboardTitle} / ${String(panel.title || panelId)} / ${target.refId}`,
          );
        }
        return;
      }

      if (response.status !== 200) {
        const message = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
        errors.push({
          sourceFile: normalized.sourceFile,
          dashboardTitle,
          panelTitle: asString(panel.title) || "(untitled panel)",
          panelId,
          refId: target.refId,
          datasourceUid,
          datasourceType,
          kind: "query-error",
          message: `HTTP ${response.status}: ${message}`,
        });
        return;
      }

      if (!renderFramesText(response.data, target.refId)) {
        warnings.push({
          sourceFile: normalized.sourceFile,
          dashboardTitle,
          panelTitle: asString(panel.title) || "(untitled panel)",
          panelId,
          refId: target.refId,
          datasourceUid,
          datasourceType,
          kind: "no-data",
          message: "no data returned",
        });
      }
    });
  }
  return { errors, warnings };
}
