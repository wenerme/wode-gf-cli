export function parsePositiveNumber(input: string | undefined, fallback: number): number {
  if (!input?.trim()) return fallback;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive number: ${input}`);
  }
  return parsed;
}
