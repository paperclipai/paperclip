import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  isExternalGatewayModelId,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.PAPERCLIP_OPENCODE_SKIP_DISCOVERY_PREFIXES;
    resetOpenCodeModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId("openai/gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("skips discovery for known external gateway models", async () => {
    // Discovery command is missing — a non-gateway model would throw here.
    // Gateway-prefixed models must resolve without ever invoking discovery.
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    for (const model of [
      "openrouter/anthropic/claude-sonnet-4",
      "zai-coding-plan/glm-4.7",
      "zai/glm-4.7",
      "manifest/openai/gpt-4o-mini",
    ]) {
      await expect(
        ensureOpenCodeModelConfiguredAndAvailable({ model }),
      ).resolves.toEqual([{ id: model, label: model }]);
    }
  });

  it("recognises default gateway prefixes and rejects non-gateway ids", () => {
    expect(isExternalGatewayModelId("manifest/openai/gpt-4o-mini")).toBe(true);
    expect(isExternalGatewayModelId("openrouter/anthropic/claude-sonnet-4")).toBe(true);
    expect(isExternalGatewayModelId("openai/gpt-5")).toBe(false);
    expect(isExternalGatewayModelId("anthropic/claude-sonnet-4")).toBe(false);
  });

  it("merges PAPERCLIP_OPENCODE_SKIP_DISCOVERY_PREFIXES with the defaults", () => {
    process.env.PAPERCLIP_OPENCODE_SKIP_DISCOVERY_PREFIXES = " portkey/ , litellm/ ";
    // Operator-supplied prefixes are honoured...
    expect(isExternalGatewayModelId("portkey/openai/gpt-5")).toBe(true);
    expect(isExternalGatewayModelId("litellm/anthropic/claude-sonnet-4")).toBe(true);
    // ...and the built-in defaults still apply.
    expect(isExternalGatewayModelId("manifest/openai/gpt-4o-mini")).toBe(true);
    expect(isExternalGatewayModelId("openai/gpt-5")).toBe(false);
  });

  it("skips discovery for a gateway added via the env override", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    process.env.PAPERCLIP_OPENCODE_SKIP_DISCOVERY_PREFIXES = "portkey/";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "portkey/openai/gpt-5" }),
    ).resolves.toEqual([
      { id: "portkey/openai/gpt-5", label: "portkey/openai/gpt-5" },
    ]);
  });
});
