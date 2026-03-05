import { beforeEach, describe, expect, it, vi } from "vitest";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import { models as opencodeFallbackModels } from "@paperclipai/adapter-opencode-local";
import { listAdapterModels } from "../adapters/index.js";
import { resetCodexModelsCacheForTests } from "../adapters/codex-models.js";
import { resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../adapters/cursor-models.js";
import { resetOpenCodeModelsCacheForTests, setOpenCodeModelsRunnerForTests } from "../adapters/opencode-models.js";

describe("adapter model listing", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    resetCodexModelsCacheForTests();
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
    resetOpenCodeModelsCacheForTests();
    setOpenCodeModelsRunnerForTests(null);
    vi.restoreAllMocks();
  });

  it("returns an empty list for unknown adapters", async () => {
    const models = await listAdapterModels("unknown_adapter");
    expect(models).toEqual([]);
  });

  it("returns codex fallback models when no OpenAI key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("loads cursor models dynamically and caches them", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: "Available models: auto, composer-1.5, gpt-5.3-codex-high, sonnet-4.6",
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
    expect(first.some((model) => model.id === "composer-1")).toBe(true);
  });

  it("returns opencode fallback models when CLI discovery is unavailable", async () => {
    setOpenCodeModelsRunnerForTests(async () => ({
      status: null,
      stdout: "",
      stderr: "",
    }));

    const models = await listAdapterModels("opencode_local");
    expect(models).toEqual(opencodeFallbackModels);
  });

  it("loads opencode models dynamically and caches them", async () => {
    const runner = vi.fn(async () => ({
      status: 0,
      stdout: `opencode/minimax-m2.5-free
opencode-go/glm-5
opencode-go/kimi-k2.5
opencode-go/minimax-m2.5
github-copilot/claude-haiku-4.5
github-copilot/claude-opus-4.5`,
      stderr: "",
    }));
    setOpenCodeModelsRunnerForTests(runner);

    const first = await listAdapterModels("opencode_local");
    const second = await listAdapterModels("opencode_local");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "opencode-go/kimi-k2.5")).toBe(true);
    expect(first.some((model) => model.id === "github-copilot/claude-opus-4.5")).toBe(true);
    // Should include fallback models too
    const fallbackIds = new Set(opencodeFallbackModels.map((m) => m.id));
    expect(first.some((model) => fallbackIds.has(model.id))).toBe(true);
  });
});
