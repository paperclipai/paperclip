import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as claudeFallbackModels } from "@paperclipai/adapter-claude-local";
import {
  isBedrockModelUsableInConfiguredRegion,
  resetClaudeModelsCacheForTests,
} from "@paperclipai/adapter-claude-local/server";
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
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
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
    expect(models.some((model) => model.id === "claude-fable-5")).toBe(true);
    expect(models.some((model) => model.id === "claude-mythos-5")).toBe(true);
    // Opus 5 is a current GA flagship and must be offered even when live discovery is unavailable.
    expect(models.some((model) => model.id === "claude-opus-5")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("offers us-prefixed Bedrock inference profiles in a us region", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_REGION = "us-east-1";

    const models = await listAdapterModels("claude_local");

    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.id.startsWith("us.anthropic."))).toBe(true);
  });

  it("offers eu-prefixed Bedrock inference profiles in an eu region", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_REGION = "eu-west-1";

    const models = await listAdapterModels("claude_local");

    expect(models.length).toBeGreaterThan(0);
    // Every offered profile must exist in the configured region, so none may be us-prefixed.
    expect(models.some((model) => model.id.startsWith("us.anthropic."))).toBe(false);
    expect(models.every((model) => model.id.startsWith("eu.anthropic."))).toBe(true);
    expect(models.some((model) => model.id === "eu.anthropic.claude-sonnet-5")).toBe(true);
    // Version suffixes diverge between families: Sonnet 4.5 is -v1:0 in eu, -v2:0 in us,
    // so a prefix rewrite of the us catalogue would produce an invalid id here.
    expect(models.some((model) => model.id === "eu.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(true);
  });

  it("falls back to the us Bedrock catalogue when no region is configured", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";

    const models = await listAdapterModels("claude_local");

    expect(models.every((model) => model.id.startsWith("us.anthropic."))).toBe(true);
  });

  it("offers residency-specific profiles in regions that publish their own family", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_REGION = "ap-southeast-2";

    const sydney = await listAdapterModels("claude_local");

    expect(sydney.length).toBeGreaterThan(0);
    expect(sydney.every((model) => model.id.startsWith("au.anthropic."))).toBe(true);

    process.env.AWS_REGION = "ap-northeast-1";
    resetClaudeModelsCacheForTests();
    const tokyo = await listAdapterModels("claude_local");

    expect(tokyo.length).toBeGreaterThan(0);
    expect(tokyo.every((model) => model.id.startsWith("jp.anthropic."))).toBe(true);
  });

  it("falls back to global profiles in a configured region with no verified family", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    // Singapore publishes no current residency-specific family: `apac.` carries only Claude 3.x
    // profiles, and us-prefixed profiles do not exist there at all.
    process.env.AWS_REGION = "ap-southeast-1";

    const models = await listAdapterModels("claude_local");

    expect(models.length).toBeGreaterThan(0);
    expect(models.some((model) => model.id.startsWith("us.anthropic."))).toBe(false);
    expect(models.every((model) => model.id.startsWith("global.anthropic."))).toBe(true);
    // The bundled Summarizer default must be resolvable here, or onboarding still fails.
    expect(models.some((model) => model.id.includes("claude-haiku-4-5"))).toBe(true);
  });

  describe("Bedrock profile region check", () => {
    it("rejects a profile from a family the configured region does not publish", () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      process.env.AWS_REGION = "us-east-1";

      expect(isBedrockModelUsableInConfiguredRegion("eu.anthropic.claude-sonnet-5")).toBe(false);
      expect(isBedrockModelUsableInConfiguredRegion("au.anthropic.claude-sonnet-5")).toBe(false);
      expect(isBedrockModelUsableInConfiguredRegion("jp.anthropic.claude-opus-4-8")).toBe(false);
    });

    it("accepts a profile from the configured region's own family", () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      process.env.AWS_REGION = "eu-west-1";
      expect(isBedrockModelUsableInConfiguredRegion("eu.anthropic.claude-sonnet-5")).toBe(true);

      process.env.AWS_REGION = "ap-southeast-2";
      expect(isBedrockModelUsableInConfiguredRegion("au.anthropic.claude-sonnet-5")).toBe(true);
      // Sydney also publishes the older `apac.` profiles.
      expect(isBedrockModelUsableInConfiguredRegion("apac.anthropic.claude-sonnet-4-20250514-v1:0")).toBe(true);
    });

    it("accepts global profiles in any region", () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      process.env.AWS_REGION = "us-east-1";

      // `global.` profiles are published in every region checked.
      expect(isBedrockModelUsableInConfiguredRegion("global.anthropic.claude-sonnet-5")).toBe(true);
    });

    it("compares an ARN's own region against the configured one", () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      process.env.AWS_REGION = "us-east-1";

      // Bedrock resolves a profile against the endpoint of the configured region, so an ARN from
      // another region does not resolve however fully the operator wrote it out.
      expect(
        isBedrockModelUsableInConfiguredRegion(
          "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/abc123",
        ),
      ).toBe(false);
      expect(
        isBedrockModelUsableInConfiguredRegion(
          "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123",
        ),
      ).toBe(true);
      // Case in an ARN is not significant to this comparison.
      expect(
        isBedrockModelUsableInConfiguredRegion(
          "arn:aws:bedrock:US-EAST-1:123456789012:application-inference-profile/abc123",
        ),
      ).toBe(true);
      // An ARN with no region names no region to disagree with.
      expect(
        isBedrockModelUsableInConfiguredRegion(
          "arn:aws:bedrock::123456789012:application-inference-profile/abc123",
        ),
      ).toBe(true);
    });

    it("accepts any profile when this process has no region evidence", () => {
      // No Bedrock env: this server may be storing setup for a worker whose region is unknown here.
      process.env.AWS_REGION = "us-east-1";
      expect(isBedrockModelUsableInConfiguredRegion("eu.anthropic.claude-sonnet-5")).toBe(true);

      // Bedrock env, but no configured region to compare against.
      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      delete process.env.AWS_REGION;
      expect(isBedrockModelUsableInConfiguredRegion("eu.anthropic.claude-sonnet-5")).toBe(true);
    });

    it("accepts an unrecognised family and rejects a non-Bedrock id", () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      process.env.AWS_REGION = "us-east-1";

      // A family this build does not know about cannot be shown to be wrong.
      expect(isBedrockModelUsableInConfiguredRegion("mx.anthropic.claude-sonnet-5")).toBe(true);
      expect(isBedrockModelUsableInConfiguredRegion("claude-sonnet-5")).toBe(false);
    });

    it("judges an explicit env instead of process.env", () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      process.env.AWS_REGION = "us-east-1";

      // An agent's adapterConfig.env overlays process.env at execution, so the caller passes the
      // environment the model will run under.
      const agentEnv = { ...process.env, AWS_REGION: "eu-west-1" };
      expect(isBedrockModelUsableInConfiguredRegion("eu.anthropic.claude-sonnet-5", agentEnv)).toBe(true);
      expect(isBedrockModelUsableInConfiguredRegion("us.anthropic.claude-opus-4-6-v1", agentEnv)).toBe(false);

      // An env that turns Bedrock off carries no region evidence at all.
      expect(
        isBedrockModelUsableInConfiguredRegion("eu.anthropic.claude-sonnet-5", { AWS_REGION: "us-east-1" }),
      ).toBe(true);
    });

    it("reads AWS_DEFAULT_REGION when AWS_REGION is unset", () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      process.env.AWS_DEFAULT_REGION = "eu-west-1";

      expect(isBedrockModelUsableInConfiguredRegion("eu.anthropic.claude-sonnet-5")).toBe(true);
      expect(isBedrockModelUsableInConfiguredRegion("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(false);
    });
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
