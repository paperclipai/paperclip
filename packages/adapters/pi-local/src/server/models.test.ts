import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  parseModelsOutput,
  resetPiModelsCacheForTests,
} from "./models.js";

describe("parseModelsOutput", () => {
  it("parses the columnar table printed to stdout", () => {
    const stdout = [
      "provider       model                     context  max-out  thinking  images",
      "deepseek       deepseek-v4-pro           1M       384K     yes       no    ",
      "moonshotai     kimi-k3                   1.0M     1.0M     yes       yes   ",
    ].join("\n");
    expect(parseModelsOutput(stdout)).toEqual([
      { id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" },
      { id: "moonshotai/kimi-k3", label: "moonshotai/kimi-k3" },
    ]);
  });

  it("ignores banner lines such as the claude-* warning", () => {
    const stdout = [
      'Warning: No models match pattern "claude-*"',
      "provider       model                     context  max-out  thinking  images",
      "deepseek       deepseek-v4-pro           1M       384K     yes       no    ",
    ].join("\n");
    expect(parseModelsOutput(stdout)).toEqual([
      { id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" },
    ]);
  });

  it("returns an empty list for warning-only output", () => {
    expect(parseModelsOutput('Warning: No models match pattern "claude-*"')).toEqual([]);
  });
});

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    resetPiModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });
});
