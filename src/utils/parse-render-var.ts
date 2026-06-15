export function parseRenderVar(expr: string, optionName = "--var"): { key: string; value: string } {
  const index = expr.indexOf("=");
  if (index <= 0) throw new Error(`Invalid ${optionName} expression: ${expr}. Expect key=value`);
  const key = expr.slice(0, index).trim();
  const value = expr.slice(index + 1).trim();
  if (!key) throw new Error(`Invalid ${optionName} expression: ${expr}. Missing key`);
  return { key, value };
}
