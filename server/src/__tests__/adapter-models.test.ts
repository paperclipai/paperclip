import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as claudeFallbackModels } from "@paperclipai/adapter-claude-local";
import { resetClaudeModelsCacheForTests } from "@paperclipai/adapter-claude-local/server";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import { models as opencodeFallbackModels } from "@paperclipai/adapter-opencode-local";
import { resetOpenCodeModelsCacheForTests } from "@paperclipai/adapter-opencode-local/server";
import { resolveManagedCodexHomeDir } from "@paperclipai/adapter-codex-local/server";
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
  let codexHomeDir: string;
  let previousCodexHome: string | undefined;
  let paperclipHomeDir: string;
  let previousPaperclipHome: string | undefined;

  beforeEach(async () => {
    // Point CODEX_HOME at an empty directory so these tests never read whatever real Codex model
    // cache the host developer's machine happens to have.
    previousCodexHome = process.env.CODEX_HOME;
    codexHomeDir = await mkdtemp(path.join(tmpdir(), "paperclip-codex-home-"));
    process.env.CODEX_HOME = codexHomeDir;
    // Likewise for PAPERCLIP_HOME, which company-scoped managed-home discovery resolves under.
    previousPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHomeDir = await mkdtemp(path.join(tmpdir(), "paperclip-home-"));
    process.env.PAPERCLIP_HOME = paperclipHomeDir;
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

  afterEach(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(codexHomeDir, { recursive: true, force: true });
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    await rm(paperclipHomeDir, { recursive: true, force: true });
  });

  async function writeCodexModelsCache(payload: unknown): Promise<void> {
    await writeFile(
      path.join(codexHomeDir, "models_cache.json"),
      typeof payload === "string" ? payload : JSON.stringify(payload),
      "utf8",
    );
  }

  async function writeManagedCodexModelsCache(companyId: string, payload: unknown): Promise<void> {
    const managedHomeDir = resolveManagedCodexHomeDir(process.env, companyId);
    await mkdir(managedHomeDir, { recursive: true });
    await writeFile(
      path.join(managedHomeDir, "models_cache.json"),
      typeof payload === "string" ? payload : JSON.stringify(payload),
      "utf8",
    );
  }

  it("returns an empty list for unknown adapters", async () => {
    const models = await listAdapterModels("unknown_adapter");
    expect(models).toEqual([]);
  });

  it("does not expose models for the retired acpx_local tombstone", () => {
    const adapter = listServerAdapters().find((candidate) => candidate.type === "acpx_local");

    expect(adapter?.models).toEqual([]);
  });

  it("returns codex fallback models when no OpenAI key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
    // The bare gpt-5.6 alias is intentionally not advertised (Codex has no metadata for it).
    expect(models.some((model) => model.id === "gpt-5.6")).toBe(false);
    expect(models.some((model) => model.id === "gpt-5.6-sol")).toBe(true);
    expect(models.some((model) => model.id === "gpt-5.6-terra")).toBe(true);
    expect(models.some((model) => model.id === "gpt-5.6-luna")).toBe(true);
    expect(models.some((model) => model.id === "gpt-5.3-codex-spark")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns claude fallback models including the latest Opus alias when no Anthropic key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("claude_local");

    expect(models).toEqual(claudeFallbackModels);
    expect(models.some((model) => model.id === "claude-opus-4-8")).toBe(true);
    // Newer flagship models are offered, but Opus 4.8 stays the default (first) option.
    expect(models[0]?.id).toBe("claude-opus-4-8");
    expect(models.some((model) => model.id === "claude-sonnet-5")).toBe(true);
    expect(models.some((model) => model.id === "claude-fable-5-1")).toBe(true);
    expect(models.some((model) => model.id === "claude-fable-5")).toBe(true);
    expect(models.some((model) => model.id === "claude-mythos-5")).toBe(true);
    // Opus 5 is a current GA flagship and must be offered even when live discovery is unavailable.
    expect(models.some((model) => model.id === "claude-opus-5")).toBe(true);
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

  it("does not duplicate claude-fable-5-1 when discovery returns the identical ID", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "claude-fable-5-1", display_name: "Claude Fable 5.1" }],
      }),
    } as Response);

    const models = await listAdapterModels("claude_local");

    expect(models.filter((model) => model.id === "claude-fable-5-1")).toHaveLength(1);
    // Curated fallbacks discovery did not return are still merged in.
    expect(models.some((model) => model.id === "claude-fable-5")).toBe(true);
    expect(models.some((model) => model.id === "claude-opus-4-8")).toBe(true);
  });

  it("exposes the Bedrock-native Fable 5.1 ID (never the direct ID) in Bedrock mode", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const models = await listAdapterModels("claude_local");

    // The Bedrock default (first entry) is unchanged.
    expect(models[0]?.id).toBe("us.anthropic.claude-opus-4-8-v1");
    expect(models.some((model) => model.id === "us.anthropic.claude-fable-5-1")).toBe(true);
    expect(models.some((model) => model.id === "claude-fable-5-1")).toBe(false);
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
          data: [{ id: "gpt-5.6-terra" }],
        }),
      } as Response);

    const initial = await listAdapterModels("codex_local");
    const refreshed = await refreshAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(initial.some((model) => model.id === "gpt-5")).toBe(true);
    expect(refreshed.some((model) => model.id === "gpt-5.6-terra")).toBe(true);
    expect(refreshed.some((model) => model.id === "gpt-5.6-luna")).toBe(true);
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

  it("discovers codex models from the Codex CLI model cache without an OpenAI key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await writeCodexModelsCache({
      client_version: "0.153.4",
      models: [
        { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" },
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" },
      ],
    });

    const models = await listAdapterModels("codex_local");

    expect(models.some((model) => model.id === "gpt-6-astra")).toBe(true);
    // The cache's own display name wins over the static entry's bare slug label.
    expect(models.find((model) => model.id === "gpt-6-astra")?.label).toBe("GPT-6-Astra");
    // Static entries the cache omits are still merged in, so nothing disappears from the picker.
    expect(models.some((model) => model.id === "codex-mini-latest")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("omits codex models the CLI hides from its own picker", async () => {
    await writeCodexModelsCache({
      models: [
        { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" },
        { slug: "gpt-reserve", display_name: "Reserve", visibility: "hide" },
        { slug: "codex-auto-review", display_name: "Auto Review", visibility: "hide" },
      ],
    });

    const models = await listAdapterModels("codex_local");

    expect(models.some((model) => model.id === "gpt-6-astra")).toBe(true);
    expect(models.some((model) => model.id === "gpt-reserve")).toBe(false);
    expect(models.some((model) => model.id === "codex-auto-review")).toBe(false);
  });

  it("prefers the Codex CLI model cache over the OpenAI models API", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await writeCodexModelsCache({
      models: [{ slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" }],
    });

    const models = await listAdapterModels("codex_local");

    expect(models.some((model) => model.id === "gpt-6-astra")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-reads the Codex CLI model cache on refresh", async () => {
    await writeCodexModelsCache({
      models: [{ slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" }],
    });
    const initial = await listAdapterModels("codex_local");
    expect(initial.some((model) => model.id === "gpt-7-nova")).toBe(false);

    await writeCodexModelsCache({
      models: [{ slug: "gpt-7-nova", display_name: "GPT-7-Nova", visibility: "list" }],
    });
    const refreshed = await refreshAdapterModels("codex_local");

    expect(refreshed.some((model) => model.id === "gpt-7-nova")).toBe(true);
  });

  it("falls back to static codex models when the Codex CLI model cache is malformed", async () => {
    await writeCodexModelsCache("{ not json");

    const models = await listAdapterModels("codex_local");
    expect(models).toEqual(codexFallbackModels);
  });

  it("prefers the company-managed Codex home cache over the shared host Codex home", async () => {
    await writeCodexModelsCache({
      models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" }],
    });
    await writeManagedCodexModelsCache("company-1", {
      models: [{ slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" }],
    });

    const models = await listAdapterModels("codex_local", "company-1");

    expect(models.some((model) => model.id === "gpt-6-astra")).toBe(true);
  });

  it("falls back to the shared host Codex home when the company has no managed cache yet", async () => {
    await writeCodexModelsCache({
      models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" }],
    });
    // No managed cache written for "company-1" — its managed CODEX_HOME does not exist yet.

    const models = await listAdapterModels("codex_local", "company-1");

    expect(models.some((model) => model.id === "gpt-5.6-sol")).toBe(true);
  });

  it("falls back to static codex models when the Codex CLI model cache lists nothing usable", async () => {
    await writeCodexModelsCache({ models: [{ slug: "", visibility: "list" }, { visibility: "list" }] });

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
