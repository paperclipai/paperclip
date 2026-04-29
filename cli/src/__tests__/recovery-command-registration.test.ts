import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerRecoveryCommands } from "../commands/recovery.js";

describe("registerRecoveryCommands", () => {
  it("registers publish, cutover, and drill commands", () => {
    const program = new Command();

    expect(() => registerRecoveryCommands(program)).not.toThrow();

    expect(program.commands.find((command) => command.name() === "recovery:publish")).toBeDefined();
    expect(program.commands.find((command) => command.name() === "recovery:cutover-assets")).toBeDefined();

    const drill = program.commands.find((command) => command.name() === "recovery:drill");
    expect(drill).toBeDefined();
    expect(drill?.options.some((option) => option.long === "--restore-url" && option.required)).toBe(true);
  });
});
