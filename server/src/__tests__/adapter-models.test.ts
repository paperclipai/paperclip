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
    expect(models).toContainEqual({ id: "claude-opus-5-5", label: "Claude Opus 5.5" });
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
    expect(first.some((model) => model.id === "claude-opus-5-5")).toBe(true);
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

  it.each([
    ["claude-fable-5-1", "Claude Fable 5.1"],
    ["claude-opus-5-5", "Claude Opus 5.5"],
  ])("does not duplicate %s when discovery returns the identical ID", async (id, displayName) => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id, display_name: displayName }],
      }),
    } as Response);

    const models = await listAdapterModels("claude_local");

    expect(models.filter((model) => model.id === id)).toEqual([{ id, label: displayName }]);
    // Curated fallbacks discovery did not return are still merged in.
    expect(models.some((model) => model.id === "claude-fable-5")).toBe(true);
    expect(models.some((model) => model.id === "claude-opus-4-8")).toBe(true);
  });

  it("exposes the Bedrock-native Fable 5.1 ID (never the direct ID) in Bedrock mode", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const models = await listAdapterModels("claude_local");

    // Keep Opus 4.8 first, using its documented dateless Bedrock ID.
    expect(models[0]?.id).toBe("us.anthropic.claude-opus-4-8");
    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "us.anthropic.claude-opus-5-5", "us.anthropic.claude-opus-5", "us.anthropic.claude-sonnet-5",
      "us.anthropic.claude-fable-5-1", "us.anthropic.claude-opus-4-7", "us.anthropic.claude-sonnet-4-6",
    ]));
    expect(models.map((model) => model.id)).not.toEqual(expect.arrayContaining(["us.anthropic.claude-opus-4-8-v1"]));
    expect(models.some((model) => model.id === "claude-fable-5-1")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["gemini_local", ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview"]],
    ["grok_local", ["grok-build", "grok-4.7", "grok-4.6", "grok-4.5"]],
    ["kimi_local", ["kimi-code/kimi-for-coding", "kimi-code/k3", "kimi-code/k3-256k"]],
  ])("lists current %s models without a provider login", async (adapter, expectedIds) => {
    const models = await listAdapterModels(adapter as string);
    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining(expectedIds as string[]));
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
    if (adapter === "gemini_local") {
      expect(models.some((model) => model.id.startsWith("gemini-2.0-"))).toBe(false);
    }
    if (adapter === "kimi_local") {
      expect(models).toContainEqual({ id: "kimi-code/kimi-for-coding", label: "K2.8 Preview" });
    }
  });

  it("includes current Cursor fallbacks when runtime discovery is unavailable", async () => {
    setCursorModelsRunnerForTests(() => ({ status: 1, stdout: "", stderr: "", hasError: true }));
    const models = await listAdapterModels("cursor");
    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "composer-2.5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5",
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "grok-4.7", "gemini-3.8-flash", "muse-spark-1.3",
    ]));
  });

  describe("agent-scoped discovery context", () => {
    const gatewayEnv = {
      ANTHROPIC_BASE_URL: "http://gateway.local:8317",
      ANTHROPIC_API_KEY: "sk-gateway",
    };

    // The route never hands an adapter an agent env without the egress-guarded
    // transport, and the adapter now refuses the pairing if it ever did. These
    // cases are about catalog shape rather than egress, so they supply a guard
    // that delegates to global `fetch` and let the spies below observe it.
    const guardedFetch = ((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch;
    const agentCtx = (env: Record<string, string>) => ({ env, fetch: guardedFetch });

    it("enumerates the agent's gateway when the server has no provider env", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: "kimi-k3", owned_by: "kimi" }],
        }),
      } as Response);

      // Without a context this falls back to the static list (no server env).
      expect(await listAdapterModels("claude_local")).toEqual(claudeFallbackModels);
      expect(fetchSpy).not.toHaveBeenCalled();

      const scoped = await listAdapterModels("claude_local", agentCtx(gatewayEnv));

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://gateway.local:8317/v1/models");
      expect(scoped).toEqual([{ id: "kimi-k3", label: "kimi-k3 (kimi)" }]);
    });

    it("prefers the OpenAI dialect for a custom gateway so upstreams keep canonical IDs", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "grok-4.6", owned_by: "xai" }] }),
      } as Response);

      await listAdapterModels("claude_local", agentCtx(gatewayEnv));

      const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer sk-gateway");
      expect(headers["x-api-key"]).toBeUndefined();
    });

    it("falls back to the Anthropic dialect when the gateway returns no OpenAI listing", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }] }),
        } as Response);

      const models = await listAdapterModels("claude_local", agentCtx(gatewayEnv));

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const headers = fetchSpy.mock.calls[1]?.[1]?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-gateway");
      expect(models).toEqual([{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }]);
    });

    it("does not append first-party Anthropic models a gateway cannot route", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "kimi-k3", owned_by: "kimi" }] }),
      } as Response);

      const models = await listAdapterModels("claude_local", agentCtx(gatewayEnv));

      expect(models.some((model) => model.id === "claude-opus-4-8")).toBe(false);
    });

    it("accepts ANTHROPIC_AUTH_TOKEN as the discovery credential", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "kimi-k3", owned_by: "kimi" }] }),
      } as Response);

      await listAdapterModels(
        "claude_local",
        agentCtx({ ANTHROPIC_BASE_URL: "http://gateway.local:8317", ANTHROPIC_AUTH_TOKEN: "tok-123" }),
      );

      const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer tok-123");
    });

    it("caches per base URL so two agents on different gateways do not collide", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ id: "kimi-k3", owned_by: "kimi" }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ id: "grok-4.6", owned_by: "xai" }] }),
        } as Response);

      const first = await listAdapterModels("claude_local", agentCtx(gatewayEnv));
      const second = await listAdapterModels(
        "claude_local",
        agentCtx({ ANTHROPIC_BASE_URL: "http://other.local:9000", ANTHROPIC_API_KEY: "sk-other" }),
      );
      // Re-reading the first gateway is served from cache, not a third fetch.
      const firstAgain = await listAdapterModels("claude_local", agentCtx(gatewayEnv));

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(first).toEqual([{ id: "kimi-k3", label: "kimi-k3 (kimi)" }]);
      expect(second).toEqual([{ id: "grok-4.6", label: "grok-4.6 (xai)" }]);
      expect(firstAgain).toEqual(first);
    });

    it("honours a Bedrock agent env without reaching the network", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const models = await listAdapterModels("claude_local", {
        env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      });

      expect(models[0]?.id).toBe("us.anthropic.claude-opus-4-8");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("never pairs an agent endpoint with the server's ambient credential", async () => {
      // The server holds a first-party Anthropic key; the agent names only a
      // gateway. Merging the two would post the server's key to that gateway.
      process.env.ANTHROPIC_API_KEY = "sk-ant-server";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "kimi-k3", owned_by: "kimi" }] }),
      } as Response);

      const models = await listAdapterModels(
        "claude_local",
        agentCtx({ ANTHROPIC_BASE_URL: "http://gateway.local:8317" }),
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(models).toEqual(claudeFallbackModels);
    });

    it("keeps the server's own Bedrock mode out of an agent's gateway scope", async () => {
      // Bedrock is read from the same scope as the endpoint, so a server-side
      // Bedrock switch must not shadow the agent's gateway catalog.
      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "kimi-k3", owned_by: "kimi" }] }),
      } as Response);

      const models = await listAdapterModels("claude_local", agentCtx(gatewayEnv));

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(models).toEqual([{ id: "kimi-k3", label: "kimi-k3 (kimi)" }]);
    });

    it("routes an agent-scoped request through the supplied guarded fetch", async () => {
      const plainFetch = vi.spyOn(globalThis, "fetch");
      const guarded = vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: "kimi-k3", owned_by: "kimi" }] }),
      } as Response));

      const models = await listAdapterModels("claude_local", {
        env: gatewayEnv,
        fetch: guarded as unknown as typeof fetch,
      });

      expect(guarded).toHaveBeenCalledTimes(1);
      expect(guarded.mock.calls[0]?.[0]).toBe("http://gateway.local:8317/v1/models");
      expect(plainFetch).not.toHaveBeenCalled();
      expect(models).toEqual([{ id: "kimi-k3", label: "kimi-k3 (kimi)" }]);
    });

    it("falls back to the built-in list when the guard rejects the endpoint", async () => {
      const guarded = vi.fn(async () => {
        throw new Error("Model discovery endpoint is not allowed to reach a private address");
      });

      const models = await listAdapterModels("claude_local", {
        env: { ANTHROPIC_BASE_URL: "http://169.254.169.254", ANTHROPIC_API_KEY: "sk-gateway" },
        fetch: guarded as unknown as typeof fetch,
      });

      // Both dialects are attempted, and neither escapes the guard.
      expect(guarded).toHaveBeenCalledTimes(2);
      expect(models).toEqual(claudeFallbackModels);
    });

    it("refuses an agent gateway when no guarded fetch accompanies the agent env", async () => {
      // The route always supplies the guard. If some other caller does not, the
      // credential must not reach a caller-named host over plain fetch.
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "kimi-k3", owned_by: "kimi" }] }),
      } as Response);

      const models = await listAdapterModels("claude_local", { env: gatewayEnv });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(models).toEqual(claudeFallbackModels);
    });

    it("still discovers Anthropic's own API without a guarded fetch", async () => {
      // Only a caller-named gateway needs the guard. The first-party endpoint is
      // a constant in this file, so an agent that supplies just a key still works.
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }] }),
      } as Response);

      const models = await listAdapterModels("claude_local", { env: { ANTHROPIC_API_KEY: "sk-ant-agent" } });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/models");
      expect(models.some((model) => model.id === "claude-sonnet-4-6")).toBe(true);
    });

    it.each([
      ["a non-HTTP scheme", "file:///etc/passwd"],
      ["userinfo in the authority", "http://user:pass@gateway.local:8317"],
    ])("never sends the credential to an endpoint with %s", async (_label, baseUrl) => {
      const guarded = vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: "kimi-k3", owned_by: "kimi" }] }),
      } as Response));

      const models = await listAdapterModels("claude_local", {
        env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "sk-gateway" },
        fetch: guarded as unknown as typeof fetch,
      });

      expect(guarded).not.toHaveBeenCalled();
      expect(models).toEqual(claudeFallbackModels);
    });

    it("bounds the cache instead of retaining every historical gateway", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "kimi-k3", owned_by: "kimi" }] }),
      } as Response);

      // One more distinct endpoint than the cache holds, so the first is evicted.
      for (let index = 0; index < 33; index += 1) {
        await listAdapterModels(
          "claude_local",
          agentCtx({ ANTHROPIC_BASE_URL: `http://gateway-${index}.local`, ANTHROPIC_API_KEY: "sk-gateway" }),
        );
      }
      expect(fetchSpy).toHaveBeenCalledTimes(33);

      fetchSpy.mockClear();
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "grok-4.6", owned_by: "xai" }] }),
      } as Response);

      // The evicted endpoint re-fetches rather than serving a catalog the cache
      // should no longer be holding.
      const evicted = await listAdapterModels(
        "claude_local",
        agentCtx({ ANTHROPIC_BASE_URL: "http://gateway-0.local", ANTHROPIC_API_KEY: "sk-gateway" }),
      );
      // The most recent endpoint is still cached, so it does not re-fetch.
      const retained = await listAdapterModels(
        "claude_local",
        agentCtx({ ANTHROPIC_BASE_URL: "http://gateway-32.local", ANTHROPIC_API_KEY: "sk-gateway" }),
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(evicted).toEqual([{ id: "grok-4.6", label: "grok-4.6 (xai)" }]);
      expect(retained).toEqual([{ id: "kimi-k3", label: "kimi-k3 (kimi)" }]);
    });
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

  it("returns current provider-qualified OpenCode models when discovery is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    const models = await listAdapterModels("opencode_local");

    expect(models).toEqual(opencodeFallbackModels);
    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining(["openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-luna", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna", "anthropic/claude-opus-5-5", "anthropic/claude-opus-5", "anthropic/claude-fable-5-1", "anthropic/claude-sonnet-5", "google/gemini-3.8-flash", "xai/grok-4.7"]));
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
