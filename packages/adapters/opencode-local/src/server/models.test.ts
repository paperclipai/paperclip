import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.OLLAMA_HOST;
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

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("returns ollama models for the UI when OLLAMA_HOST is reachable", async () => {
    const originalFetch = globalThis.fetch;
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    process.env.OLLAMA_HOST = "http://100.64.0.10:11434";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [{ name: "qwen3:14b" }, { model: "llama3.1:8b" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;

    try {
      await expect(listOpenCodeModels()).resolves.toEqual([
        { id: "ollama/llama3.1:8b", label: "ollama/llama3.1:8b" },
        { id: "ollama/qwen3:14b", label: "ollama/qwen3:14b" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
