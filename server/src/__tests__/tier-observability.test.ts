import { describe, expect, it } from "vitest";

import type {
  AdapterFailoverEvent,
  AdapterInvocationMeta,
  AdapterTierTransition,
} from "@paperclipai/adapter-utils";
import {
  type TierAwareResult,
  buildInvocationRecord,
  extractTierFromMeta,
  extractTierSignal,
  recordInvocation,
} from "../services/tier-observability.js";
import type {
  AgentInvocationRecord,
  ObservabilityStore,
} from "../services/observability-store.js";

function mockStore(): ObservabilityStore & { rows: AgentInvocationRecord[] } {
  const rows: AgentInvocationRecord[] = [];
  return {
    enabled: true,
    dbPath: ":memory:",
    rows,
    recordInvocation(record) {
      rows.push(record);
    },
    queryTierMix: () => [],
    queryTier1CostSince: () => 0,
    close: () => undefined,
  };
}

// Local widening: dist `AdapterInvocationMeta` doesn't yet expose the
// ROCAA-19 `authSource` field (only the in-tree source does).
type WideMeta = AdapterInvocationMeta & {
  authSource?: "subscription" | "api" | "metered_api";
};

function baseMeta(overrides: Partial<WideMeta> = {}): WideMeta {
  return {
    adapterType: "claude_local",
    command: "/usr/local/bin/claude",
    authSource: "subscription",
    ...overrides,
  };
}

describe("extractTierFromMeta", () => {
  it("defaults to Tier 0 with no transitions when meta is silent", () => {
    expect(extractTierFromMeta({ context: {} })).toEqual({
      tierUsed: 0,
      tierTransitions: [],
    });
    expect(extractTierFromMeta({})).toEqual({ tierUsed: 0, tierTransitions: [] });
  });

  it("reads numeric tier and clamps to 0..4", () => {
    expect(extractTierFromMeta({ context: { tier: 2 } }).tierUsed).toBe(2);
    expect(extractTierFromMeta({ context: { tier: 9 } }).tierUsed).toBe(4);
    expect(extractTierFromMeta({ context: { tier: -3 } }).tierUsed).toBe(0);
  });

  it("accepts string tier in '0'..'4'", () => {
    expect(extractTierFromMeta({ context: { tier: "1" } }).tierUsed).toBe(1);
    expect(extractTierFromMeta({ context: { tier: "x" } }).tierUsed).toBe(0);
  });

  it("normalizes transitions (both camelCase and snake_case keys)", () => {
    expect(
      extractTierFromMeta({
        context: {
          tierTransitions: [
            { tier: 0, errorReason: "rate-limit" },
            { tier: 1, error_reason: "outage" },
            "garbage",
            { tier: 99, errorReason: "clamped" },
          ],
        },
      }),
    ).toEqual({
      tierUsed: 0,
      tierTransitions: [
        { tier: 0, errorReason: "rate-limit" },
        { tier: 1, errorReason: "outage" },
        { tier: 4, errorReason: "clamped" },
      ],
    });
  });

  it("truncates oversized errorReason strings", () => {
    const long = "x".repeat(2000);
    const { tierTransitions } = extractTierFromMeta({
      context: { tierTransitions: [{ tier: 1, errorReason: long }] },
    });
    expect(tierTransitions[0]!.errorReason).toHaveLength(500);
  });
});

