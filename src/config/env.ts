import fs from "node:fs";

export function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const matched = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!matched) continue;

    const key = matched[1];
    if (!key) continue;
    let value = matched[2] ?? "";

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx);
      value = value.trim();
    }

    vars[key] = value;
  }
  return vars;
}

function loadEnvFile(filePath: string): Record<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

export function loadEnv(): void {
  const shellEnvKeys = new Set(Object.keys(process.env));
  const merged = {
    ...loadEnvFile(".env"),
    ...loadEnvFile(".env.local"),
  };
  for (const [key, value] of Object.entries(merged)) {
    if (!shellEnvKeys.has(key)) process.env[key] = value;
  }
}

export function normalizePrefix(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export function envValue(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
}
