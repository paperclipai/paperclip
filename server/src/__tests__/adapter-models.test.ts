import { beforeEach, describe, expect, it, vi } from "vitest";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import { models as kiroFallbackModels } from "@paperclipai/adapter-kiro-local";
import { resetOpenCodeModelsCacheForTests } from "@paperclipai/adapter-opencode-local/server";
import { resetKiroModelsCacheForTests, setKiroModelsRunnerForTests, parseKiroModelsOutput } from "@paperclipai/adapter-kiro-local/server";
import { listAdapterModels } from "../adapters/index.js";
import { resetCodexModelsCacheForTests } from "../adapters/codex-models.js";
import { resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../adapters/cursor-models.js";

describe("adapter model listing", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetCodexModelsCacheForTests();
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
    resetKiroModelsCacheForTests();
    setKiroModelsRunnerForTests(null);
    resetOpenCodeModelsCacheForTests();
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

  it("returns kiro fallback models when CLI discovery is unavailable", async () => {
    setKiroModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      hasError: true,
    }));

    const models = await listAdapterModels("kiro_local");
    expect(models).toEqual(kiroFallbackModels);
  });

  it("loads kiro models dynamically and caches them", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify(["auto", "claude-opus-4.6", "claude-sonnet-4.6", "new-model-x"]),
      stderr: "",
      hasError: false,
    }));
    setKiroModelsRunnerForTests(runner);

    const first = await listAdapterModels("kiro_local");
    const second = await listAdapterModels("kiro_local");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "auto")).toBe(true);
    expect(first.some((model) => model.id === "claude-opus-4.6")).toBe(true);
    expect(first.some((model) => model.id === "new-model-x")).toBe(true);
    // Fallback models are merged in
    expect(first.some((model) => model.id === "claude-haiku-4.5")).toBe(true);
  });

  it("falls back to static kiro models when CLI returns non-zero exit", async () => {
    setKiroModelsRunnerForTests(() => ({
      status: 1,
      stdout: "",
      stderr: "kiro-cli: unknown flag --list-models",
      hasError: false,
    }));

    const models = await listAdapterModels("kiro_local");
    expect(models).toEqual(kiroFallbackModels);
  });

  it("returns no opencode models when opencode command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    const models = await listAdapterModels("opencode_local");
    expect(models).toEqual([]);
  });
});

describe("parseKiroModelsOutput", () => {
  it("parses a JSON array of model ID strings", () => {
    const stdout = JSON.stringify(["auto", "claude-opus-4.6", "claude-sonnet-4.5"]);
    const models = parseKiroModelsOutput(stdout);
    expect(models).toEqual([
      { id: "auto", label: "auto" },
      { id: "claude-opus-4.6", label: "claude-opus-4.6" },
      { id: "claude-sonnet-4.5", label: "claude-sonnet-4.5" },
    ]);
  });

  it("parses a JSON array of model objects with id/label", () => {
    const stdout = JSON.stringify([
      { id: "auto", label: "Auto" },
      { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
    ]);
    const models = parseKiroModelsOutput(stdout);
    expect(models).toEqual([
      { id: "auto", label: "Auto" },
      { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
    ]);
  });

  it("parses a JSON object with a models field", () => {
    const stdout = JSON.stringify({ models: ["auto", "deepseek-3.2"] });
    const models = parseKiroModelsOutput(stdout);
    expect(models).toEqual([
      { id: "auto", label: "auto" },
      { id: "deepseek-3.2", label: "deepseek-3.2" },
    ]);
  });

  it("deduplicates model IDs", () => {
    const stdout = JSON.stringify(["auto", "auto", "claude-sonnet-4.5"]);
    const models = parseKiroModelsOutput(stdout);
    expect(models).toEqual([
      { id: "auto", label: "auto" },
      { id: "claude-sonnet-4.5", label: "claude-sonnet-4.5" },
    ]);
  });

  it("returns empty array for empty stdout", () => {
    expect(parseKiroModelsOutput("")).toEqual([]);
    expect(parseKiroModelsOutput("  ")).toEqual([]);
  });

  it("returns empty array for malformed JSON", () => {
    expect(parseKiroModelsOutput("not json at all")).toEqual([]);
  });
});
