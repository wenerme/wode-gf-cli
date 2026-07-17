import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readCliConfig, writeCliConfig } from "./store";

describe("CLI config store", () => {
  it("writes credentials atomically with private permissions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wode-config-store-"));
    const file = path.join(root, ".wode", "wode-gf-cli.yaml");
    try {
      writeCliConfig(
        {
          context: "example",
          contexts: [{ name: "example", baseUrl: "http://127.0.0.1:3000", password: "private" }],
        },
        file,
      );

      expect(fs.readFileSync(file, "utf8")).toContain("context: example");
      if (process.platform !== "win32") {
        expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
      expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates legacy keys in memory without rewriting on read", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wode-config-read-"));
    const file = path.join(root, "wode-gf-cli.yaml");
    const legacy = "profile: example\nprofiles:\n  - name: example\n";
    try {
      fs.writeFileSync(file, legacy, { encoding: "utf8", mode: 0o644 });
      expect(readCliConfig(file).context).toBe("example");
      expect(fs.readFileSync(file, "utf8")).toBe(legacy);
      if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports malformed config instead of silently replacing it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wode-config-invalid-"));
    const file = path.join(root, "wode-gf-cli.yaml");
    const malformed = "context: example\ncontexts:\n  - baseUrl: http://127.0.0.1:3000\n";
    try {
      fs.writeFileSync(file, malformed, "utf8");
      expect(() => readCliConfig(file)).toThrow(`Failed to read CLI config ${file}`);
      expect(fs.readFileSync(file, "utf8")).toBe(malformed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat permission errors as a missing config", () => {
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw denied;
    });
    try {
      expect(() => readCliConfig("/unreadable/wode-gf-cli.yaml")).toThrow(
        "Failed to read CLI config /unreadable/wode-gf-cli.yaml: permission denied",
      );
    } finally {
      read.mockRestore();
    }
  });
});