describe("buildInvocationRecord", () => {
  it("defaults missing fields and computes latency from start/end", () => {
    const record = buildInvocationRecord({
      store: mockStore(),
      meta: baseMeta(),
      agent: { id: "agent_1", companyId: "co_1", name: "Test Agent" },
      runId: "run_1",
      issueId: "iss_1",
      startedAt: new Date("2026-05-22T12:00:00Z"),
      endedAt: new Date("2026-05-22T12:00:01.250Z"),
    });
    expect(record).toMatchObject({
      adapterType: "claude_local",
      agentId: "agent_1",
      agentName: "Test Agent",
      issueId: "iss_1",
      runId: "run_1",
      tierUsed: 0,
      tierTransitions: [],
      costEstimateUsd: 0,
      latencyMs: 1250,
      tokensIn: null,
      tokensOut: null,
      tokensUsed: null,
      authSource: "subscription",
    });
    expect(record.recordedAt).toBe("2026-05-22T12:00:01.250Z");
  });

  it("sums tokensIn + tokensOut into tokensUsed when usage is present", () => {
    const record = buildInvocationRecord({
      store: mockStore(),
      meta: baseMeta(),
      agent: { id: "a", companyId: "c" },
      runId: "r",
      startedAt: new Date("2026-05-22T12:00:00Z"),
      endedAt: new Date("2026-05-22T12:00:00Z"),
      tokensIn: 100,
      tokensOut: 50,
      costEstimateUsd: 1.23,
    });
    expect(record.tokensUsed).toBe(150);
    expect(record.costEstimateUsd).toBe(1.23);
  });

  it("strips secrets from rawMeta — drops env/prompt/commandArgs", () => {
    const record = buildInvocationRecord({
      store: mockStore(),
      meta: baseMeta({
        env: { ANTHROPIC_API_KEY: "sk-leak" },
        prompt: "secret prompt",
        commandArgs: ["--api-key=sk-leak"],
        context: { tier: 1, model: "claude-opus-4-7" },
      }),
      agent: { id: "a", companyId: "c" },
      runId: "r",
      startedAt: new Date("2026-05-22T12:00:00Z"),
      endedAt: new Date("2026-05-22T12:00:00Z"),
    });
    const raw = JSON.stringify(record.rawMeta);
    expect(raw).not.toContain("sk-leak");
    expect(raw).not.toContain("secret prompt");
    expect(record.tierUsed).toBe(1);
    expect((record.rawMeta as { context: { model: string } }).context.model).toBe(
      "claude-opus-4-7",
    );
  });
});

describe("extractTierSignal (ROCAA-180)", () => {
  it("falls back to extractTierFromMeta when result has no tier signal", () => {
    expect(extractTierSignal(null, { context: { tier: 1 } })).toEqual({
      tierUsed: 1,
      tierTransitions: [],
    });
    expect(extractTierSignal(undefined, {})).toEqual({
      tierUsed: 0,
      tierTransitions: [],
    });
  });

  it("prefers result.tierUsed over meta.context.tier", () => {
    const result: TierAwareResult = { tierUsed: "tier_1_anthropic_sdk" };
    const signal = extractTierSignal(result, { context: { tier: 0 } });
    expect(signal.tierUsed).toBe(1);
    expect(signal.tierTransitions).toEqual([]);
  });

  it("translates result.tierTransitions[].to into numeric tier rows", () => {
    const transition: AdapterTierTransition = {
      at: "2026-05-24T12:00:00Z",
      from: "tier_0_claude_cli",
      to: "tier_1_anthropic_sdk",
      reason: "rate_limit",
      classifierMatch: "HTTP/429",
      fromExitCode: 1,
      fromParsed: false,
    };
    const signal = extractTierSignal(
      {
        tierUsed: "tier_1_anthropic_sdk",
        tierTransitions: [transition],
        classifierVersion: "1.0.0",
      },
      {},
    );
    expect(signal).toEqual({
      tierUsed: 1,
      tierTransitions: [{ tier: 1, errorReason: "rate_limit" }],
      classifierVersion: "1.0.0",
    });
  });

  it("synthesizes a transition row from meta.failoverEvent when result.tierTransitions is empty", () => {
    const failover: AdapterFailoverEvent = {
      at: "2026-05-24T12:00:00Z",
      from: "tier_0_claude_cli",
      to: "tier_1_anthropic_sdk",
      reason: "anthropic_5xx",
      classifierMatch: "HTTP/503",
      billerKeyName: "ANTHROPIC_API_KEY",
    };
    const signal = extractTierSignal(
      { tierUsed: "tier_1_anthropic_sdk" },
      { failoverEvent: failover },
    );
    expect(signal.tierUsed).toBe(1);
    expect(signal.tierTransitions).toEqual([
      { tier: 1, errorReason: "anthropic_5xx" },
    ]);
  });

  it("truncates classifierVersion to 64 chars", () => {
    const long = "v".repeat(200);
    const signal = extractTierSignal(
      { tierUsed: "tier_1_anthropic_sdk", classifierVersion: long },
      {},
    );
    expect(signal.classifierVersion).toHaveLength(64);
  });
});

