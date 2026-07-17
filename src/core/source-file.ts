export const SourceFileSymbol = Symbol("sourceFile");

export function attachSourceFile<T>(value: T, filePath: string): T {
  if (value && typeof value === "object") {
    Object.defineProperty(value, SourceFileSymbol, { value: filePath, configurable: true });
  }
  return value;
}

export function sourceFileOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const file = (value as Record<symbol, unknown>)[SourceFileSymbol];
  return typeof file === "string" ? file : undefined;
}
