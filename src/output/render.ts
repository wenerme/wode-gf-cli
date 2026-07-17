import type { RuntimeContext } from "../config/context";
import type { JsonObject } from "../core/json";
import { asObject, asObjectArray, asString, getObjectField } from "../lib/json-narrow";

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function renderTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return "";
  const widths = headers.map((header, index) => {
    const rowMax = rows.reduce((max, row) => Math.max(max, (row[index] || "").length), 0);
    return Math.max(header.length, rowMax);
  });
  const line = headers.map((header, index) => header.padEnd(widths[index] || header.length)).join(" | ");
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = rows.map((row) =>
    row.map((cell, index) => (cell || "").padEnd(widths[index] || cell.length)).join(" | "),
  );
  return [line, separator, ...body].join("\n");
}

export function renderFramesText(data: unknown, refId: string): string | undefined {
  const body = asObject(data);
  const results = body ? getObjectField(body, "results") : undefined;
  const result = results ? getObjectField(results, refId) : undefined;
  const frames = result ? asObjectArray(result.frames) : [];
  if (frames.length === 0) return undefined;

  const blocks: string[] = [];
  for (const frame of frames) {
    const schema = getObjectField(frame, "schema");
    const fields = schema ? asObjectArray(schema.fields) : [];
    let headers = fields.map((field, index) => asString(field.name) || `col_${index + 1}`);
    const dataObject = getObjectField(frame, "data");
    const columns = Array.isArray(dataObject?.values) ? (dataObject.values as unknown[]) : [];
    const arrayColumns = columns.filter((column): column is unknown[] => Array.isArray(column));
    if (headers.length === 0 && columns.length > 0) {
      headers = Array.from({ length: columns.length }, (_, index) => `col_${index + 1}`);
    }
    const rowCount = arrayColumns.reduce((max, column) => Math.max(max, column.length), 0);
    const rows: string[][] = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row: string[] = [];
      for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
        const column = columns[columnIndex];
        row.push(formatCell(Array.isArray(column) ? column[rowIndex] : undefined));
      }
      rows.push(row);
    }
    blocks.push(renderTable(headers, rows));
  }
  return blocks.filter(Boolean).join("\n\n");
}

export type ListRow = { uid: string; label: string; folder?: string; raw: JsonObject };

export function rowsToTable(rows: ListRow[]): string {
  return renderTable(
    ["uid", "title / name", "folder"],
    rows.map((row) => [row.uid, row.label, row.folder || ""]),
  );
}

export function printMessage(ctx: RuntimeContext, message: string): void {
  if (ctx.output === "json") {
    console.log(JSON.stringify({ type: "message", message }));
    return;
  }
  if (!ctx.quiet) console.log(message);
}

export function printData(ctx: RuntimeContext, type: string, data: Record<string, unknown>): void {
  if (ctx.output === "json") {
    console.log(JSON.stringify({ type, ...data }));
    return;
  }
  if (!ctx.quiet && data.message && typeof data.message === "string") console.log(data.message);
}

export function normalizeRenderTarget(target: string): "panel" | "dashboard" {
  const normalized = String(target || "")
    .trim()
    .toLowerCase();
  if (normalized === "panel" || normalized === "dashboard") return normalized;
  throw new Error(`Unsupported render target: ${target}. Use panel|dashboard`);
}
