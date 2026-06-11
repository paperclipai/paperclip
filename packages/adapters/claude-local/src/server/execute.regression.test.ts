/**
 * execute()-level regression test for Tier 0 → Tier 0b agentic-API failover.
 *
 * ROC-1681 / ROC-139: when subscription seats are exhausted on a *recoverable*
 * failure, the production entrypoint (execute()) must re-run the agent ONE more
 * time on the metered Anthropic API (runAttempt with ANTHROPIC_API_KEY) before
 * giving up — a FULLY AGENTIC attempt, gated by the shared Tier-1 cost-cap and
 * the metered key. The legacy SDK one-shot Tier 1 is disabled (tier1: null)
 * because it recorded non-agentic completions as silent "successes".
 *
 * Strategy:
 *  - Mock runChildProcess: 1st call (subscription) = recoverable CLI panic,
 *    2nd call (metered re-spawn) = clean exit 0.
 *  - Mock the cost-cap gate + key fetch so the re-spawn is allowed/keyed.
 *  - Assert the 2nd spawn fires with ANTHROPIC_API_KEY in its env, that the
 *    cost is recorded, and that the gate/key gates suppress it when they should.
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
vi.mock("./seat-rotation.js", () => ({
  pickNextSeat: vi.fn().mockReturnValue({ profileDir: null, allExhausted: true }),
  resetSeatRotation: vi.fn(),
}));

// Metered-key fetch + cost-cap gate are the two gates on the agentic re-spawn.
vi.mock("./secret-fetch.js", () => ({
  fetchBlueprintWorkerKey: vi.fn(),
  BLUEPRINT_WORKER_SECRET_NAME: "ANTHROPIC_API_KEY_BLUEPRINT_WORKER",
}));

vi.mock("./tier1-cost-cap.js", () => ({
  buildTier1Gate: vi.fn(),
  recordTier1Cost: vi.fn(),
}));

// ── Imports after mocks are declared ────────────────────────────────────────

import { execute } from "./execute.js";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { resetSeatRotation } from "./seat-rotation.js";
import { fetchBlueprintWorkerKey } from "./secret-fetch.js";
import { buildTier1Gate, recordTier1Cost } from "./tier1-cost-cap.js";

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

/** Clean exit-0 result — models a successful metered-API re-spawn. */
function makeCleanProc() {
  return {
    exitCode: 0,
    signal: null,
    pid: null,
    startedAt: null,
    timedOut: false,
    stdout: "",
    stderr: "",
  };
}

const TEST_KEY = "sk-ant-test-key";

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Gate allows by default; key resolves by default.
  vi.mocked(buildTier1Gate).mockReturnValue(
    vi.fn().mockResolvedValue({ allowed: true }) as never,
  );
  vi.mocked(recordTier1Cost).mockResolvedValue(null);
  vi.mocked(fetchBlueprintWorkerKey).mockResolvedValue({
    value: TEST_KEY,
    name: "ANTHROPIC_API_KEY_BLUEPRINT_WORKER",
    source: "env_var",
    fetchedAt: 0,
  } as never);
  // Default: subscription seat panics, metered re-spawn succeeds.
  vi.mocked(runChildProcess)
    .mockResolvedValueOnce(makePanicProc() as never)
    .mockResolvedValue(makeCleanProc() as never);
});

describe("execute() → Tier 0b agentic metered-API failover (ROC-139)", () => {
  it("re-runs the agent on the metered Anthropic API after a recoverable Tier 0 failure", async () => {
    const result = await execute(makeCtx());

    // Two spawns: subscription (Tier 0) then metered re-spawn (Tier 0b).
    expect(vi.mocked(runChildProcess)).toHaveBeenCalledTimes(2);

    // The 2nd spawn carries the metered key → billing flips to "api".
    const secondCallOpts = vi.mocked(runChildProcess).mock.calls[1]?.[3] as
      | { env?: Record<string, string> }
      | undefined;
    expect(secondCallOpts?.env?.ANTHROPIC_API_KEY).toBe(TEST_KEY);

    // Spend was recorded against the issue for the cost-cap accumulator.
    expect(vi.mocked(recordTier1Cost)).toHaveBeenCalled();

    // The successful re-spawn is the surfaced result.
    expect(result.exitCode).toBe(0);
    expect(vi.mocked(resetSeatRotation)).toHaveBeenCalled();
  });

  it("does NOT re-spawn when Tier 0 exits cleanly (exit code 0)", async () => {
    vi.mocked(runChildProcess).mockReset();
    vi.mocked(runChildProcess).mockResolvedValue(makeCleanProc() as never);

    const result = await execute(makeCtx());

    expect(vi.mocked(runChildProcess)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordTier1Cost)).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it("does NOT re-spawn when the cost cap blocks it", async () => {
    vi.mocked(buildTier1Gate).mockReturnValue(
      vi
        .fn()
        .mockResolvedValue({ allowed: false, reason: "per_issue_cap_tripped", detail: "cap" }) as never,
    );

    await execute(makeCtx());

    // Only the subscription Tier 0 spawn — the metered re-spawn is suppressed.
    expect(vi.mocked(runChildProcess)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordTier1Cost)).not.toHaveBeenCalled();
  });

  it("does NOT re-spawn when the metered key is unavailable", async () => {
    vi.mocked(fetchBlueprintWorkerKey).mockRejectedValue(new Error("secret unavailable"));

    await execute(makeCtx());

    expect(vi.mocked(runChildProcess)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordTier1Cost)).not.toHaveBeenCalled();
  });

  it("threads the issueId into the cost-cap record", async () => {
    await execute(
      makeCtx({ context: { issueId: "issue-abc-123" } } as Partial<AdapterExecutionContext>),
    );

    expect(vi.mocked(recordTier1Cost)).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ issueId: "issue-abc-123" }),
    );
  });

  it("does NOT re-spawn on a NON-recoverable Tier 0 failure", async () => {
    // max_turns is classified non-recoverable → no metered re-spawn.
    vi.mocked(runChildProcess).mockReset();
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 1,
      signal: null,
      pid: null,
      startedAt: null,
      timedOut: false,
      stdout: JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }),
      stderr: "",
    } as never);

    await execute(makeCtx());

    expect(vi.mocked(runChildProcess)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordTier1Cost)).not.toHaveBeenCalled();
  });
});
