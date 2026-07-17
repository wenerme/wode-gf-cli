import fs from "node:fs";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeJson(file: string, data: unknown, pretty = true): void {
  fs.writeFileSync(file, `${JSON.stringify(data, null, pretty ? 2 : 0)}\n`, "utf8");
}

export function safeName(value: string, options?: { lower?: boolean }): string {
  const lower = Boolean(options?.lower);
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const cleaned = normalized
    .trim()
    .replace(/[\s/\\:*?"<>|]+/g, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/\.+/g, ".")
    .replace(/_+/g, "_")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  const finalName = (lower ? cleaned.toLowerCase() : cleaned).slice(0, 120);
  return finalName || "item";
}

export function uniqueBaseName(base: string, used: Set<string>): string {
  const normalized = base || "item";
  if (!used.has(normalized)) {
    used.add(normalized);
    return normalized;
  }
  let index = 2;
  while (used.has(`${normalized}-${index}`)) index += 1;
  const next = `${normalized}-${index}`;
  used.add(next);
  return next;
}

export function resetDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}
