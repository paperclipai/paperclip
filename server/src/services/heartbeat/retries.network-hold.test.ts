import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { createHeartbeatRetries, type HeartbeatRetryDependencies } from "./retries.js";
import { logger } from "../../middleware/logger.js";

/**
 * The retry-engine side of the host-network hold (LAC-6885).
 *
 * These cases are deliberately db-free: every assertion is about a decision the
 * gate makes BEFORE any persistence, which is the whole point of the gate. A run
 * held here has written nothing, so it has consumed no retry attempt.
 */

const MEASURED_ENOTFOUND_ERROR =
  "Claude run failed: subtype=success: API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";

function fakeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-00000000r001",
    companyId: "00000000-0000-4000-8000-00000000c001",
    agentId: "00000000-0000-4000-8000-00000000a001",
    issueId: null,
    scopeKind: "issue",
    status: "failed",
    errorCode: "adapter_failed",
    error: MEASURED_ENOTFOUND_ERROR,
    resultJson: {},
    runnerProfileJson: {},
    contextSnapshot: { issueId: "00000000-0000-4000-8000-00000000i001" },
    runtimeMode: "cli",
    scheduledRetryAttempt: 0,
    wakeupRequestId: null,
    ...overrides,
  } as never;
}

const fakeAgent = { id: "00000000-0000-4000-8000-00000000a001", adapterType: "claude_local", adapterConfig: {} } as never;

function deps(isProviderHostReachable: () => Promise<boolean>) {
  const appendRunEvent = vi.fn(async () => undefined);
  const applyRunDispatchPostCommitEffects = vi.fn();
  const getAgentInvokability = vi.fn(async () => ({ invokable: true }));
  const dependencies = {
    hasCaseHandoffForRun: vi.fn(async () => false),
    appendRunEvent,
    escalatePlanApprovalResumeFailureNeedsAttention: vi.fn(async () => null),
    getAgentInvokability,
    runDispatch: {
      nextScheduledRetryAt: vi.fn(async () => null),
      evaluateScheduledRetryGate: vi.fn(async () => ({ allowed: true })),
      promoteDueScheduledRetries: vi.fn(async () => ({ promoted: 0, runIds: [], postCommitEffects: [] })),
    },
    resolveSessionBeforeForWakeup: vi.fn(async () => null),
    resolveResponsibleUserIdForRunContext: vi.fn(async () => null),
    recordPlanApprovalResumeFailureRetry: vi.fn(async () => null),
    setRunStatusIfRunning: vi.fn(async () => ({ updated: false, run: null })),
    setWakeupStatus: vi.fn(async () => undefined),
    getRun: vi.fn(async () => null),
    getAgent: vi.fn(async () => undefined),
    releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
    finalizeAgentStatus: vi.fn(async () => undefined),
    getWorktreeExecutionCutoff: vi.fn(async () => null),
    applyRunDispatchPostCommitEffects,
    isProviderHostReachable,
  } as unknown as HeartbeatRetryDependencies;
  return { dependencies, appendRunEvent, applyRunDispatchPostCommitEffects, getAgentInvokability };
}

// The gate runs before any db access, so an unusable db is the strongest possible
// assertion that nothing downstream was reached.
const unusableDb = new Proxy({}, {
  get() {
    throw new Error("the database must not be touched before the reachability gate decides");
  },
}) as Db;

describe("scheduleBoundedRetryForRun host-network hold", () => {
  it("holds the retry when the run failed on DNS and the host still cannot resolve", async () => {
    const isReachable = vi.fn(async () => false);
    const { dependencies, appendRunEvent, applyRunDispatchPostCommitEffects } = deps(isReachable);
    const retries = createHeartbeatRetries(unusableDb, dependencies);

    const result = await retries.scheduleBoundedRetryForRun(fakeRun(), fakeAgent);

    expect(result.outcome).toBe("not_scheduled");
    expect(result).toMatchObject({ errorCode: "provider_network_unreachable" });
    expect(isReachable).toHaveBeenCalledTimes(1);
    // No attempt was consumed and no exhaustion was recorded: the hold is not a
    // spent budget, it is a budget that was never touched.
    expect(appendRunEvent).not.toHaveBeenCalled();
    expect(applyRunDispatchPostCommitEffects).not.toHaveBeenCalled();
  });

  it("logs the hold, so an outage is distinguishable from an idle fleet", async () => {
    // The hold writes no run row and no run event on purpose -- writing either
    // would be the spawn it is suppressing -- so this log line is the ONLY
    // trace it leaves. Asserted rather than eyeballed because an unasserted
    // log line is one refactor away from silently disappearing, and then
    // "holding correctly" and "wedged" look identical from the outside.
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const { dependencies } = deps(async () => false);
      const retries = createHeartbeatRetries(unusableDb, dependencies);

      await retries.scheduleBoundedRetryForRun(fakeRun(), fakeAgent);

      const held = info.mock.calls.find(
        ([fields]) => (fields as { errorCode?: string })?.errorCode === "provider_network_unreachable",
      );
      expect(held).toBeDefined();
      expect(held![0]).toMatchObject({
        runId: "00000000-0000-4000-8000-00000000r001",
        issueId: "00000000-0000-4000-8000-00000000i001",
        errorCode: "provider_network_unreachable",
      });
    } finally {
      info.mockRestore();
    }
  });

  it("reports the issue so the hold is attributable", async () => {
    const { dependencies } = deps(async () => false);
    const retries = createHeartbeatRetries(unusableDb, dependencies);
    const result = await retries.scheduleBoundedRetryForRun(fakeRun(), fakeAgent);
    expect(result).toMatchObject({ issueId: "00000000-0000-4000-8000-00000000i001" });
  });

  it("does NOT probe at all when the failure was not a host network failure", async () => {
    const isReachable = vi.fn(async () => false);
    const { dependencies } = deps(isReachable);
    const retries = createHeartbeatRetries(unusableDb, dependencies);

    await retries
      .scheduleBoundedRetryForRun(
        fakeRun({ error: "Claude run failed: subtype=error_max_turns: Reached maximum number of turns" }),
        fakeAgent,
      )
      .catch(() => undefined);

    expect(isReachable).not.toHaveBeenCalled();
  });

  it("does NOT hold a DNS failure once the host can resolve again", async () => {
    const isReachable = vi.fn(async () => true);
    const { dependencies } = deps(isReachable);
    const retries = createHeartbeatRetries(unusableDb, dependencies);

    // The gate falls through, so the call continues into persistence and the
    // unusable db stops it there. What matters is that it got past the gate.
    const outcome = await retries
      .scheduleBoundedRetryForRun(fakeRun(), fakeAgent)
      .then((result) => result as { errorCode?: string })
      .catch(() => ({ errorCode: undefined }));

    expect(isReachable).toHaveBeenCalledTimes(1);
    expect(outcome.errorCode).not.toBe("provider_network_unreachable");
  });

  it("still defers to the guards that run ahead of it", async () => {
    const isReachable = vi.fn(async () => false);
    const { dependencies } = deps(isReachable);
    (dependencies.hasCaseHandoffForRun as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const retries = createHeartbeatRetries(unusableDb, dependencies);

    const result = await retries.scheduleBoundedRetryForRun(fakeRun(), fakeAgent);

    expect(result.outcome).toBe("not_scheduled");
    expect(result).not.toMatchObject({ errorCode: "provider_network_unreachable" });
    expect(isReachable).not.toHaveBeenCalled();
  });
});
