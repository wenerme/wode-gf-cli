import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundleToFiles } from "./export";

describe("resource export directory ownership", () => {
  it("removes stale files for explicitly failed partial resources", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wode-export-partial-"));
    const staleDirectory = path.join(root, "folder");
    try {
      fs.mkdirSync(staleDirectory, { recursive: true });
      fs.writeFileSync(path.join(staleDirectory, "stale.json"), "{}\n");

      bundleToFiles(
        root,
        {
          generatedAt: "2026-01-01T00:00:00.000Z",
          url: "http://127.0.0.1:3000",
          resources: ["folders"],
          failedResources: ["folders"],
        },
        true,
      );

      expect(fs.existsSync(staleDirectory)).toBe(false);
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "grafana.manifest.json"), "utf8"));
      expect(manifest.failedResources).toEqual(["folders"]);
      expect(manifest.counts.folders).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
