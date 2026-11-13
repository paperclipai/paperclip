import { describe, expect, it } from "vitest";
import {
  CONTINUATION_CAP,
  CONTINUATION_CAP_WINDOW_MS,
  continuationActivityMessage,
  continuationAllowance,
  evaluateAssignedWork,
  SETTLING_GRACE_MS,
  SETTLING_MAX_MS,
  STALE_BLOCK_MS,
  SYSTEM_RECOVERY_WORKING_BOUND_MS,
  VIOLATION_REASONS,
  type AssignedWorkFacts,
} from "./assigned-work-invariant.js";

const now = new Date("2026-11-12T14:35:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const AGENT = "agent-1";

type Overrides = Omit<Partial<AssignedWorkFacts>, "issue"> & { issue?: Partial<AssignedWorkFacts["issue"]> };
function facts(overrides: Overrides = {}): AssignedWorkFacts {
  const { issue, ...rest } = overrides;
  return {
    issue: {
      status: "in_progress", assigneeAgentId: AGENT, assigneeUserId: null, hidden: false,
      blockedTransitionAt: null, updatedAt: ago(3 * 60 * 60_000), unblockOwner: null, monitorNextCheckAt: null,
      isConversation: false, awaitingFirstMessage: false, ...issue,
    },
    activeRuns: [],
    // The common staging shape: a legacy run interrupted by a deploy's shutdown hours ago.
    latestRun: { id: "run-1", status: "interrupted", errorCode: "server_shutdown_interrupted",
      finishedAt: ago(3 * 60 * 60_000), settlingUntil: null, operatorStopped: false },
    pendingWakes: 0, nativeRecoveryPending: false, pendingHandoff: false, sessionGoal: null,
    interruption: null, pendingInteractions: 0, pendingApprovals: 0, openBlockers: 0, openChildren: 0,
    reviewPending: false, activeRecoveryAction: null, agent: { status: "idle", invokable: true },
    companyPaused: false, pauseHold: false, budgetStop: false, blockedBy: null,
    ...rest,
  };
}

describe("assigned-work invariant", () => {
  it("is not applicable to closed, unassigned, person-assigned or hidden tasks", () => {
    for (const issue of [{ status: "done" }, { status: "in_review" }, { assigneeAgentId: null },
      { assigneeUserId: "user-1" }, { hidden: true }]) {
      expect(evaluateAssignedWork(facts({ issue }), now)).toEqual({ kind: "not_applicable" });
    }
  });

  describe("clause 1: a live run", () => {
    it("accepts a queued or running run whose owner is alive or unprovable", () => {
      for (const owner of ["alive", "unprovable"] as const) {
        expect(evaluateAssignedWork(facts({ activeRuns: [{ id: "r", status: "running", scheduledRetryAt: null, owner }] }), now))
          .toEqual({ kind: "ok", clause: "live_run", runId: "r" });
      }
      expect(evaluateAssignedWork(facts({ activeRuns: [{ id: "q", status: "queued", scheduledRetryAt: null, owner: "alive" }] }), now))
        .toMatchObject({ kind: "ok", clause: "live_run" });
    });

    it("does not count a native run whose restart-recovery claim nobody renews", () => {
      expect(evaluateAssignedWork(facts({ activeRuns: [{ id: "n", status: "running", scheduledRetryAt: null, owner: "stalled" }] }), now))
        .toEqual({ kind: "violation", reason: "native_run_stalled", runId: "n", stale: false });
    });

    it("does not count a running run whose owner is proven gone", () => {
      expect(evaluateAssignedWork(facts({ activeRuns: [{ id: "r", status: "running", scheduledRetryAt: null, owner: "gone" }] }), now))
        .toEqual({ kind: "violation", reason: "run_owner_gone", runId: "r", stale: false });
    });
  });

  describe("clause 2: a durable pending intent", () => {
    const cases: Array<[string, Overrides]> = [
      ["queued_wake", { pendingWakes: 1 }],
      ["scheduled_retry", { activeRuns: [{ id: "s", status: "scheduled_retry", scheduledRetryAt: new Date(now.getTime() + 60_000), owner: "alive" }] }],
      ["native_recovery", { nativeRecoveryPending: true }],
      ["pending_handoff", { pendingHandoff: true }],
      ["session_goal", { sessionGoal: "active" }],
      ["scheduled_monitor", { issue: { monitorNextCheckAt: new Date(now.getTime() + 60_000) } }],
      ["system_recovery_working", { interruption: { responsibility: "system", state: "working", userAction: null, nextRetryAt: null, canRetry: false },
        latestRun: { id: "run-1", status: "failed", errorCode: "native_restart_recovery_blocked", finishedAt: ago(5 * 60_000), settlingUntil: null, operatorStopped: false } }],
    ];
    for (const [intent, overrides] of cases) {
      it(`accepts ${intent}`, () => {
        expect(evaluateAssignedWork(facts(overrides), now)).toEqual({ kind: "ok", clause: "pending_intent", intent });
      });
    }

    it("stops believing system recovery is working once the last run ended longer ago than the bound", () => {
      const working = { responsibility: "system" as const, state: "working", userAction: null, nextRetryAt: null, canRetry: false };
      const run = (msAgo: number) => ({ id: "run-1", status: "failed", errorCode: "native_restart_recovery_blocked",
        finishedAt: ago(msAgo), settlingUntil: null, operatorStopped: false });
      expect(evaluateAssignedWork(facts({ interruption: working, latestRun: run(SYSTEM_RECOVERY_WORKING_BOUND_MS - 60_000) }), now))
        .toEqual({ kind: "ok", clause: "pending_intent", intent: "system_recovery_working" });
      expect(evaluateAssignedWork(facts({ interruption: working, latestRun: run(SYSTEM_RECOVERY_WORKING_BOUND_MS + 60_000) }), now))
        .toMatchObject({ kind: "violation", reason: "no_pending_path" });
    });

    it("does not count a monitor or retry whose time has passed", () => {
      expect(evaluateAssignedWork(facts({ issue: { monitorNextCheckAt: ago(1) } }), now)).toMatchObject({ kind: "violation" });
      expect(evaluateAssignedWork(facts({ interruption: { responsibility: "system", state: "retry_scheduled", userAction: null,
        nextRetryAt: ago(1).toISOString(), canRetry: true } }), now)).toMatchObject({ kind: "violation", reason: "no_pending_path" });
    });
  });

  describe("clause 3: someone else's move", () => {
    const cases: Array<[string, Overrides]> = [
      ["question", { pendingInteractions: 1 }],
      ["approval", { pendingApprovals: 1 }],
      ["dependency", { openBlockers: 1 }],
      ["dependency", { openChildren: 2 }],
      ["review", { reviewPending: true }],
      ["budget", { budgetStop: true }],
      ["company_paused", { companyPaused: true }],
      ["agent_paused", { agent: { status: "paused", invokable: false } }],
      ["agent_paused", { pauseHold: true }],
      ["user_stop", { latestRun: { id: "r", status: "cancelled", errorCode: "operator_interrupted", finishedAt: ago(60 * 60_000),
        settlingUntil: null, operatorStopped: true } }],
      ["user_stop", { sessionGoal: "paused" }],
      ["credential", { activeRecoveryAction: { cause: "configuration_incomplete", ownerType: "board", resumeAt: null } }],
      ["provider_limit", { activeRecoveryAction: { cause: "native_provider_usage_limit", ownerType: "board",
        resumeAt: new Date(now.getTime() + 30 * 60_000) } }],
      ["conversation", { issue: { isConversation: true } }],
      ["awaiting_first_message", { issue: { awaitingFirstMessage: true } }],
      ["approval", { interruption: { responsibility: "user", state: "waiting_for_user", userAction: "approval", nextRetryAt: null, canRetry: false } }],
      ["credential", { interruption: { responsibility: "user", state: "waiting_for_user", userAction: "reconnect", nextRetryAt: null, canRetry: false } }],
      ["board_confirmation", { interruption: { responsibility: "user", state: "waiting_for_user", userAction: "confirm_owner_stop", nextRetryAt: null, canRetry: false } }],
      ["user_stop", { issue: { status: "blocked", blockedTransitionAt: ago(60 * 60_000) }, blockedBy: "user" }],
      ["assignee_declared_block", { issue: { status: "blocked", blockedTransitionAt: ago(60 * 60_000) }, blockedBy: "assignee" }],
      ["assignee_declared_block", { issue: { status: "blocked", blockedTransitionAt: ago(60 * 60_000), unblockOwner: "board" }, blockedBy: "unknown" }],
    ];
    for (const [reason, overrides] of cases) {
      it(`accepts ${reason} (${Object.keys(overrides).join(", ")})`, () => {
        expect(evaluateAssignedWork(facts(overrides), now)).toEqual({ kind: "ok", clause: "waiting", reason });
      });
    }

    it("does not accept a provider limit with no resume time", () => {
      expect(evaluateAssignedWork(facts({ activeRecoveryAction: { cause: "provider_quota", ownerType: "board", resumeAt: null } }), now))
        .toMatchObject({ kind: "violation" });
    });

    it("does not accept an unblock action the assignee owes itself", () => {
      expect(evaluateAssignedWork(facts({ issue: { status: "blocked", blockedTransitionAt: ago(60_000 * 60),
        unblockOwner: { agentId: AGENT } }, blockedBy: "unknown" }), now)).toMatchObject({ kind: "violation", reason: "unknown_block" });
    });
  });

  describe("violations", () => {
    it("an in_progress task whose deploy-interrupted run left nothing pending", () => {
      expect(evaluateAssignedWork(facts(), now)).toEqual({ kind: "violation", reason: "no_pending_path", stale: false });
    });

    it("a task offering a Retry only the system can act on", () => {
      expect(evaluateAssignedWork(facts({ interruption: { responsibility: "system", state: "failed", userAction: null,
        nextRetryAt: null, canRetry: true } }), now)).toEqual({ kind: "violation", reason: "retry_offered", stale: false });
    });

    it("an unknown hold or block reason is a violation, not a reason to wait", () => {
      expect(evaluateAssignedWork(facts({ activeRecoveryAction: { cause: "some_future_cause", ownerType: "board", resumeAt: null } }), now))
        .toMatchObject({ kind: "violation", reason: "no_pending_path" });
      expect(evaluateAssignedWork(facts({ issue: { status: "blocked", blockedTransitionAt: ago(60 * 60_000) }, blockedBy: "unknown" }), now))
        .toEqual({ kind: "violation", reason: "unknown_block", stale: false });
      expect(evaluateAssignedWork(facts({ issue: { status: "blocked", blockedTransitionAt: ago(60 * 60_000) }, blockedBy: "unknown",
        activeRecoveryAction: { cause: "native_session_interrupted", ownerType: "board", resumeAt: null } }), now))
        .toEqual({ kind: "violation", reason: "recovery_block", stale: false });
      expect(evaluateAssignedWork(facts({ interruption: { responsibility: "user", state: "waiting_for_user", userAction: "something_new",
        nextRetryAt: null, canRetry: false } }), now)).toMatchObject({ kind: "violation" });
    });

    it("a block by automatic recovery is a violation; one older than 7 days is reported as stale", () => {
      expect(evaluateAssignedWork(facts({ issue: { status: "blocked", blockedTransitionAt: ago(60 * 60_000) }, blockedBy: "system" }), now))
        .toEqual({ kind: "violation", reason: "recovery_block", stale: false });
      expect(evaluateAssignedWork(facts({ issue: { status: "blocked", blockedTransitionAt: ago(STALE_BLOCK_MS + 1) }, blockedBy: "system" }), now))
        .toEqual({ kind: "violation", reason: "recovery_block", stale: true });
    });

    it("every violation reason has plain activity text without codes", () => {
      for (const reason of VIOLATION_REASONS) {
        const text = continuationActivityMessage(reason);
        expect(text).not.toMatch(/_|[0-9a-f]{8}-/);
      }
    });
  });

  describe("settling: a run that ended seconds ago", () => {
    it("leaves a task whose latest run ended seconds ago, with a re-check at the end of the grace", () => {
      const finishedAt = ago(2_000);
      expect(evaluateAssignedWork(facts({ issue: { status: "in_progress" }, latestRun: { id: "r", status: "failed", errorCode: "process_lost",
        finishedAt, settlingUntil: null, operatorStopped: false } }), now))
        .toEqual({ kind: "settling", recheckAt: new Date(finishedAt.getTime() + SETTLING_GRACE_MS) });
    });

    it("gives a new assignment and a just-resolved blocker to their own owners first, but never routine touches", () => {
      const createdAt = ago(5_000);
      expect(evaluateAssignedWork(facts({ issue: { status: "todo", createdAt }, latestRun: null }), now))
        .toEqual({ kind: "settling", recheckAt: new Date(createdAt.getTime() + SETTLING_GRACE_MS) });
      // A comment, read marker or label change only moves updatedAt: no postponement.
      expect(evaluateAssignedWork(facts({ issue: { updatedAt: ago(1_000) } }), now)).toMatchObject({ kind: "violation" });
      const resolved = ago(10_000);
      expect(evaluateAssignedWork(facts({ issue: { status: "blocked", blockedTransitionAt: ago(60 * 60_000) }, blockedBy: "assignee",
        lastBlockerResolvedAt: resolved }), now)).toEqual({ kind: "settling", recheckAt: new Date(resolved.getTime() + SETTLING_GRACE_MS) });
    });

    it("never lets a held lease postpone a finished run's repair beyond the bound", () => {
      expect(evaluateAssignedWork(facts({ latestRun: { id: "r", status: "failed", errorCode: "process_lost",
        finishedAt: ago(SETTLING_MAX_MS + 1_000), settlingUntil: new Date(now.getTime() + 60 * 60_000), operatorStopped: false } }), now))
        .toMatchObject({ kind: "violation" });
    });

    it("continues a run a deploy's shutdown cut within the grace of it ending", () => {
      const ended = ago(SETTLING_GRACE_MS + 1);
      expect(evaluateAssignedWork(facts({ latestRun: { id: "r", status: "interrupted", errorCode: "server_shutdown_interrupted",
        finishedAt: ended, settlingUntil: null, operatorStopped: false } }), now)).toMatchObject({ kind: "violation" });
    });

    it("waits for another server's controller lease that still settles the run", () => {
      const lease = new Date(now.getTime() + 60_000);
      expect(evaluateAssignedWork(facts({ latestRun: { id: "r", status: "failed", errorCode: "process_lost",
        finishedAt: ago(2 * 60_000), settlingUntil: lease, operatorStopped: false } }), now))
        .toEqual({ kind: "settling", recheckAt: lease });
    });
  });
});

describe("continuation allowance", () => {
  it("allows the first continuation and spaces later ones with doubling backoff", () => {
    expect(continuationAllowance([], now)).toEqual({ allowed: true });
    expect(continuationAllowance([ago(60_000)], now)).toEqual({ allowed: false, capped: false, retryAt: new Date(now.getTime() + 60_000) });
    expect(continuationAllowance([ago(3 * 60_000)], now)).toEqual({ allowed: true });
    expect(continuationAllowance([ago(3 * 60_000), ago(10 * 60_000)], now))
      .toEqual({ allowed: false, capped: false, retryAt: new Date(now.getTime() + 60_000) });
  });

  it("caps continuations per task per hour at the server-restart lane's limit and backs off until the window frees", () => {
    const recent = Array.from({ length: CONTINUATION_CAP }, (_, index) => ago((index + 1) * 9 * 60_000));
    const result = continuationAllowance(recent, now);
    expect(result).toEqual({ allowed: false, capped: true, retryAt: new Date(recent.at(-1)!.getTime() + CONTINUATION_CAP_WINDOW_MS) });
    expect(CONTINUATION_CAP).toBe(6);
  });

  it("never spaces continuations more than 15 minutes apart below the cap, and continuations an hour old no longer count", () => {
    // Five continuations in the hour: 2, 4, 8, 15, 15 minutes of spacing.
    const five = [ago(1 * 60_000), ago(16 * 60_000), ago(24 * 60_000), ago(28 * 60_000), ago(30 * 60_000)];
    expect(continuationAllowance(five, now)).toEqual({ allowed: false, capped: false, retryAt: new Date(now.getTime() + 14 * 60_000) });
    expect(continuationAllowance([ago(16 * 60_000), ...five.slice(1)], now)).toEqual({ allowed: true });
    expect(continuationAllowance([ago(61 * 60_000), ago(70 * 60_000)], now)).toEqual({ allowed: true });
  });
});
