import { describe, expect, it } from "vitest";
import { buildCopilotLocalConfig } from "./build-config.js";

describe("buildCopilotLocalConfig", () => {
  it("builds the adapter config with defaults", () => {
    const config = buildCopilotLocalConfig({
      cwd: "/tmp/repo",
      instructionsFilePath: "/tmp/repo/AGENTS.md",
      promptTemplate: "Continue working",
      bootstrapPrompt: "",
      model: "",
      envVars: "GH_TOKEN=abc123",
      envBindings: null,
      command: "copilot",
      extraArgs: "--experimental, --enable-reasoning-summaries",
    } as never);

    expect(config.cwd).toBe("/tmp/repo");
    expect(config.instructionsFilePath).toBe("/tmp/repo/AGENTS.md");
    expect(config.autopilot).toBe(true);
    expect(config.command).toBe("copilot");
    expect(config.extraArgs).toEqual(["--experimental", "--enable-reasoning-summaries"]);
    expect(config.env).toEqual({
      GH_TOKEN: { type: "plain", value: "abc123" },
    });
  });
});
