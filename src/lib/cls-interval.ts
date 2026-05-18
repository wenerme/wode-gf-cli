const CLS_INTERVAL_STEPS_MS = [
  60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000,
] as const;

const CLS_INTERVAL_SQL = new Map<number, string>([
  [60_000, "1 minute"],
  [120_000, "2 minute"],
  [300_000, "5 minute"],
  [600_000, "10 minute"],
  [1_800_000, "30 minute"],
  [3_600_000, "1 hour"],
  [7_200_000, "2 hour"],
  [21_600_000, "6 hour"],
  [43_200_000, "12 hour"],
  [86_400_000, "1 day"],
]);

export function calcClsInterval(fromMs: number, toMs: number, maxDataPoints = 150): string {
  const rangeMs = Math.max(0, toMs - fromMs);
  const rawIntervalMs = rangeMs / Math.max(1, maxDataPoints);
  const step = CLS_INTERVAL_STEPS_MS.find((value) => value >= rawIntervalMs) ?? CLS_INTERVAL_STEPS_MS.at(-1);
  return CLS_INTERVAL_SQL.get(step || 86_400_000) || "1 day";
}
