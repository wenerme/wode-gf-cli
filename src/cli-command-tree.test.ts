import { describe, expect, it } from "vitest";
import { buildCliProgram } from "./cli";

describe("CLI command tree compatibility", () => {
  it("keeps top-level commands in stable order", () => {
    const program = buildCliProgram();
    expect(program.commands.map((command) => command.name())).toEqual([
      "context",
      "auth",
      "export",
      "pull",
      "import",
      "push",
      "diff",
      "validate",
      "list",
      "render",
      "query",
      "api",
      "panel",
      "patch",
      "delete",
      "user",
      "dashboard",
      "connection",
      "folder",
      "alert-rule",
      "contact-point",
      "policy",
    ]);
  });

  it("keeps context and panel aliases and subcommands", () => {
    const program = buildCliProgram();
    const context = program.commands.find((command) => command.name() === "context");
    const panel = program.commands.find((command) => command.name() === "panel");

    expect(context?.aliases()).toContain("ctx");
    expect(context?.commands.map((command) => command.name())).toEqual(["list", "current", "use", "set"]);
    expect(panel?.aliases()).toContain("p");
    expect(panel?.commands.map((command) => command.name())).toEqual([
      "list",
      "get",
      "inspect",
      "patch",
      "edit",
      "validate",
      "legend-preset",
      "render",
    ]);
  });
});
