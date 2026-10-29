import { describe, expect, it } from "vitest";
import { buildMuseLocalConfig } from "./build-config.js";

describe("buildMuseLocalConfig", () => {
  it("maps form values into adapter config", () => {
    const config = buildMuseLocalConfig({
      cwd: "/workspace/my-app",
      instructionsFilePath: "/workspace/AGENTS.md",
      model: "muse-wonder-1.0",
      thinkingEffort: "high",
      command: "muse",
      extraArgs: "--arg1, --arg2",
    } as never);

    expect(config).toEqual({
      cwd: "/workspace/my-app",
      instructionsFilePath: "/workspace/AGENTS.md",
      model: "muse-wonder-1.0",
      reasoningEffort: "high",
      timeoutSec: 0,
      graceSec: 15,
      command: "muse",
      extraArgs: ["--arg1", "--arg2"],
    });
  });
});
