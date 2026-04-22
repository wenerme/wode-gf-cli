import { parseRenderVar } from "./parse-render-var";

export function parseVarAssignments(vars: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const expr of vars) {
    const { key, value } = parseRenderVar(expr);
    out[key] = value;
  }
  return out;
}
