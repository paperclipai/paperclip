import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerClientAuthCommands } from "../commands/client/auth.js";

describe("registerClientAuthCommands", () => {
  it("registers auth commands without duplicate company-id flags", () => {
    const program = new Command();
    const auth = program.command("auth");

    expect(() => registerClientAuthCommands(auth)).not.toThrow();

    const login = auth.commands.find((command) => command.name() === "login");
    expect(login).toBeDefined();
    expect(login?.options.filter((option) => option.long === "--company-id")).toHaveLength(1);
  });
});
