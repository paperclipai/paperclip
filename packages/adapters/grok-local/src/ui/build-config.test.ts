import { describe, expect, it } from "vitest";
import { buildGrokLocalConfig } from "./build-config.js";

describe("buildGrokLocalConfig", () => {
  it("maps create-form values into adapter config", () => {
    expect(buildGrokLocalConfig({
      cwd: "/tmp/project",
      instructionsFilePath: "/tmp/AGENTS.md",
      model: "grok-build",
      thinkingEffort: "high",
      envVars: "XAI_API_KEY=secret\n",
      extraArgs: "--check, --verbatim",
    } as never)).toEqual({
      cwd: "/tmp/project",
      instructionsFilePath: "/tmp/AGENTS.md",
      model: "grok-build",
      timeoutSec: 0,
      graceSec: 20,
      reasoningEffort: "high",
      env: {
        XAI_API_KEY: { type: "plain", value: "secret" },
      },
      extraArgs: ["--check", "--verbatim"],
    });
  });
});
