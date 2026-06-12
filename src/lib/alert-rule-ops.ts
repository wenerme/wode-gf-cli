import { asObject, asObjectArray, asString, getObjectField } from "./json-narrow";
import { resolveTemplateValue, type TemplateVars } from "./template-vars";

export type JsonObject = Record<string, unknown>;

export type AlertRuleQuery = {
  refId: string;
  datasourceUid?: string;
  datasourceType?: string;
  query: JsonObject;
  source: JsonObject;
};

export type AlertRuleRefIssue = {
  refId: string;
  missingRefId: string;
  message: string;
};

export type AlertRuleLintWarning = {
  refId: string;
  message: string;
};

export type AlertRuleQueryStatus = "ok" | "error" | "no-data" | "skip";

export type AlertRuleQueryResult = {
  refId: string;
  status: AlertRuleQueryStatus;
  datasourceUid?: string;
  datasourceType?: string;
  message: string;
};

const ExpressionDatasourceUids = new Set(["__expr__", "-100", "__grafana_expr__"]);
const ExpressionDatasourceTypes = new Set(["__expr__", "expression", "expr"]);
const ExpressionModelTypes = new Set(["reduce", "threshold", "math", "classic_conditions", "resample"]);

export function alertRuleTitle(rule: JsonObject): string {
  return asString(rule.title) || asString(rule.name) || asString(rule.uid) || "(untitled alert rule)";
}

export function alertRuleUid(rule: JsonObject): string | undefined {
  return asString(rule.uid);
}

export function alertRuleLabels(rule: JsonObject): Record<string, string> {
  const labels = asObject(rule.labels);
  const output: Record<string, string> = {};
  if (!labels) return output;
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = String(value);
    }
  }
  return output;
}

export function alertRuleAnnotations(rule: JsonObject): Record<string, string> {
  const annotations = asObject(rule.annotations);
  const output: Record<string, string> = {};
  if (!annotations) return output;
  for (const [key, value] of Object.entries(annotations)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = String(value);
    }
  }
  return output;
}

export function alertRuleData(rule: JsonObject): JsonObject[] {
  return asObjectArray(rule.data);
}

export function alertRuleRefIds(rule: JsonObject): Set<string> {
  return new Set(
    alertRuleData(rule)
      .map((entry) => asString(entry.refId))
      .filter((v): v is string => Boolean(v)),
  );
}

function datasourceObject(entry: JsonObject): JsonObject | undefined {
  return getObjectField(entry, "datasource") || getObjectField(entry, "model.datasource");
}

export function alertRuleDataDatasourceUid(entry: JsonObject): string | undefined {
  return asString(entry.datasourceUid) || asString(datasourceObject(entry)?.uid);
}

export function alertRuleDataDatasourceType(entry: JsonObject): string | undefined {
  return asString(datasourceObject(entry)?.type);
}

export function isAlertExpressionData(entry: JsonObject): boolean {
  const uid = alertRuleDataDatasourceUid(entry);
  const type = alertRuleDataDatasourceType(entry);
  const model = getObjectField(entry, "model");
  const modelType = asString(model?.type);
  return (
    (uid ? ExpressionDatasourceUids.has(uid) : false) ||
    (type ? ExpressionDatasourceTypes.has(type) : false) ||
    (modelType ? ExpressionModelTypes.has(modelType) : false)
  );
}

export function extractAlertRuleQueries(rule: JsonObject, vars: TemplateVars = {}): AlertRuleQuery[] {
  const queries: AlertRuleQuery[] = [];
  for (const entry of alertRuleData(rule)) {
    if (isAlertExpressionData(entry)) continue;
    const refId = asString(entry.refId);
    if (!refId) continue;
    const model = asObject(entry.model) || {};
    const datasourceUid = alertRuleDataDatasourceUid(entry);
    const datasourceType = alertRuleDataDatasourceType(entry);
    const query = resolveTemplateValue(
      {
        ...model,
        refId,
        datasource: asObject(model.datasource) || asObject(entry.datasource) || { uid: datasourceUid },
        datasourceId: entry.datasourceId,
        intervalMs: entry.intervalMs ?? model.intervalMs,
        maxDataPoints: entry.maxDataPoints ?? model.maxDataPoints,
      },
      vars,
    ) as JsonObject;
    queries.push({ refId, datasourceUid, datasourceType, query, source: entry });
  }
  return queries;
}

function pushStringRefs(out: Set<string>, value: unknown) {
  if (typeof value !== "string") return;
  const text = value.trim();
  if (!/^[A-Z][A-Z0-9_]*$/i.test(text)) return;
  out.add(text);
}

