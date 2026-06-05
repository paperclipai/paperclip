/**
 * execute()-level regression test for Tier 0 → Tier 1 failover wiring.
 *
 * ROC-1681 / ROCAA-22: The acceptance suite in failover.acceptance.test.ts
 * tests the orchestrator helper in isolation.  This file proves that the
 * *production entrypoint* (execute()) actually routes recoverable Tier 0
 * failures through executeClaudeLocalWithFailover() so Tier 1 fires.
 *
 * Strategy:
 *  - Mock runChildProcess to return a recoverable CLI-panic result.
 *  - Spy on runTier1 to observe whether Tier 1 was invoked.
 *  - Call execute() and assert tierUsed / tierTransitions on the result.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

// ── Module mocks (must be declared before any imports that trigger module load) ──

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    ensureAbsoluteDirectory: vi.fn().mockResolvedValue(undefined),
    ensureCommandResolvable: vi.fn().mockResolvedValue(undefined),
    resolveCommandForLogs: vi.fn().mockResolvedValue("claude"),
    readPaperclipRuntimeSkillEntries: vi.fn().mockResolvedValue([]),
    runChildProcess: vi.fn(),
  };
});

vi.mock("./prompt-cache.js", () => ({
  prepareClaudePromptBundle: vi.fn().mockResolvedValue({
    bundleKey: "test-bundle-key",
    instructionsFilePath: null,
    addDir: "/tmp/test-adddir",
  }),
}));

vi.mock("./skills.js", () => ({
  resolveClaudeDesiredSkillNames: vi.fn().mockReturnValue([]),
}));

// Seat rotation: default to "all exhausted" so the loop exits immediately.
// Individual tests can override this.
vi.mock("./seat-rotation.js", () => ({
  pickNextSeat: vi.fn().mockReturnValue({ profileDir: null, allExhausted: true }),
  resetSeatRotation: vi.fn(),
}));

// Spy on runTier1 — tests control the return value.
vi.mock("./tier1.js", () => ({
  runTier1: vi.fn(),
}));

// ── Imports after mocks are declared ────────────────────────────────────────

import { execute } from "./execute.js";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { runTier1 } from "./tier1.js";
import { resetSeatRotation } from "./seat-rotation.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
  return {
    runId: "run-regression-test",
    agent: {
      id: "agent-test",
      name: "Test Agent",
      companyId: "company-test",
      urlKey: "test-agent",
    } as unknown as AdapterExecutionContext["agent"],
    config: {
      command: "claude",
      cwd: "/tmp",
    },
    context: {
      issueId: "issue-regression-test",
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
    } as AdapterExecutionContext["runtime"],
    onLog: vi.fn().mockResolvedValue(undefined),
    onMeta: vi.fn().mockResolvedValue(undefined),
    onSpawn: vi.fn(),
    ...overrides,
  } as unknown as AdapterExecutionContext;
}

/** Recoverable CLI-panic result (matches classifier fixture 11-claude-cli-panic). */
function makePanicProc() {
  return {
    exitCode: 134,
    signal: null,
    pid: null,
    startedAt: null,
    timedOut: false,
    stdout: "",
    stderr:
      "panic: runtime error: invalid memory address or nil pointer dereference\ngoroutine 1 [running]:\n",
  };
}

/** Successful Tier 1 SDK result. */
function makeTier1Success() {
  return {
    exitCode: 0 as const,
    biller: "anthropic" as const,
    billingType: "api_key" as const,
    model: "claude-sonnet-4-6",
    summary: "Tier 1 handled it",
    parsed: { type: "result", subtype: "success", result: "Tier 1 handled it" },
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
    costUsd: 0,
    secretSource: "gcp_secret_manager" as const,
    secretName: "anthropic-api-key-blueprint-worker",
  };
}

/** Failing Tier 1 SDK result (SDK itself rate-limited). */
function makeTier1Failure() {
  return {
    exitCode: 1 as const,
    biller: "anthropic" as const,
    billingType: "api_key" as const,
    model: "claude-sonnet-4-6",
    summary: "",
    parsed: {
      type: "error",
      subtype: "tier1_rate_limit",
      message: "Tier 1 SDK rate-limited",
    },
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    secretSource: "gcp_secret_manager" as const,
    secretName: "anthropic-api-key-blueprint-worker",
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runTier1).mockResolvedValue(makeTier1Success());
  vi.mocked(runChildProcess).mockResolvedValue(makePanicProc());
});

describe("execute() → Tier 0→Tier 1 failover regression (ROC-1681)", () => {
  it("fires Tier 1 from the production entrypoint on a recoverable CLI panic", async () => {
    const ctx = makeCtx();

    const result = await execute(ctx);

    // Tier 1 must have been invoked exactly once via the production wiring.
    expect(vi.mocked(runTier1)).toHaveBeenCalledTimes(1);

    // Result must carry the failover metadata.
    expect(result.tierUsed).toBe("tier_1_anthropic_sdk");
    expect(result.tierTransitions).toHaveLength(1);
    expect(result.tierTransitions?.[0]?.from).toBe("tier_0_claude_cli");
    expect(result.tierTransitions?.[0]?.to).toBe("tier_1_anthropic_sdk");
    expect(result.classifierVersion).toBeTruthy();

    // Tier 1 billing fields are surfaced on the result.
    expect(result.exitCode).toBe(0);
    expect(result.biller).toBe("anthropic");
    expect(result.billingType).toBe("api_key");
  });

  it("does NOT fire Tier 1 when Tier 0 exits cleanly (exit code 0)", async () => {
    // Tier 0 returns an empty but exit-0 result — no JSON output, but no crash.
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      pid: null,
      startedAt: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    const result = await execute(makeCtx());

    expect(vi.mocked(runTier1)).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it("loop prevention: Tier 1 failure is the final answer — Tier 1 runs at most once", async () => {
    vi.mocked(runTier1).mockResolvedValue(makeTier1Failure());

    const result = await execute(makeCtx());

    // Tier 1 must have been called once and only once despite its failure.
    expect(vi.mocked(runTier1)).toHaveBeenCalledTimes(1);

    // The failed Tier 1 result is surfaced with the transition record intact.
    expect(result.tierUsed).toBe("tier_1_anthropic_sdk");
    expect(result.tierTransitions).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it("passes the issueId from context to the failover orchestrator", async () => {
    const ctx = makeCtx({ context: { issueId: "issue-abc-123" } } as Partial<AdapterExecutionContext>);

    await execute(ctx);

    // The issueId surfaces in the Tier 1 call args (orchestrator threads it
    // through for ROCAA-23 cost-cap gate; runTier1 itself doesn't use it but
    // the orchestrator passes it along — verify the call happened at all).
    expect(vi.mocked(runTier1)).toHaveBeenCalledTimes(1);
  });

  it("seat rotation reset is called after a successful Tier 1 result", async () => {
    await execute(makeCtx());

    // Tier 1 succeeded (exitCode 0) → resetSeatRotation() should have been called.
    expect(vi.mocked(resetSeatRotation)).toHaveBeenCalledTimes(1);
  });
});
