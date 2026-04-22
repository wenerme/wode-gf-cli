export function resolveTimeToMs(input: string, nowMs = Date.now()): number {
  const value = input.trim();
  if (!value) throw new Error("Invalid time: empty");
  if (value === "now") return nowMs;

  const relative = value.match(/^now-([0-9]+)(ms|s|m|h|d|w)$/);
  if (relative) {
    const amount = Number.parseInt(relative[1] || "0", 10);
    const unit = relative[2];
    const factor =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1000
          : unit === "m"
            ? 60_000
            : unit === "h"
              ? 3_600_000
              : unit === "d"
                ? 86_400_000
                : 604_800_000;
    return nowMs - amount * factor;
  }

  if (/^[0-9]+$/.test(value)) {
    const n = Number.parseInt(value, 10);
    if (n >= 1_000_000_000_000) return n;
    return n * 1000;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid time expression: ${input}`);
  }
  return parsed;
}
