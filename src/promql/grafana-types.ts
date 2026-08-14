export const GrafanaPromQLMacroModes = ["keep", "preset", "eval", "strict"] as const;
export type GrafanaPromQLMacroMode = (typeof GrafanaPromQLMacroModes)[number];

export type GrafanaPromQLTemplateTokenKind = "short" | "braced" | "legacy" | "call";

export type GrafanaPromQLTemplateToken = {
  kind: GrafanaPromQLTemplateTokenKind;
  raw: string;
  name: string;
  fullName: string;
  args: string[];
  format?: string;
  fieldPath?: string;
  start: number;
  end: number;
  inString: boolean;
  quote?: "'" | '"';
};

export type GrafanaPromQLCustomAllValue = {
  value: string | string[];
  isCustomAll: true;
};

export type GrafanaPromQLVariableValue = string | string[] | GrafanaPromQLCustomAllValue;

export type GrafanaPromQLPreflightOptions = {
  macroMode?: GrafanaPromQLMacroMode;
  vars?: Record<string, GrafanaPromQLVariableValue>;
  fromMs?: number;
  toMs?: number;
  interval?: string;
  intervalMs?: number;
  rateInterval?: string;
  rangeMs?: number;
};

export type GrafanaPromQLPreflightResult = {
  expression: string;
  normalizedExpression: string;
  macroMode: GrafanaPromQLMacroMode;
  tokens: GrafanaPromQLTemplateToken[];
  warnings: string[];
};

export function parseGrafanaPromQLMacroMode(input: string | undefined): GrafanaPromQLMacroMode {
  const mode = String(input || "keep")
    .trim()
    .toLowerCase();
  if (GrafanaPromQLMacroModes.includes(mode as GrafanaPromQLMacroMode)) return mode as GrafanaPromQLMacroMode;
  throw new Error(`Unsupported PromQL macro mode: ${input}. Expected keep|preset|eval|strict`);
}

export class GrafanaPromQLMacroError extends Error {
  readonly tokens: GrafanaPromQLTemplateToken[];

  constructor(message: string, tokens: GrafanaPromQLTemplateToken[]) {
    super(message);
    this.name = "GrafanaPromQLMacroError";
    this.tokens = tokens;
  }
}
