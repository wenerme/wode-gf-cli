const MIN_INTERVAL_SECONDS = 60;

export function calcClsIntervalSpec(
  fromMs: number,
  toMs: number,
  maxDataPoints = 150,
): { milliseconds: number; sql: string } {
  const rangeMs = Math.max(0, toMs - fromMs);
  const seconds = Math.max(MIN_INTERVAL_SECONDS, Math.ceil(rangeMs / Math.max(1, maxDataPoints) / 1_000));
  return { milliseconds: seconds * 1_000, sql: `${seconds} second` };
}

export function calcClsInterval(fromMs: number, toMs: number, maxDataPoints = 150): string {
  return calcClsIntervalSpec(fromMs, toMs, maxDataPoints).sql;
}