export function referencedRefIds(entry: JsonObject): string[] {
  const refs = new Set<string>();
  const model = getObjectField(entry, "model") || {};
  pushStringRefs(refs, model.expression);
  pushStringRefs(refs, model.refId);

  for (const condition of asObjectArray(model.conditions)) {
    const query = getObjectField(condition, "query");
    for (const param of Array.isArray(query?.params) ? (query.params as unknown[]) : []) {
      pushStringRefs(refs, param);
    }
  }

  return Array.from(refs).filter((ref) => ref !== asString(entry.refId));
}

export function validateAlertRuleExpressionRefs(rule: JsonObject): AlertRuleRefIssue[] {
  const refs = alertRuleRefIds(rule);
  const issues: AlertRuleRefIssue[] = [];
  for (const entry of alertRuleData(rule)) {
    const refId = asString(entry.refId) || "?";
    for (const missingRefId of referencedRefIds(entry)) {
      if (refs.has(missingRefId)) continue;
      issues.push({
        refId,
        missingRefId,
        message: `${refId} references missing refId ${missingRefId}`,
      });
    }
  }
  return issues;
}

type ThresholdEvaluator = {
  refId: string;
  type: string;
  params: number[];
};

function thresholdEvaluators(rule: JsonObject): ThresholdEvaluator[] {
  const out: ThresholdEvaluator[] = [];
  for (const entry of alertRuleData(rule)) {
    const refId = asString(entry.refId) || "?";
    const model = getObjectField(entry, "model") || {};
    const direct = asObject(model.evaluator);
    if (direct) {
      const type = asString(direct.type);
      const params = asNumberArray(direct.params);
      if (type && params.length > 0) out.push({ refId, type, params });
    }
    for (const condition of asObjectArray(model.conditions)) {
      const evaluator = asObject(condition.evaluator);
      const type = asString(evaluator?.type);
      const params = asNumberArray(evaluator?.params);
      if (type && params.length > 0) out.push({ refId, type, params });
    }
  }
  return out;
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
}

function semanticText(type: string, value: number): string | undefined {
  if (type === "gt") return `>=${formatNumber(value + 1)}`;
  if (type === "gte") return `>=${formatNumber(value)}`;
  if (type === "lt") return `<${formatNumber(value)}`;
  if (type === "lte") return `<=${formatNumber(value)}`;
  return undefined;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function textFields(rule: JsonObject): Array<{ field: string; text: string }> {
  const annotations = alertRuleAnnotations(rule);
  const fields: Array<{ field: string; text: string }> = [];
  for (const field of ["title", "summary", "description"]) {
    const text = field === "title" ? alertRuleTitle(rule) : annotations[field];
    if (text) fields.push({ field, text });
  }
  return fields;
}

function semanticMentions(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/(?:>=|<=|>|<)\s*-?\d+(?:\.\d+)?/g)) {
    out.add(match[0].replace(/\s+/g, ""));
  }
  return Array.from(out);
}

export function lintAlertRuleThresholds(rule: JsonObject): AlertRuleLintWarning[] {
  const warnings: AlertRuleLintWarning[] = [];
  const fields = textFields(rule);
  for (const evaluator of thresholdEvaluators(rule)) {
    const value = evaluator.params[0];
    if (value === undefined) continue;
    const semantic = semanticText(evaluator.type, value);
    if (!semantic) continue;
    warnings.push({
      refId: evaluator.refId,
      message: `threshold ${evaluator.refId} uses ${evaluator.type} ${formatNumber(value)}, business semantic is ${semantic}`,
    });
    for (const { field, text } of fields) {
      const mentions = semanticMentions(text).filter((item) => item !== semantic);
      for (const mention of mentions) {
        warnings.push({
          refId: evaluator.refId,
          message: `${field} contains "${mention}", possible mismatch with ${semantic}`,
        });
      }
    }
  }
  return dedupeWarnings(warnings);
}

function dedupeWarnings(warnings: AlertRuleLintWarning[]): AlertRuleLintWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.refId}\n${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resultHasFrames(data: unknown, refId: string): boolean {
  const body = asObject(data);
  const results = body ? getObjectField(body, "results") : undefined;
  const result = results ? getObjectField(results, refId) : undefined;
  return asObjectArray(result?.frames).length > 0;
}

export function resultErrorMessage(data: unknown, refId: string): string | undefined {
  const body = asObject(data);
  const results = body ? getObjectField(body, "results") : undefined;
  const result = results ? getObjectField(results, refId) : undefined;
  return result
    ? asString(result.error) || asString(result.errorMessage) || asString(result.message)
    : undefined;
}
