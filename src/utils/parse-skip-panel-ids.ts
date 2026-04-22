export function parseSkipPanelIds(value?: string): number[] {
  if (!value?.trim()) return [];
  const ids = value
    .split(",")
    .map((v) => Number.parseInt(v.trim(), 10))
    .filter((v) => Number.isFinite(v) && v > 0);
  return Array.from(new Set(ids));
}
