export function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input?.trim()) return fallback;
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${input}`);
  }
  return parsed;
}
