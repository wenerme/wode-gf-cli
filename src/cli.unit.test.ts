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

  it("infers resource type from object payload", () => {
    expect(__test__.inferResourceFromObject({ dashboard: { uid: "x" } })).toBe("dashboards");
    expect(__test__.inferResourceFromObject({ uid: "u1", title: "Folder A" })).toBe("folders");
    expect(__test__.inferResourceFromObject({ name: "d1", type: "testdata", access: "proxy" })).toBe(
      "datasources",
    );
  });

  it("supports where/set expressions", () => {
    expect(__test__.parseWhereExpr("a.b=1")).toEqual({ path: "a.b", value: 1 });
    expect(__test__.parseSetExpr('title="abc"')).toEqual({ path: "title", value: "abc" });
    expect(__test__.parseSetExpr("123", "count")).toEqual({ path: "count", value: 123 });
  });

  it("parses render vars and builds render path", () => {
    expect(__test__.parseRenderVar("env=prod")).toEqual({ key: "env", value: "prod" });
    const renderPath = __test__.buildRenderPanelPath({
      dashboardUid: "abc123",
      panelId: 7,
      from: "now-1h",
      to: "now",
      width: 1200,
      height: 800,
      tz: "UTC",
      theme: "light",
      vars: ["env=prod", "region=ap-southeast-1"],
    });
    expect(renderPath).toContain("/render/d-solo/abc123/_");
    expect(renderPath).toContain("panelId=7");
    expect(renderPath).toContain("var-env=prod");
  });

  it("gets and sets nested path values", () => {
    const target: Record<string, unknown> = {};
    __test__.setPathValue(target, "a.b[0].name", "alice");
    expect(__test__.getPathValue(target, "a.b[0].name")).toBe("alice");
  });

  it("deep merges objects and replaces arrays", () => {
    const merged = __test__.deepMerge(
      { a: { b: 1 }, arr: [1, 2], keep: true },
      { a: { c: 2 }, arr: [3], next: "x" },
    ) as {
      a: { b: number; c: number };
      arr: number[];
      keep: boolean;
      next: string;
    };

    expect(merged.a).toEqual({ b: 1, c: 2 });
    expect(merged.arr).toEqual([3]);
    expect(merged.keep).toBe(true);
    expect(merged.next).toBe("x");
  });
});
