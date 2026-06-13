import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as claudeFallbackModels } from "@paperclipai/adapter-claude-local";
import { resetClaudeModelsCacheForTests } from "@paperclipai/adapter-claude-local/server";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import { models as opencodeFallbackModels } from "@paperclipai/adapter-opencode-local";
import { resetOpenCodeModelsCacheForTests } from "@paperclipai/adapter-opencode-local/server";
import { listAdapterModels, listServerAdapters, refreshAdapterModels } from "../adapters/index.js";
import { resetCodexModelsCacheForTests } from "../adapters/codex-models.js";
import { resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../adapters/cursor-models.js";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

describe("adapter model listing", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetClaudeModelsCacheForTests();
    resetCodexModelsCacheForTests();
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
    resetOpenCodeModelsCacheForTests();
    vi.restoreAllMocks();
  });

  it("returns an empty list for unknown adapters", async () => {
    const models = await listAdapterModels("unknown_adapter");
    expect(models).toEqual([]);
  });

  it("uses provider-prefixed ACPX fallback model labels", () => {
    const adapter = listServerAdapters().find((candidate) => candidate.type === "acpx_local");

    expect(adapter?.models?.some((model) => model.label.startsWith("Claude: "))).toBe(true);
    expect(adapter?.models?.some((model) => model.label.startsWith("Codex: "))).toBe(true);
  });

  it("returns codex fallback models when no OpenAI key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
    expect(models.some((model) => model.id === "gpt-5.5")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns claude fallback models including the latest Opus alias when no Anthropic key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("claude_local");

    expect(models).toEqual(claudeFallbackModels);
    expect(models.some((model) => model.id === "claude-opus-4-8")).toBe(true);
    // Newer flagship models are offered, but Opus 4.8 stays the default (first) option.
    expect(models[0]?.id).toBe("claude-opus-4-8");
    expect(models.some((model) => model.id === "claude-fable-5")).toBe(true);
    expect(models.some((model) => model.id === "claude-mythos-5")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads claude models dynamically and merges fallback options", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "claude-sonnet-4-20250514", display_name: "Claude Sonnet 4" },
          { id: "claude-opus-4-8-20260529", display_name: "Claude Opus 4.8" },
        ],
      }),
    } as Response);

    const first = await listAdapterModels("claude_local");
    const second = await listAdapterModels("claude_local");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "claude-opus-4-8-20260529")).toBe(true);
    expect(first.some((model) => model.id === "claude-opus-4-8")).toBe(true);
  });

  it("refreshes cached claude models on demand", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "claude-sonnet-4-20250514", display_name: "Claude Sonnet 4" }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "claude-opus-4-8-20260529", display_name: "Claude Opus 4.8" }],
        }),
      } as Response);

    const initial = await listAdapterModels("claude_local");
    const refreshed = await refreshAdapterModels("claude_local");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(initial.some((model) => model.id === "claude-sonnet-4-20250514")).toBe(true);
    expect(refreshed.some((model) => model.id === "claude-opus-4-8-20260529")).toBe(true);
  });

  it("falls back to static claude models when Anthropic model discovery fails", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const models = await listAdapterModels("claude_local");
    expect(models).toEqual(claudeFallbackModels);
  });

  it("loads codex models dynamically and merges fallback options", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5-pro" },
          { id: "gpt-5" },
        ],
      }),
    } as Response);

    const first = await listAdapterModels("codex_local");
    const second = await listAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gpt-5-pro")).toBe(true);
    expect(first.some((model) => model.id === "codex-mini-latest")).toBe(true);
  });

  it("refreshes cached codex models on demand", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-5" }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-5.5" }],
        }),
      } as Response);

    const initial = await listAdapterModels("codex_local");
    const refreshed = await refreshAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(initial.some((model) => model.id === "gpt-5")).toBe(true);
    expect(refreshed.some((model) => model.id === "gpt-5.5")).toBe(true);
  });

  it("falls back to static codex models when OpenAI model discovery fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const models = await listAdapterModels("codex_local");
    expect(models).toEqual(codexFallbackModels);
  });


  it("returns cursor fallback models when CLI discovery is unavailable", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      hasError: true,
    }));

    const models = await listAdapterModels("cursor");
    expect(models).toEqual(cursorFallbackModels);
  });

  it("returns opencode fallback models including gpt-5.4", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    const models = await listAdapterModels("opencode_local");

    expect(models).toEqual(opencodeFallbackModels);
  });

  it("loads cursor models dynamically and caches them", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: "Available models: auto, composer-1.5, gpt-5.3-codex-high, claude-4.6-opus-high-thinking",
      stderr: "",
      hasError: false,
    }));
    setCursorModelsRunnerForTests(runner);

    const first = await listAdapterModels("cursor");
    const second = await listAdapterModels("cursor");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "auto")).toBe(true);
    expect(first.some((model) => model.id === "gpt-5.3-codex-high")).toBe(true);
    expect(first.some((model) => model.id === "composer-2-fast")).toBe(true);
  });

  it("parses cursor models when CLI exits non-zero but emits colonless header", async () => {
    const runner = vi.fn(() => ({
      status: 1,
      stdout: [
        "Available models",
        "",
        "auto - Auto",
        "claude-4.6-opus-high-thinking - Opus 4.6 1M Thinking",
      ].join("\n"),
      stderr: "",
      hasError: false,
    }));
    setCursorModelsRunnerForTests(runner);

    const models = await listAdapterModels("cursor");
    expect(models.some((m) => m.id === "auto" && m.label === "Auto")).toBe(true);
    expect(models.some((m) => m.id === "claude-4.6-opus-high-thinking")).toBe(true);
  });

  it("parses cursor id-dash-label format from agent models output", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: [
        "Available models",
        "",
        "auto - Auto",
        "claude-4.6-opus-high-thinking - Opus 4.6 1M Thinking  (current)",
        "gpt-5.3-codex - GPT-5.3 Codex",
      ].join("\n"),
      stderr: "",
      hasError: false,
    }));
    setCursorModelsRunnerForTests(runner);

    const models = await listAdapterModels("cursor");
    expect(models.some((m) => m.id === "auto" && m.label === "Auto")).toBe(true);
    expect(models.some((m) => m.id === "claude-4.6-opus-high-thinking" && m.label === "Opus 4.6 1M Thinking")).toBe(true);
    expect(models.some((m) => m.id === "gpt-5.3-codex" && m.label === "GPT-5.3 Codex")).toBe(true);
  });

  describe("PAPERCLIP_ADAPTER_MODELS declared models", () => {
    afterEach(() => {
      delete process.env.PAPERCLIP_ADAPTER_MODELS;
    });

    it("prefers declared env models over adapter discovery", async () => {
      process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
        opencode_local: [
          { id: "tensorix/deepseek/deepseek-chat-v3.1", label: "DeepSeek v3.1" },
          { id: "tensorix/z-ai/glm-4.7" },
        ],
      });

      const models = await listAdapterModels("opencode_local");

      expect(models).toEqual([
        { id: "tensorix/deepseek/deepseek-chat-v3.1", label: "DeepSeek v3.1" },
        { id: "tensorix/z-ai/glm-4.7", label: "tensorix/z-ai/glm-4.7" },
      ]);
    });

    it("observes env changes between calls (memo keyed by raw env value)", async () => {
      process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
        opencode_local: [{ id: "model-a" }],
      });
      expect(await listAdapterModels("opencode_local")).toEqual([
        { id: "model-a", label: "model-a" },
      ]);

      process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
        opencode_local: [{ id: "model-b" }],
      });
      expect(await listAdapterModels("opencode_local")).toEqual([
        { id: "model-b", label: "model-b" },
      ]);
    });

    it("fails soft on malformed values: falls back to adapter models instead of throwing", async () => {
      process.env.PAPERCLIP_ADAPTER_MODELS = "{not json";
      process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const models = await listAdapterModels("opencode_local");
      expect(models).toEqual(opencodeFallbackModels);

      // Parsing is memoized per raw value: a second call must not re-log.
      const callsAfterFirst = errorSpy.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);
      await listAdapterModels("opencode_local");
      expect(errorSpy.mock.calls.length).toBe(callsAfterFirst);
    });

    it("ignores declared models for adapters not in the map", async () => {
      process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
        opencode_local: [{ id: "model-a" }],
      });
      const models = await listAdapterModels("codex_local");
      expect(models).toEqual(codexFallbackModels);
    });
  });
});
