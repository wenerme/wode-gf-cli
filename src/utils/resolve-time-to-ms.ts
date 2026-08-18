import moment from "moment-timezone";

const GrafanaRelativeTimePattern = /^now(?:[+-][0-9]+(?:ms|s|m|h|d|w|M|Q|y))?(?:\/(?:s|m|h|d|w|M|Q|y))?$/;
const ExplicitOffsetPattern = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i;
const DateFormatTokens = [
  "YYYY",
  "MMMM",
  "MMM",
  "SSS",
  "YY",
  "MM",
  "DD",
  "HH",
  "hh",
  "mm",
  "ss",
  "ZZ",
  "M",
  "D",
  "H",
  "h",
  "m",
  "s",
  "S",
  "Z",
  "A",
  "a",
  "Q",
  "X",
  "x",
] as const;

export function normalizeGrafanaTimeZone(input: string | undefined, fallback = "UTC"): string {
  const value = String(input || fallback).trim();
  const normalized = value.toUpperCase() === "UTC" ? "UTC" : value;
  if (!normalized || normalized.toLowerCase() === "browser" || !moment.tz.zone(normalized)) {
    throw new Error(`Unsupported timezone: ${value || "(empty)"}`);
  }
  return normalized;
}

export function isGrafanaRelativeTime(input: string): boolean {
  return GrafanaRelativeTimePattern.test(input.trim());
}

function resolveRelativeTime(value: string, nowMs: number, timeZone: string): number {
  const match = /^now(?:([+-])([0-9]+)(ms|s|m|h|d|w|M|Q|y))?(?:\/(s|m|h|d|w|M|Q|y))?$/.exec(value);
  if (!match) throw new Error(`Invalid time expression: ${value}`);
  const [, direction, rawAmount, unit, roundUnit] = match;
  const target = moment.tz(nowMs, timeZone);
  if (direction && rawAmount && unit) {
    const amount = Number.parseInt(rawAmount, 10) * (direction === "+" ? 1 : -1);
    target.add(amount, unit as moment.unitOfTime.DurationConstructor);
  }
  if (roundUnit) target.startOf(roundUnit as moment.unitOfTime.StartOf);
  return target.valueOf();
}

function parseAbsoluteTime(value: string, timeZone: string): number {
  const parsed = ExplicitOffsetPattern.test(value)
    ? moment.parseZone(value, moment.ISO_8601, true)
    : moment.tz(value, moment.ISO_8601, true, timeZone);
  if (!parsed.isValid()) throw new Error(`Invalid time expression: ${value}`);
  return parsed.valueOf();
}

export function resolveTimeToMs(input: string, nowMs = Date.now(), timeZone = "UTC"): number {
  const value = input.trim();
  if (!value) throw new Error("Invalid time: empty");
  const normalizedTimeZone = normalizeGrafanaTimeZone(timeZone);
  if (isGrafanaRelativeTime(value)) return resolveRelativeTime(value, nowMs, normalizedTimeZone);

  if (/^[0-9]+$/.test(value)) {
    const n = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(n)) throw new Error(`Invalid time expression: ${input}`);
    if (n >= 1_000_000_000_000) return n;
    return n * 1000;
  }
  return parseAbsoluteTime(value, normalizedTimeZone);
}

export function normalizeRenderTime(input: string, timeZone = "UTC"): string {
  const value = input.trim();
  if (!value) throw new Error("Invalid render time: empty");
  if (isGrafanaRelativeTime(value)) return value;
  return String(resolveTimeToMs(value, Date.now(), timeZone));
}

function assertDateFormatPattern(pattern: string): void {
  let remaining = pattern;
  let tokenCount = 0;
  while (remaining.length > 0) {
    if (remaining.startsWith("[")) {
      const end = remaining.indexOf("]", 1);
      if (end < 0) throw new Error(`Unsupported Grafana date format: ${pattern}`);
      remaining = remaining.slice(end + 1);
      continue;
    }
    const token = DateFormatTokens.find((candidate) => remaining.startsWith(candidate));
    if (token) {
      tokenCount += 1;
      remaining = remaining.slice(token.length);
      continue;
    }
    const char = remaining[0] || "";
    if (/[A-Za-z]/.test(char)) throw new Error(`Unsupported Grafana date format: ${pattern}`);
    remaining = remaining.slice(1);
  }
  if (tokenCount === 0) throw new Error(`Unsupported Grafana date format: ${pattern}`);
}

export function formatGrafanaTimeVariable(
  valueMs: string | number,
  formatter: string,
  timeZone = "UTC",
): string {
  const ms = typeof valueMs === "number" ? valueMs : Number(valueMs);
  if (!Number.isFinite(ms)) throw new Error(`Invalid Grafana time value: ${String(valueMs)}`);
  const [kind, ...args] = formatter.split(":");
  if (kind?.toLowerCase() !== "date") throw new Error(`Unsupported Grafana time formatter: ${formatter}`);
  const pattern = args.join(":");
  if (!pattern || pattern.toLowerCase() === "iso") return new Date(ms).toISOString();
  if (pattern.toLowerCase() === "seconds") return String(Math.floor(ms / 1000));
  assertDateFormatPattern(pattern);
  return moment.tz(ms, normalizeGrafanaTimeZone(timeZone)).format(pattern);
}
