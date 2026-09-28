import { describe, expect, it } from "vitest";
import {
  AI_CONNECTION_CAPABILITIES,
  isAiConnectionCompatible,
  ZAI_ANTHROPIC_BASE_URL,
  ZAI_DEFAULT_MODEL,
  ZAI_FAST_MODEL,
} from "@paperclipai/shared";
import { applyZaiRuntimeRouting } from "../services/ai-connection-runtime.js";

describe("applyZaiRuntimeRouting", () => {
  it("routes the Claude Code runtime at the Z.AI endpoint with GLM defaults", () => {
    const env: Record<string, unknown> = {};
    applyZaiRuntimeRouting(env, {});
    expect(env.ANTHROPIC_BASE_URL).toBe(ZAI_ANTHROPIC_BASE_URL);
    expect(env.ANTHROPIC_MODEL).toBe(ZAI_DEFAULT_MODEL);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(ZAI_FAST_MODEL);
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(ZAI_DEFAULT_MODEL);
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(ZAI_DEFAULT_MODEL);
  });

  it("keeps an explicit agent model over the GLM default", () => {
    const env: Record<string, unknown> = {};
    applyZaiRuntimeRouting(env, { model: "glm-5.3-flash" });
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(ZAI_DEFAULT_MODEL);

    const legacyStringBinding: Record<string, unknown> = {};
    applyZaiRuntimeRouting(legacyStringBinding, {
      env: { ANTHROPIC_MODEL: "glm-5.3-flash[1m]" },
    });
    expect(legacyStringBinding.ANTHROPIC_MODEL).toBeUndefined();

    const plainBinding: Record<string, unknown> = {};
    applyZaiRuntimeRouting(plainBinding, {
      env: { ANTHROPIC_MODEL: { type: "plain", value: "glm-5.3-flash[1m]" } },
    });
    expect(plainBinding.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("replaces a claude-* model with the GLM default because Z.AI rejects it", () => {
    const fromConfigModel: Record<string, unknown> = {};
    applyZaiRuntimeRouting(fromConfigModel, { model: "claude-opus-5" });
    expect(fromConfigModel.ANTHROPIC_MODEL).toBe(ZAI_DEFAULT_MODEL);

    const fromEnvBinding: Record<string, unknown> = {};
    applyZaiRuntimeRouting(fromEnvBinding, {
      env: { ANTHROPIC_MODEL: { type: "plain", value: "claude-sonnet-4-6" } },
    });
    expect(fromEnvBinding.ANTHROPIC_MODEL).toBe(ZAI_DEFAULT_MODEL);
  });
});

describe("zai AI connection capability", () => {
  it("supports API keys for the Claude Code adapter only", () => {
    const capability = AI_CONNECTION_CAPABILITIES.zai;
    expect(capability.methods.api_key?.adapters).toEqual(["claude_local"]);
    expect(capability.methods.subscription).toBeUndefined();
  });

  it("is compatible with claude_local agents and nothing else", () => {
    const binding = {
      provider: "zai",
      method: "api_key",
      mode: "responsible_user",
    } as const;
    expect(isAiConnectionCompatible(binding, "claude_local")).toBe(true);
    expect(isAiConnectionCompatible(binding, "codex_local")).toBe(false);
    expect(isAiConnectionCompatible(binding, "opencode_local")).toBe(false);
    expect(isAiConnectionCompatible(binding, "grok_local")).toBe(false);
  });
});
