import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolveProviderForRun,
  buildRoutingLogEntry,
  getCircuitBreakerState,
  tripCircuitBreaker,
  resetCircuitBreaker,
  isCircuitBreakerTripped,
} from "../services/provider-routing.js";
import { buildDefaultPolicy } from "../services/provider-routing-policy.js";

describe("resolveProviderForRun", () => {
  const eligibleAgent = { name: "TrustScore", role: "qa", adapterConfig: {}, metadata: {} };
  const ineligibleAgent = { name: "Random", role: "engineer", adapterConfig: {}, metadata: {} };

  it("returns useOriginalAdapter when policy is disabled", () => {
    const policy = buildDefaultPolicy({ enabled: false, stage: 0 });
    const result = resolveProviderForRun(eligibleAgent, {}, "heartbeat_check", policy);
    expect(result.useOriginalAdapter).toBe(true);
    expect(result.decision.reason).toBe("kill_switch");
    expect(result.decision.precedenceLevel).toBe(2);
  });

  it("returns useOriginalAdapter for human override force_primary", () => {
    const policy = buildDefaultPolicy({ enabled: true, stage: 3 });
    const agent = { ...eligibleAgent, metadata: { providerRoutingOverride: "force_primary" } };
    const result = resolveProviderForRun(agent, {}, "heartbeat_check", policy);
    expect(result.useOriginalAdapter).toBe(true);
    expect(result.decision.reason).toBe("human_override:force_primary");
    expect(result.decision.precedenceLevel).toBe(1);
  });

  it("returns useOriginalAdapter when agent is ineligible", () => {
    const policy = buildDefaultPolicy({ enabled: true, stage: 3 });
    const result = resolveProviderForRun(ineligibleAgent, {}, "heartbeat_check", policy);
    expect(result.useOriginalAdapter).toBe(true);
    expect(result.decision.reason).toBe("agent_not_in_allowlist");
  });

  it("returns useOriginalAdapter when primary is available", () => {
    const policy = buildDefaultPolicy({ enabled: true, stage: 3 });
    const result = resolveProviderForRun(eligibleAgent, { errorCode: null }, "heartbeat_check", policy);
    expect(result.useOriginalAdapter).toBe(true);
    expect(result.decision.reason).toBe("primary_available");
    expect(result.decision.precedenceLevel).toBe(7);
  });

  it("returns useOriginalAdapter for hard-blocked context even if quota exhausted", () => {
    const policy = buildDefaultPolicy({ enabled: true, stage: 3 });
    const result = resolveProviderForRun(
      eligibleAgent,
      { errorCode: "claude_quota_exhausted", approvalId: "abc" },
      "heartbeat_check",
      policy,
    );
    expect(result.useOriginalAdapter).toBe(true);
    expect(result.decision.reason).toMatch(/context_hard_blocked/);
  });

  it("returns dry-run at stage 0 even with quota exhausted and eligible agent", () => {
    const policy = buildDefaultPolicy({ enabled: true, stage: 0 });
    // Manually set env for credentials check
    const origEnv = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    try {
      const result = resolveProviderForRun(
        eligibleAgent,
        { errorCode: "claude_quota_exhausted" },
        "heartbeat_check",
        policy,
      );
      expect(result.useOriginalAdapter).toBe(true);
      expect(result.decision.dryRun).toBe(true);
      expect(result.decision.reason).toBe("fallback_route_dry_run");
      expect(result.providerConfidence).toBe("emergency_fallback");
      expect(result.taskRiskClass).toBe("monitoring");
    } finally {
      if (origEnv === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = origEnv;
    }
  });

  it("returns no_fallback_credentials when env var is missing", () => {
    const policy = buildDefaultPolicy({ enabled: true, stage: 3 });
    const origEnv = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const result = resolveProviderForRun(
        eligibleAgent,
        { errorCode: "claude_quota_exhausted" },
        "heartbeat_check",
        policy,
      );
      expect(result.useOriginalAdapter).toBe(true);
      expect(result.decision.reason).toBe("no_fallback_credentials");
      expect(result.decision.precedenceLevel).toBe(8);
    } finally {
      if (origEnv !== undefined) process.env.OPENROUTER_API_KEY = origEnv;
    }
  });

  it("includes deterministic precedence labels for replayability", () => {
    const policy = buildDefaultPolicy({ enabled: true, stage: 3 });
    const result = resolveProviderForRun(ineligibleAgent, {}, "heartbeat_check", policy);
    expect(result.decision.precedenceLabel).toBeDefined();
    expect(typeof result.decision.precedenceLevel).toBe("number");
  });
});

describe("circuit breaker", () => {
  const providerId = "test-provider";

  beforeEach(() => {
    resetCircuitBreaker(providerId);
  });

  it("starts un-tripped", () => {
    expect(isCircuitBreakerTripped(providerId)).toBe(false);
  });

  it("trips and blocks", () => {
    tripCircuitBreaker(providerId, "test_failure", 60);
    expect(isCircuitBreakerTripped(providerId)).toBe(true);
    const state = getCircuitBreakerState(providerId);
    expect(state.tripped).toBe(true);
    expect(state.tripReason).toBe("test_failure");
  });

  it("resets after cooldown expires", () => {
    const now = new Date();
    tripCircuitBreaker(providerId, "test_failure", 1, now);
    // Fast-forward past cooldown
    const future = new Date(now.getTime() + 2 * 60_000);
    expect(isCircuitBreakerTripped(providerId, future)).toBe(false);
  });

  it("stays tripped during cooldown", () => {
    const now = new Date();
    tripCircuitBreaker(providerId, "test_failure", 60, now);
    const duringCooldown = new Date(now.getTime() + 30 * 60_000);
    expect(isCircuitBreakerTripped(providerId, duringCooldown)).toBe(true);
  });

  it("blocks routing when tripped", () => {
    const policy = buildDefaultPolicy({ enabled: true, stage: 3 });
    tripCircuitBreaker(policy.fallbackProvider.id, "test_failure", 60);
    const agent = { name: "TrustScore", role: "qa", adapterConfig: {}, metadata: {} };
    const result = resolveProviderForRun(
      agent,
      { errorCode: "claude_quota_exhausted" },
      "heartbeat_check",
      policy,
    );
    expect(result.useOriginalAdapter).toBe(true);
    expect(result.decision.reason).toBe("circuit_breaker_tripped");
    expect(result.decision.precedenceLevel).toBe(4);
    resetCircuitBreaker(policy.fallbackProvider.id);
  });
});

describe("buildRoutingLogEntry", () => {
  it("produces a deterministic log entry", () => {
    const policy = buildDefaultPolicy({ enabled: false, stage: 0 });
    const agent = { name: "TrustScore", role: "qa", adapterConfig: {}, metadata: {} };
    const decision = resolveProviderForRun(agent, {}, "heartbeat_check", policy);
    const entry = buildRoutingLogEntry(decision, agent);

    expect(entry.eventType).toBe("provider_routing.decision");
    expect(entry.agentName).toBe("TrustScore");
    expect(entry.agentRole).toBe("qa");
    expect(typeof entry.ts).toBe("string");
    expect(entry.stage).toBe(0);
    expect(entry.dryRun).toBe(true);
  });
});
