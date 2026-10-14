import { asObject, asObjectArray, asString } from "./json-narrow";

/** Alertmanager / Grafana matcher JSON shape (silences, rules API `matcher`/`rule_matcher`). */
export type LabelMatcher = { name: string; value: string; isRegex: boolean; isEqual: boolean };

const MatcherPattern = /^\s*([^\s=!~"]+)\s*(=~|!~|!=|=)\s*(.*?)\s*$/;

/** Parse `k=v`, `k!=v`, `k=~re`, `k!~re`. Values may be wrapped in single or double quotes. */
export function parseLabelMatcher(input: string): LabelMatcher {
  const match = MatcherPattern.exec(input);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid matcher: ${input}. Use k=v, k!=v, k=~re or k!~re`);
  }
  let value = match[3] ?? "";
  const quoted = /^(["'])(.*)\1$/.exec(value);
  if (quoted) value = (quoted[2] ?? "").replace(/\\(["\\])/g, "$1");
  const op = match[2];
  const matcher = {
    name: match[1],
    value,
    isRegex: op === "=~" || op === "!~",
    isEqual: op === "=" || op === "=~",
  };
  if (matcher.isRegex) compileAnchored(matcher.value, input);
  return matcher;
}

function compileAnchored(pattern: string, source: string): RegExp {
  try {
    return new RegExp(`^(?:${pattern})$`);
  } catch (error) {
    throw new Error(`Invalid regex in matcher ${source}: ${(error as Error).message}`);
  }
}

export function matcherOperator(matcher: LabelMatcher): string {
  if (matcher.isRegex) return matcher.isEqual ? "=~" : "!~";
  return matcher.isEqual ? "=" : "!=";
}

/** Alertmanager filter syntax, e.g. `team="sre"`. */
export function formatMatcher(matcher: LabelMatcher): string {
  const escaped = matcher.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${matcher.name}${matcherOperator(matcher)}"${escaped}"`;
}

/** Whether the matcher matches a missing/empty label value (Alertmanager semantics, anchored regex). */
export function matcherMatchesEmpty(matcher: LabelMatcher): boolean {
  if (matcher.isRegex) {
    const matches = compileAnchored(matcher.value, formatMatcher(matcher)).test("");
    return matcher.isEqual ? matches : !matches;
  }
  return matcher.isEqual ? matcher.value === "" : matcher.value !== "";
}

/**
 * Refuse silences that would match every alert: zero matchers, or every matcher matches the empty string
 * (e.g. `team=~".*"`, `team!=x`). Alertmanager applies the same "at least one non-empty matcher" rule.
 */
export function validateSilenceMatchers(matchers: LabelMatcher[]): void {
  if (matchers.length === 0) throw new Error("Silence needs at least one --matcher");
  if (matchers.every((matcher) => matcherMatchesEmpty(matcher))) {
    throw new Error(
      `Refusing silence: every matcher matches the empty string and would silence all alerts (${matchers
        .map(formatMatcher)
        .join(", ")}). Add at least one matcher such as team="sre".`,
    );
  }
}

const DurationUnits: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse durations such as `90m`, `2h`, `1h30m`, `1d`. */
export function parseDurationMs(input: string): number {
  const text = input.trim();
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/gy;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    total += Number(match[1]) * (DurationUnits[match[2] ?? ""] ?? 0);
    consumed += match[0].length;
  }
  if (!text || consumed !== text.length || total <= 0) {
    throw new Error(`Invalid duration: ${input}. Use e.g. 30m, 2h, 1h30m, 1d`);
  }
  return Math.round(total);
}

export type Silence = {
  id: string;
  state: string;
  startsAt?: string;
  endsAt?: string;
  updatedAt?: string;
  createdBy?: string;
  comment?: string;
  matchers: LabelMatcher[];
};

export function decodeSilence(value: unknown): Silence | undefined {
  const obj = asObject(value);
  if (!obj) return undefined;
  return {
    id: asString(obj.id) || "",
    state: asString(asObject(obj.status)?.state) || "unknown",
    startsAt: asString(obj.startsAt),
    endsAt: asString(obj.endsAt),
    updatedAt: asString(obj.updatedAt),
    createdBy: asString(obj.createdBy),
    comment: typeof obj.comment === "string" ? obj.comment : undefined,
    matchers: asObjectArray(obj.matchers).map((matcher) => ({
      name: asString(matcher.name) || "",
      value: typeof matcher.value === "string" ? matcher.value : "",
      isRegex: matcher.isRegex === true,
      // Alertmanager defaults isEqual to true when absent.
      isEqual: matcher.isEqual !== false,
    })),
  };
}

const SilenceStateOrder: Record<string, number> = { active: 0, pending: 1, expired: 2 };

export function decodeSilences(response: unknown, options: { all: boolean }): Silence[] {
  if (!Array.isArray(response)) throw new Error("Silences response is not an array");
  return response
    .map((item) => decodeSilence(item))
    .filter((item): item is Silence => Boolean(item))
    .filter((item) => options.all || item.state !== "expired")
    .sort(
      (a, b) =>
        (SilenceStateOrder[a.state] ?? 9) - (SilenceStateOrder[b.state] ?? 9) ||
        String(b.endsAt || "").localeCompare(String(a.endsAt || "")),
    );
}

export type SilencePayload = {
  matchers: LabelMatcher[];
  startsAt: string;
  endsAt: string;
  createdBy: string;
  comment: string;
};

export function buildSilencePayload(input: {
  matchers: LabelMatcher[];
  nowMs: number;
  endMs: number;
  createdBy: string;
  comment: string;
}): SilencePayload {
  validateSilenceMatchers(input.matchers);
  const comment = input.comment.trim();
  if (!comment) throw new Error("Silence needs a non-empty --comment");
  if (!(input.endMs > input.nowMs)) throw new Error("Silence end time must be in the future");
  return {
    matchers: input.matchers,
    startsAt: new Date(input.nowMs).toISOString(),
    endsAt: new Date(input.endMs).toISOString(),
    createdBy: input.createdBy,
    comment,
  };
}
