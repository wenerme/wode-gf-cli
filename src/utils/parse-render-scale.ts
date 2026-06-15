import { parsePositiveNumber } from "./parse-positive-number";

export function parseRenderScale(input: string | undefined, hdpi: boolean): number {
  const scale = input !== undefined ? parsePositiveNumber(input, 1) : hdpi ? 2 : 1;
  if (scale > 4) throw new Error(`Invalid render scale: ${scale}. Maximum is 4`);
  return scale;
}
