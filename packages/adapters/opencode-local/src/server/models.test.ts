import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runChildProcess } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, command: string, args: string[]) => {
    if (command === "__paperclip_missing_opencode_command__") {
      throw new Error("Failed to start command");
    }
    if (args.includes("models")) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    }
    throw new Error("Unexpected command");
  }),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess,
  };
});

import {
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

function setMockOpenCodeDiscovery(stdout: string) {
  runChildProcess.mockImplementation(async (_runId: string, command: string, args: string[]) => {
    if (command === "__paperclip_missing_opencode_command__") {
      throw new Error("Failed to start command");
    }
    if (args.includes("models")) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout,
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    }
    throw new Error("Unexpected command");
  });
}

function mockOpenRouterResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: "",
    json: vi.fn(async () => payload),
  } as unknown as Response;
}

describe("openCode models", () => {
  const originalAllowlist = process.env.PAPERCLIP_OPENROUTER_MODEL_ALLOWLIST;
  const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    setMockOpenCodeDiscovery("");
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.PAPERCLIP_OPENROUTER_MODEL_ALLOWLIST;
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    if (originalAllowlist === undefined) {
      delete process.env.PAPERCLIP_OPENROUTER_MODEL_ALLOWLIST;
    } else {
      process.env.PAPERCLIP_OPENROUTER_MODEL_ALLOWLIST = originalAllowlist;
    }
    if (originalOpenRouterApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
    }
    vi.restoreAllMocks();
    runChildProcess.mockReset();
    resetOpenCodeModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("merges discovered models with curated OpenRouter models", async () => {
    setMockOpenCodeDiscovery("openrouter/openai/gpt-5\nopenai/gpt-4o\n");
    process.env.OPENROUTER_API_KEY = "or-test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockOpenRouterResponse({
        data: [
          { id: "openai/gpt-5", name: "OpenAI GPT-5" },
          { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
        ],
      }),
    );

    await expect(listOpenCodeModels()).resolves.toEqual([
      { id: "openai/gpt-4o", label: "openai/gpt-4o" },
      { id: "openrouter/deepseek/deepseek-chat", label: "DeepSeek Chat" },
      { id: "openrouter/openai/gpt-5", label: "OpenAI GPT-5" },
    ]);
  });

  it("falls back to discovery models when OpenRouter fetch fails", async () => {
    setMockOpenCodeDiscovery("openai/gpt-4o\n");
    process.env.OPENROUTER_API_KEY = "or-test-key";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("OpenRouter request failed"));

    await expect(listOpenCodeModels()).resolves.toEqual([
      { id: "openai/gpt-4o", label: "openai/gpt-4o" },
    ]);
  });

  it("skips OpenRouter discovery when the key is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setMockOpenCodeDiscovery("openai/gpt-4o\n");

    await expect(listOpenCodeModels()).resolves.toEqual([
      { id: "openai/gpt-4o", label: "openai/gpt-4o" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("respects the OpenRouter model cache TTL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockOpenRouterResponse({
        data: [{ id: "openai/gpt-5", name: "OpenAI GPT-5" }],
      }),
    );
    setMockOpenCodeDiscovery("");
    process.env.OPENROUTER_API_KEY = "or-test-key";

    vi.useFakeTimers();
    vi.setSystemTime(0);
    await expect(listOpenCodeModels()).resolves.toEqual([{ id: "openrouter/openai/gpt-5", label: "OpenAI GPT-5" }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await expect(listOpenCodeModels()).resolves.toEqual([{ id: "openrouter/openai/gpt-5", label: "OpenAI GPT-5" }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(60_001);
    await expect(listOpenCodeModels()).resolves.toEqual([{ id: "openrouter/openai/gpt-5", label: "OpenAI GPT-5" }]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
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

  it("skips the availability check when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).resolves.toEqual([
      {
        id: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        label: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
      },
    ]);
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "anthropic/gateway/some-model" }),
    ).resolves.toEqual([
      { id: "anthropic/gateway/some-model", label: "anthropic/gateway/some-model" },
    ]);
  });

  it("still enforces provider/model format when OPENCODE_ALLOW_ALL_MODELS is set", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "not-a-valid-id",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });
});
