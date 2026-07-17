import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __test__ } from "./cli";

describe("cli internal unit tests", () => {
  it("parses env file with export/quote/comment", () => {
    const env = __test__.parseEnvFile(
      ["# comment", "A=1", "export B='two'", 'C="three"', "D=four # trailing"].join("\n"),
    );

    expect(env.A).toBe("1");
    expect(env.B).toBe("two");
    expect(env.C).toBe("three");
    expect(env.D).toBe("four");
  });

  it("parses resources and deduplicates", () => {
    const resources = __test__.parseResources("dashboards,datasources,dashboards");
    expect(resources).toEqual(["dashboards", "datasources"]);
  });

  it("fails for unsupported resources", () => {
    expect(() => __test__.parseResources("invalid-resource")).toThrow("Unsupported resource");
  });

  it("rejects duplicate dashboard UIDs from multiple source files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wode-gf-cli-duplicate-dashboard-"));
    try {
      writeFileSync(
        path.join(dir, "classic.json"),
        JSON.stringify({ __type: "dashboard", dashboard: { uid: "same", title: "Classic" } }),
      );
      writeFileSync(
        path.join(dir, "v2.json"),
        JSON.stringify({
          __type: "dashboard-v2",
          apiVersion: "dashboard.grafana.app/v2beta1",
          kind: "Dashboard",
          metadata: { name: "same" },
          spec: { title: "V2", layout: { kind: "TabsLayout", spec: { tabs: [] } } },
        }),
      );

      expect(() => __test__.collectBundle([dir])).toThrow(/Duplicate dashboard key "same"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("infers resource type from object payload", () => {
    expect(__test__.inferResourceFromObject({ dashboard: { uid: "x" } })).toBe("dashboards");
    expect(
      __test__.inferResourceFromObject({
        apiVersion: "dashboard.grafana.app/v2beta1",
        kind: "Dashboard",
        metadata: { name: "sample-dashboard" },
        spec: { title: "sample-dashboard" },
      }),
    ).toBe("dashboards");
    expect(__test__.inferResourceFromObject({ uid: "u1", title: "Folder A" })).toBe("folders");
    expect(__test__.inferResourceFromObject({ name: "d1", type: "testdata", access: "proxy" })).toBe(
      "datasources",
    );
  });

  it("parses resource aliases for dashboard/connection/folder/policy", () => {
    expect(__test__.parseResourceAlias("dash")).toBe("dashboards");
    expect(__test__.parseResourceAlias("d")).toBe("dashboards");
    expect(__test__.parseResourceAlias("conn")).toBe("datasources");
    expect(__test__.parseResourceAlias("folder")).toBe("folders");
    expect(__test__.parseResourceAlias("policy")).toBe("policies");
  });

  it("parses simple yaml config", () => {
    const parsed = __test__.parseSimpleYamlConfig(
      [
        "context: local",
        "contexts:",
        "  - name: default",
        "    baseUrl: http://127.0.0.1:3300",
        "  - name: local",
        "    baseUrl: http://127.0.0.1:4300",
        "    username: admin",
        "    password: admin",
        "    serviceAccountToken: example-service-account-token",
      ].join("\n"),
    );

    expect(parsed.context).toBe("local");
    expect(parsed.contexts[1]?.name).toBe("local");
    expect(parsed.contexts[1]?.username).toBe("admin");
    expect(parsed.contexts[1]?.serviceAccountToken).toBe("example-service-account-token");
  });

  it("discovers project config from nearest git root", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wode-gf-cli-project-config-"));
    const previousCwd = process.cwd();
    try {
      const nested = path.join(dir, "a", "b");
      writeFileSync(path.join(dir, ".git"), "gitdir: .git/worktrees/test\n");
      mkdirSync(path.join(dir, ".wode"), { recursive: true });
      writeFileSync(path.join(dir, ".wode", "wode-gf-cli.yaml"), "context: sample\n", {
        flag: "w",
      });
      mkdirSync(nested, { recursive: true });

      expect(__test__.findGitRoot(nested)).toBe(dir);
      expect(__test__.getProjectConfigPath(nested)).toBe(path.join(dir, ".wode", "wode-gf-cli.yaml"));
      expect(__test__.readProjectCliConfig(nested)).toEqual({
        path: path.join(dir, ".wode", "wode-gf-cli.yaml"),
        context: "sample",
      });
      process.chdir(nested);
      expect(__test__.resolveContextName()).toBe("sample");
      expect(__test__.resolveContextName({ context: "example" })).toBe("example");
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy profile keys to context keys", () => {
    const migrated = __test__.migrateLegacyConfig(
      ["profile: local", "profiles:", "  - name: local", "    baseUrl: http://127.0.0.1:3300"].join("\n"),
    );

    expect(migrated).toContain("context: local");
    expect(migrated).toContain("contexts:");
    expect(migrated).not.toContain("profile:");
    expect(migrated).not.toContain("profiles:");
  });
});
