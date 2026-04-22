export function msToInterval(ms: number): string {
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (ms % day === 0) return `${ms / day}d`;
  if (ms % hour === 0) return `${ms / hour}h`;
  if (ms % minute === 0) return `${ms / minute}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
