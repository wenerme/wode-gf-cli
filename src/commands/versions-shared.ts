import fs from "node:fs";
import path from "node:path";
import { diffJson, formatJsonChanges, type JsonChange } from "../core/json-diff";
import type { CliContext, CommandAppContext } from "./runtime";

/** A version reference: a number, `current`, `current~N` (N saves before current), or a local file path. */
export type VersionRef =
  | { kind: "version"; version: number }
  | { kind: "current"; back: number }
  | { kind: "file"; file: string };

export function parseVersionRef(token: string): VersionRef {
  const value = token.trim();
  if (/^\d+$/.test(value)) return { kind: "version", version: Number(value) };
  const current = value.match(/^(?:current|latest|HEAD)(?:~(\d+))?$/i);
  if (current) return { kind: "current", back: Number(current[1] || 0) };
  if (fs.existsSync(value)) return { kind: "file", file: path.resolve(value) };
  throw new Error(
    `Invalid version "${token}": use a version number, current, current~N, or an existing file`,
  );
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function parseVersionNumber(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

/** Prints a structural diff; returns true when there are changes (callers set exit code 1). */
export function printChanges(
  app: CommandAppContext,
  ctx: CliContext,
  label: { from: string; to: string },
  changes: JsonChange[],
  json: boolean,
): boolean {
  if (json || ctx.output === "json") {
    console.log(
      JSON.stringify({ from: label.from, to: label.to, changed: changes.length > 0, changes }, null, 2),
    );
    return changes.length > 0;
  }
  if (changes.length === 0) {
    app.runtime.printMessage(ctx, `No differences between ${label.from} and ${label.to}`);
    return false;
  }
  app.runtime.printMessage(ctx, `${label.from} -> ${label.to}: ${changes.length} change(s)`);
  for (const line of formatJsonChanges(changes)) app.runtime.printMessage(ctx, `  ${line}`);
  return true;
}

export { diffJson };

export function shortTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().replace("T", " ").slice(0, 19);
}

export function clip(value: string | undefined, max = 60): string {
  const text = (value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