describe("buildInvocationRecord (ROCAA-180 Tier 0→Tier 1)", () => {
  it("records the transition row + classifierVersion + failoverEvent for a Tier 0→Tier 1 result", () => {
    const failover: AdapterFailoverEvent = {
      at: "2026-05-24T12:00:00.500Z",
      from: "tier_0_claude_cli",
      to: "tier_1_anthropic_sdk",
      reason: "rate_limit",
      classifierMatch: "Anthropic 429",
      billerKeyName: "ANTHROPIC_API_KEY",
    };
    const transition: AdapterTierTransition = {
      at: failover.at,
      from: "tier_0_claude_cli",
      to: "tier_1_anthropic_sdk",
      reason: "rate_limit",
      classifierMatch: failover.classifierMatch,
      fromExitCode: 1,
      fromParsed: false,
    };
    const store = mockStore();
    const record = buildInvocationRecord({
      store,
      meta: baseMeta({
        // Even if context still claims tier 0, the result/failover should win.
        context: { tier: 0 },
        failoverEvent: failover,
      }),
      result: {
        tierUsed: "tier_1_anthropic_sdk",
        tierTransitions: [transition],
        classifierVersion: "claude-local/1.0.0",
      },
      agent: { id: "agent_1", companyId: "co_1", name: "Test Agent" },
      runId: "run_1",
      issueId: "iss_1",
      startedAt: new Date("2026-05-24T12:00:00Z"),
      endedAt: new Date("2026-05-24T12:00:02Z"),
      costEstimateUsd: 0.0123,
      tokensIn: 100,
      tokensOut: 200,
    });

    // Observability row contract — both the run-row equivalent (tier_used)
    // and the transition list are populated from the result + failoverEvent,
    // not from the silent `meta.context.tier = 0`.
    expect(record.tierUsed).toBe(1);
    expect(record.tierTransitions).toEqual([{ tier: 1, errorReason: "rate_limit" }]);
    expect(record.costEstimateUsd).toBe(0.0123);
    expect(record.tokensUsed).toBe(300);

    const raw = record.rawMeta as Record<string, unknown>;
    expect(raw["classifierVersion"]).toBe("claude-local/1.0.0");
    expect(raw["failoverEvent"]).toEqual(failover);

    // recordInvocation -> store wiring
    recordInvocation({
      store,
      meta: baseMeta({
        failoverEvent: failover,
      }),
      result: {
        tierUsed: "tier_1_anthropic_sdk",
        tierTransitions: [transition],
        classifierVersion: "claude-local/1.0.0",
      },
      agent: { id: "agent_1", companyId: "co_1" },
      runId: "run_2",
      startedAt: new Date("2026-05-24T12:00:00Z"),
      endedAt: new Date("2026-05-24T12:00:01Z"),
      costEstimateUsd: 0.01,
    });
    expect(store.rows.at(-1)).toMatchObject({
      runId: "run_2",
      tierUsed: 1,
      tierTransitions: [{ tier: 1, errorReason: "rate_limit" }],
    });
  });
});

describe("recordInvocation", () => {
  it("delegates to the store when enabled", () => {
    const store = mockStore();
    const ok = recordInvocation({
      store,
      meta: baseMeta(),
      agent: { id: "a", companyId: "c" },
      runId: "r",
      startedAt: new Date(),
      endedAt: new Date(),
    });
    expect(ok).toBe(true);
    expect(store.rows).toHaveLength(1);
  });

  it("returns false on a disabled store and does not throw", () => {
    const store: ObservabilityStore = {
      enabled: false,
      dbPath: null,
      recordInvocation: () => {
        throw new Error("should not be called");
      },
      queryTierMix: () => [],
      queryTier1CostSince: () => 0,
      close: () => undefined,
    };
    const ok = recordInvocation({
      store,
      meta: baseMeta(),
      agent: { id: "a", companyId: "c" },
      runId: "r",
      startedAt: new Date(),
      endedAt: new Date(),
    });
    expect(ok).toBe(false);
  });

  it("swallows store-side errors and returns false", () => {
    const store: ObservabilityStore = {
      enabled: true,
      dbPath: null,
      recordInvocation: () => {
        throw new Error("disk full");
      },
      queryTierMix: () => [],
      queryTier1CostSince: () => 0,
      close: () => undefined,
    };
    const ok = recordInvocation({
      store,
      meta: baseMeta(),
      agent: { id: "a", companyId: "c" },
      runId: "r",
      startedAt: new Date(),
      endedAt: new Date(),
    });
    expect(ok).toBe(false);
  });
});
