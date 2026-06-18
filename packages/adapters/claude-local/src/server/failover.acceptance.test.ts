import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  AdapterInvocationMeta,
  AdapterTierTransitionReason,
} from "@paperclipai/adapter-utils";

import {
  executeClaudeLocalWithFailover,
  type Tier0RawOutcome,
  type Tier0Runner,
  type Tier1Runner,
} from "./failover.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "classifier");

interface Fixture {
  name: string;
  input: {
    exitCode: number | null;
    stderr: string;
    stdout: string;
    parsed: Record<string, unknown> | null;
    timedOut: boolean;
  };
  expected: {
    recoverable: boolean;
    reason: AdapterTierTransitionReason | string;
    matchContains: string | null;
  };
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")) as Fixture;
}

function makeStubTier0(fixtureName: string): Tier0Runner {
  const fx = loadFixture(fixtureName);
  return {
    async runTier0(): Promise<Tier0RawOutcome> {
      return {
        proc: {
          exitCode: fx.input.exitCode,
          stderr: fx.input.stderr,
          stdout: fx.input.stdout,
          timedOut: fx.input.timedOut,
          signal: null,
          pid: null,
          startedAt: null,
        },
        parsedStream: {
          sessionId: null,
          usage: null,
          model: null,
          summary: null,
          costUsd: null,
          resultJson: fx.input.parsed,
        },
        parsed: fx.input.parsed,
      };
    },
  };
}

function makeStubTier1(opts: { ok: boolean } = { ok: true }): {
  runner: Tier1Runner;
  calls: number;
} {
  const state = { calls: 0 };
  const runner: Tier1Runner = {
    async runTier1() {
      state.calls += 1;
      if (opts.ok) {
        return {
          exitCode: 0,
          biller: "anthropic",
          billingType: "api_key",
          model: "claude-sonnet-4-6",
          summary: "tier 1 result",
          parsed: { type: "result", subtype: "success", result: "tier 1 result" },
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
          costUsd: 0,
        };
      }
      return {
        exitCode: 1,
        biller: "anthropic",
        billingType: "api_key",
        model: "claude-sonnet-4-6",
        summary: "",
        parsed: { type: "error", subtype: "tier1_sdk_error", message: "tier 1 itself rate-limited" },
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        costUsd: 0,
      };
    },
  };
  return {
    runner,
    get calls() {
      return state.calls;
    },
  } as { runner: Tier1Runner; calls: number };
}

const noopLog = async (_stream: "stdout" | "stderr", _chunk: string) => {};
const noopMeta = async (_meta: AdapterInvocationMeta) => {};

