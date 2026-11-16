import { describe, expect, it } from "vitest";
import {
  difficultyEffortConfigKey, difficultyRoutingSupported, difficultyTierAdapterConfig, hasManualModelOrEffortOverride, issueDifficultyRoutingSchema,
  readDifficultyRoutingConfig,
} from "./difficulty-routing.js";
import { agentRuntimeConfigSchema } from "./validators/agent.js";

describe("difficulty routing contract", () => {
  it("maps effort to each adapter's own config key", () => {
    expect(difficultyEffortConfigKey("claude_local")).toBe("effort");
    expect(difficultyEffortConfigKey("codex_local")).toBe("modelReasoningEffort");
    expect(difficultyEffortConfigKey("paperclip_runner")).toBe("modelReasoningEffort");
    expect(difficultyEffortConfigKey("grok_local")).toBe("reasoningEffort");
    expect(difficultyEffortConfigKey("opencode_local")).toBe("variant");
    expect(difficultyEffortConfigKey("http")).toBeNull();
    expect(difficultyTierAdapterConfig("claude_local", { model: "opus", effort: "high" })).toEqual({ model: "opus", effort: "high" });
    expect(difficultyTierAdapterConfig("http", { model: "m", effort: "high" })).toEqual({ model: "m" });
    expect(difficultyTierAdapterConfig("codex_local", undefined)).toEqual({});
  });

  it("supports only runtimes that apply task model and effort overrides", () => {
    expect(difficultyRoutingSupported("claude_local", {})).toBe(true);
    expect(difficultyRoutingSupported("http", {})).toBe(false);
    expect(difficultyRoutingSupported("paperclip_runner", {})).toBe(true);
    expect(difficultyRoutingSupported("paperclip_runner", { provider: "acpx" })).toBe(true);
    expect(difficultyRoutingSupported("paperclip_runner", { provider: "acpx", acpxAgent: "grok" })).toBe(true);
    expect(difficultyRoutingSupported("paperclip_runner", { provider: "acpx", acpxAgent: "pi" })).toBe(false);
    expect(difficultyRoutingSupported("paperclip_runner", { provider: "acpx", acpxAgent: "codex" })).toBe(false);
    expect(difficultyRoutingSupported("paperclip_runner", { provider: "claude_managed" })).toBe(false);
  });

  it("treats only model and effort keys as a manual override", () => {
    expect(hasManualModelOrEffortOverride({ chrome: true })).toBe(false);
    expect(hasManualModelOrEffortOverride({ model: " " })).toBe(false);
    expect(hasManualModelOrEffortOverride({ effort: "low" })).toBe(true);
    expect(hasManualModelOrEffortOverride(null)).toBe(false);
  });

  it("validates the agent runtime setting and reads it only when enabled", () => {
    const value = { enabled: true, tiers: { L2: { model: "m", effort: "medium" } } };
    expect(agentRuntimeConfigSchema.safeParse({ difficultyRouting: value }).success).toBe(true);
    expect(agentRuntimeConfigSchema.safeParse({ difficultyRouting: { enabled: true, tiers: { L4: {} } } }).success).toBe(false);
    expect(readDifficultyRoutingConfig({ difficultyRouting: value })).toEqual(value);
    expect(readDifficultyRoutingConfig({ difficultyRouting: { ...value, enabled: false } })).toBeNull();
    expect(readDifficultyRoutingConfig({})).toBeNull();
  });

  it("records which classifier rated an automatic tier and accepts older rows without it", () => {
    const routing = { tier: "L2", source: "auto", agentId: null, model: null, effort: null, confidence: null,
      decidedAt: "2026-11-16T00:00:00.000Z", decisionInvocationId: null };
    expect(issueDifficultyRoutingSchema.safeParse(routing).success).toBe(true);
    expect(issueDifficultyRoutingSchema.safeParse({ ...routing, classifier: "agent_cli" }).success).toBe(true);
    expect(issueDifficultyRoutingSchema.safeParse({ ...routing, classifier: "guess" }).success).toBe(false);
  });
});
