import type { JsonObject } from "../core/json";

export type ValidateIssue = {
  sourceFile?: string;
  dashboardTitle: string;
  panelTitle: string;
  panelId: number;
  refId: string;
  message: string;
  datasourceUid?: string;
  datasourceType?: string;
  kind?: "query-error" | "promql-syntax" | "promql-macro" | "no-data" | "skip";
};

export type DashboardTarget = {
  refId: string;
  raw: JsonObject;
};