describe("executeClaudeLocalWithFailover — acceptance", () => {
  describe("fires Tier 1 on recoverable Tier 0 failure", () => {
    const recoverableFixtures = [
      "01-rate-limit-429",
      "03-token-refresh-transient",
      "05-econnreset-midstream",
      "06-etimedout-prestream",
      "07-fetch-failed-dns",
      "08-anthropic-529-overloaded",
      "09-anthropic-503",
      "10-malformed-json-exit0",
      "11-claude-cli-panic",
      "12-node-uncaught",
    ];

    for (const fixtureName of recoverableFixtures) {
      it(`fixture ${fixtureName} routes to Tier 1`, async () => {
        const tier1 = makeStubTier1({ ok: true });
        const onLog = vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => {});
        const onMeta = vi.fn(async (_meta: AdapterInvocationMeta) => {});
        const result = await executeClaudeLocalWithFailover({
          tier0: makeStubTier0(fixtureName),
          tier1: tier1.runner,
          prompt: "test prompt",
          model: "claude-sonnet-4-6",
          onLog,
          onMeta,
        });
        expect(tier1.calls).toBe(1);
        expect(result.tierUsed).toBe("tier_1_anthropic_sdk");
        expect(result.tierTransitions).toHaveLength(1);
        expect(result.tierTransitions?.[0]?.from).toBe("tier_0_claude_cli");
        expect(result.tierTransitions?.[0]?.to).toBe("tier_1_anthropic_sdk");
        expect(result.classifierVersion).toBe("1.0.0");
        expect(result.exitCode).toBe(0);
        expect(result.biller).toBe("anthropic");
        expect(result.billingType).toBe("api_key");
        // grep-friendly stdout log line is emitted
        const stdoutCalls = onLog.mock.calls.filter((c) => c[0] === "stdout");
        expect(stdoutCalls.length).toBeGreaterThanOrEqual(1);
        expect(String(stdoutCalls[0]?.[1] ?? "")).toContain("[paperclip] Tier 0");
        // meta event with failoverEvent
        expect(onMeta).toHaveBeenCalled();
        const metaArg = onMeta.mock.calls[0]?.[0] as AdapterInvocationMeta | undefined;
        expect(metaArg?.failoverEvent).toBeTruthy();
        expect(metaArg?.failoverEvent?.from).toBe("tier_0_claude_cli");
        expect(metaArg?.failoverEvent?.to).toBe("tier_1_anthropic_sdk");
      });
    }
  });

  describe("does NOT fire Tier 1 on non-recoverable Tier 0 outcomes", () => {
    const nonRecoverableFixtures = [
      "02-quota-exhausted",
      "04-token-refresh-revoked",
      "13-auth-required",
      "14-unknown-session",
      "15-max-turns",
      "16-timeout",
      "17-user-sigint",
      "18-http-400",
      "19-success",
    ];

    for (const fixtureName of nonRecoverableFixtures) {
      it(`fixture ${fixtureName} stays on Tier 0`, async () => {
        const tier1 = makeStubTier1({ ok: true });
        const onLog = vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => {});
        const onMeta = vi.fn(async (_meta: AdapterInvocationMeta) => {});
        const result = await executeClaudeLocalWithFailover({
          tier0: makeStubTier0(fixtureName),
          tier1: tier1.runner,
          prompt: "test prompt",
          model: "claude-sonnet-4-6",
          onLog,
          onMeta,
        });
        expect(tier1.calls).toBe(0);
        expect(result.tierUsed).toBe("tier_0_claude_cli");
        expect(result.tierTransitions).toEqual([]);
        expect(result.classifierVersion).toBe("1.0.0");
        // no failover log line
        const stdoutCalls = onLog.mock.calls.filter((c) => c[0] === "stdout");
        for (const c of stdoutCalls) {
          expect(String(c[1] ?? "")).not.toContain("Failing over to Tier 1");
        }
        // no failoverEvent on meta
        for (const c of onMeta.mock.calls) {
          const meta = c[0] as AdapterInvocationMeta | undefined;
          expect(meta?.failoverEvent).toBeFalsy();
        }
      });
    }
  });

  describe("loop prevention", () => {
    it("Tier 1's own failure is the final answer — never re-classified, never retried", async () => {
      const tier1 = makeStubTier1({ ok: false });
      const result = await executeClaudeLocalWithFailover({
        tier0: makeStubTier0("01-rate-limit-429"),
        tier1: tier1.runner,
        prompt: "test prompt",
        model: "claude-sonnet-4-6",
        onLog: noopLog,
        onMeta: noopMeta,
      });
      expect(tier1.calls).toBe(1);
      expect(result.tierUsed).toBe("tier_1_anthropic_sdk");
      expect(result.tierTransitions).toHaveLength(1);
      expect(result.exitCode).toBe(1);
      expect(result.biller).toBe("anthropic");
      expect(result.billingType).toBe("api_key");
    });

    it("with no Tier 1 runner configured, recoverable Tier 0 failure surfaces as Tier 0", async () => {
      const onLog = vi.fn(async () => {});
      const result = await executeClaudeLocalWithFailover({
        tier0: makeStubTier0("01-rate-limit-429"),
        tier1: null,
        prompt: "test prompt",
        model: "claude-sonnet-4-6",
        onLog,
      });
      expect(result.tierUsed).toBe("tier_0_claude_cli");
      expect(result.tierTransitions).toEqual([]);
      expect(result.classifierVersion).toBe("1.0.0");
    });
  });

  describe("Tier 0 success path", () => {
    it("does not call Tier 1 on a clean Tier 0 result", async () => {
      const tier1 = makeStubTier1({ ok: true });
      const result = await executeClaudeLocalWithFailover({
        tier0: makeStubTier0("19-success"),
        tier1: tier1.runner,
        prompt: "test prompt",
        model: "claude-sonnet-4-6",
        onLog: noopLog,
        onMeta: noopMeta,
      });
      expect(tier1.calls).toBe(0);
      expect(result.tierUsed).toBe("tier_0_claude_cli");
      expect(result.tierTransitions).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });

  // ─── ROCAA-23 cost-cap gate ──────────────────────────────────────────────
  describe("ROCAA-23 cost-cap gate", () => {
    it("blocks Tier 1 when gate returns daily_cap_tripped — surfaces Tier 0 result, no transitions", async () => {
      const tier1 = makeStubTier1({ ok: true });
      const onLog = vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => {});
      const onMeta = vi.fn(async (_meta: AdapterInvocationMeta) => {});
      const tier1Gate = vi.fn(async (_args: { issueId: string | null }) => ({
        allowed: false as const,
        reason: "daily_cap_tripped" as const,
        detail: "Tier 1 daily cap tripped at 2026-05-24T08:00:00Z: $52.31 today (cap $50.00). Resets at 2026-05-25T00:00:00Z.",
        resetAt: "2026-05-25T00:00:00Z",
      }));
      const onTier1Cost = vi.fn(async () => {});
      const result = await executeClaudeLocalWithFailover({
        tier0: makeStubTier0("01-rate-limit-429"),
        tier1: tier1.runner,
        prompt: "test prompt",
        model: "claude-sonnet-4-6",
        onLog,
        onMeta,
        issueId: "issue-abc",
        tier1Gate,
        onTier1Cost,
      });
      // Gate consulted once with the issue id.
      expect(tier1Gate).toHaveBeenCalledTimes(1);
      const gateCall = tier1Gate.mock.calls[0];
      expect(gateCall?.[0]).toEqual({ issueId: "issue-abc" });
      // Tier 1 NOT called.
      expect(tier1.calls).toBe(0);
      // onTier1Cost NOT called either (no Tier 1 spend to record).
      expect(onTier1Cost).not.toHaveBeenCalled();
      // Result surfaces Tier 0 with no transition.
      expect(result.tierUsed).toBe("tier_0_claude_cli");
      expect(result.tierTransitions).toEqual([]);
      expect(result.classifierVersion).toBe("1.0.0");
      // Log line names the block.
      const stdout = onLog.mock.calls.filter((c) => c[0] === "stdout").map((c) => String(c[1] ?? ""));
      expect(stdout.some((s) => s.includes("Tier 1 blocked by cost cap") && s.includes("daily_cap_tripped"))).toBe(true);
      // Meta event carries the cost-cap block + a self-loop failoverEvent.
      const meta = onMeta.mock.calls[0]?.[0];
      expect(meta?.failoverEvent?.from).toBe("tier_0_claude_cli");
      expect(meta?.failoverEvent?.to).toBe("tier_0_claude_cli");
      expect(meta?.costCapBlock?.reason).toBe("daily_cap_tripped");
      expect(meta?.costCapBlock?.issueId).toBe("issue-abc");
      expect(meta?.costCapBlock?.resetAt).toBe("2026-05-25T00:00:00Z");
    });

    it("blocks Tier 1 when gate returns per_issue_cap_tripped — resetAt is null", async () => {
      const tier1 = makeStubTier1({ ok: true });
      const onMeta = vi.fn(async (_meta: AdapterInvocationMeta) => {});
      const result = await executeClaudeLocalWithFailover({
        tier0: makeStubTier0("01-rate-limit-429"),
        tier1: tier1.runner,
        prompt: "test prompt",
        model: "claude-sonnet-4-6",
        onLog: noopLog,
        onMeta,
        issueId: "issue-abc",
        tier1Gate: async () => ({
          allowed: false,
          reason: "per_issue_cap_tripped",
          detail: "issue-abc cumulative $5.20 (cap $5.00)",
        }),
      });
      expect(tier1.calls).toBe(0);
      expect(result.tierUsed).toBe("tier_0_claude_cli");
      const meta = onMeta.mock.calls[0]?.[0];
      expect(meta?.costCapBlock?.reason).toBe("per_issue_cap_tripped");
      expect(meta?.costCapBlock?.resetAt).toBeNull();
      expect(meta?.costCapBlock?.issueId).toBe("issue-abc");
    });

    it("allows Tier 1 and invokes onTier1Cost with the SDK costUsd when gate allows", async () => {
      const tier1 = makeStubTier1({ ok: true });
      const tier1Gate = vi.fn(async () => ({ allowed: true as const }));
      const onTier1Cost = vi.fn(async (_args: { issueId: string | null; costUsd: number }) => {});
      const result = await executeClaudeLocalWithFailover({
        tier0: makeStubTier0("01-rate-limit-429"),
        tier1: tier1.runner,
        prompt: "test prompt",
        model: "claude-sonnet-4-6",
        onLog: noopLog,
        onMeta: noopMeta,
        issueId: "issue-xyz",
        tier1Gate,
        onTier1Cost,
      });
      expect(tier1Gate).toHaveBeenCalledTimes(1);
      expect(tier1.calls).toBe(1);
      expect(result.tierUsed).toBe("tier_1_anthropic_sdk");
      expect(onTier1Cost).toHaveBeenCalledTimes(1);
      expect(onTier1Cost.mock.calls[0][0]).toEqual({ issueId: "issue-xyz", costUsd: 0 });
    });

    it("treats gate exceptions as 'allowed' (cost-tracking outage must not wedge dispatch)", async () => {
      const tier1 = makeStubTier1({ ok: true });
      const tier1Gate = vi.fn(async () => {
        throw new Error("cache dir unreadable");
      });
      const result = await executeClaudeLocalWithFailover({
        tier0: makeStubTier0("01-rate-limit-429"),
        tier1: tier1.runner,
        prompt: "test prompt",
        model: "claude-sonnet-4-6",
        onLog: noopLog,
        onMeta: noopMeta,
        issueId: "issue-xyz",
        tier1Gate,
      });
      expect(tier1Gate).toHaveBeenCalledTimes(1);
      expect(tier1.calls).toBe(1);
      expect(result.tierUsed).toBe("tier_1_anthropic_sdk");
    });

    it("swallows onTier1Cost exceptions — Tier 1 result still returned cleanly", async () => {
      const tier1 = makeStubTier1({ ok: true });
      const onTier1Cost = vi.fn(async () => {
        throw new Error("disk full");
      });
      const result = await executeClaudeLocalWithFailover({
        tier0: makeStubTier0("01-rate-limit-429"),
        tier1: tier1.runner,
        prompt: "test prompt",
        model: "claude-sonnet-4-6",
        onLog: noopLog,
        onMeta: noopMeta,
        issueId: "issue-xyz",
        tier1Gate: async () => ({ allowed: true }),
        onTier1Cost,
      });
      expect(onTier1Cost).toHaveBeenCalledTimes(1);
      expect(result.tierUsed).toBe("tier_1_anthropic_sdk");
      expect(result.exitCode).toBe(0);
    });

    it("does not call the gate on non-recoverable Tier 0 (gate only applies when Tier 1 would otherwise fire)", async () => {
      const tier1 = makeStubTier1({ ok: true });
      const tier1Gate = vi.fn(async () => ({ allowed: false as const, reason: "daily_cap_tripped" as const, detail: "x" }));
      const result = await executeClaudeLocalWithFailover({
        tier0: makeStubTier0("19-success"),
        tier1: tier1.runner,
        prompt: "test prompt",
        model: "claude-sonnet-4-6",
        onLog: noopLog,
        onMeta: noopMeta,
        issueId: "issue-xyz",
        tier1Gate,
      });
      expect(tier1Gate).not.toHaveBeenCalled();
      expect(tier1.calls).toBe(0);
      expect(result.tierUsed).toBe("tier_0_claude_cli");
    });
  });
});
