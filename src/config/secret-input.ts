import fs from "node:fs";

export function readSecretFromStdin(label: string): string {
  if (process.stdin.isTTY) {
    throw new Error(`${label} expects piped stdin; interactive echo is not disabled`);
  }
  const value = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (!value) throw new Error(`${label} received an empty value`);
  return value;
}
