export function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input?.trim()) return fallback;
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${input}`);
  }
  return parsed;
}
