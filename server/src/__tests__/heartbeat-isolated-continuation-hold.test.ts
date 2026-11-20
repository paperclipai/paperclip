import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueRecoveryActions, issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../services/execution-blocker.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { createSystemRecovery, failSystemRecovery, reserveSystemRecoveryAttempt, SystemRecoveryFailure } from "../services/system-recovery-state.ts";

const held = vi.hoisted(() => {
  const state = {
    release: () => undefined as void,
    released: Promise.resolve(),
    reset() {
      state.released = new Promise<void>((resolve) => { state.release = resolve; });
    },
  };
  return state;
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: async () => {
        await held.released;
        return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "done", provider: "test", model: "test" };
      },
    })),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const RESTORE_SCHEMA = "paperclip.workspace-restore-recovery.v1";

suite("a hold on a run that a fresh continuation already isolated", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-isolated-continuation-hold-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  afterEach(async () => {
    held.release();
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  type Shape = {
    isolation?: "remote_epoch" | "fresh_isolated_workspace" | "writer_ended" | null;
    personOwned?: boolean;
    unsafeArchive?: boolean;
  };

  async function killedRunAfterFreshContinuation(shape: Shape = {}) {
    const { isolation = "remote_epoch", personOwned = false, unsafeArchive = false } = shape;
    const userId = randomUUID(), companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), continuationId = randomUUID(), holdId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Kill wave", issuePrefix: `K${companyId.replaceAll("-", "").slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Long task across a hard kill", status: "in_progress",
      assigneeAgentId: agentId, createdByUserId: userId });

    const recordedAt = minutesAgo(4);
    const restoreRecovery = { schema: RESTORE_SCHEMA, leaseIds: [randomUUID()] };
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId, scopeKind: "issue",
      runtimeMode: "native", nativePhase: "terminal_failure", status: "failed", errorCode: "native_restart_recovery_blocked",
      invocationSource: "automation", startedAt: minutesAgo(15), finishedAt: minutesAgo(5), createdAt: minutesAgo(16),
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
      resultJson: { workspaceRestoreFailure: unsafeArchive ? "restore_unsafe_archive" : "restore_failed",
        workspaceRestoreRecovery: restoreRecovery,
        ...(isolation ? { freshContinuationSupersededAt: recordedAt.toISOString() } : {}) } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: sourceRunId, phase: "terminal_failure",
      attempt: 1, failureCode: "native_restart_recovery_blocked",
      failureDetail: isolation ? { replacementDenied: "fresh_continuation" } : {} });

    const queuedRunId = randomUUID(), wakeId = randomUUID();
    if (isolation) {
      const freshContinuation = { schema: "paperclip.fresh-continuation.v1", sourceRunId, trigger: "continuation_wake",
        failureCode: "native_restart_recovery_blocked", delivery: "recorded", recordedAt: recordedAt.toISOString(), isolation,
        stopProof: isolation === "writer_ended" ? "writer_ended" : "unproven_epoch_abandoned", unverifiedActions: [], createdObjects: [] };
      const reconciliation = { runId: sourceRunId, providerStopped: true,
        providerStopProof: isolation === "writer_ended" ? "writer_ended" : "isolated", actionOutcome: "mixed",
        actorId: "fresh-continuation", recordedAt: recordedAt.toISOString() };
      await db.insert(issueRecoveryActions).values({ id: continuationId, companyId, sourceIssueId: issueId,
        kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system", returnOwnerAgentId: agentId,
        cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuation:${sourceRunId}`,
        nextAction: "Paperclip continues the task in a fresh run from its last saved work.",
        resolutionNote: "continued_fresh_from_last_saved", resolvedAt: recordedAt, createdAt: recordedAt, updatedAt: recordedAt,
        evidence: { runId: sourceRunId, executionReconciliation: reconciliation, freshContinuation,
          continuationDelivery: "delivered", continuationRunId: queuedRunId, continuationSupersededByRun: true } });
    }

    const spent = failSystemRecovery(reserveSystemRecoveryAttempt(createSystemRecovery(sourceRunId, randomUUID()))!,
      new SystemRecoveryFailure("source_unavailable", "use_alternative_strategy"), { now: Date.now() - 3 * 60_000 });
    await db.insert(issueRecoveryActions).values({ id: holdId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", ownerUserId: personOwned ? userId : null, returnOwnerAgentId: agentId,
      cause: "native_continuation_requires_reconciliation", fingerprint: `workspace-restore:${sourceRunId}`,
      nextAction: "Paperclip cannot recover the unsaved files from the previous run.",
      createdAt: minutesAgo(3), updatedAt: minutesAgo(3),
      evidence: { runId: sourceRunId, workspaceRestoreFailure: unsafeArchive ? "restore_unsafe_archive" : "restore_failed",
        workspaceRestoreRecovery: restoreRecovery, systemRecovery: spent,
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: sourceRunId, status: "blocked", stage: "verifying_stop",
          attempt: 1, attemptLimit: 6, retryable: true, requestIds: [] } } });

    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_children_completed", status: "queued", requestedByActorType: "system", requestedByActorId: "issue-children",
      payload: { issueId } });
    await db.insert(heartbeatRuns).values({ id: queuedRunId, companyId, agentId, issueId, invocationSource: "automation",
      triggerDetail: "system", status: "queued", wakeupRequestId: wakeId, createdAt: minutesAgo(2),
      scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_children_completed" } });
    await db.update(agentWakeupRequests).set({ runId: queuedRunId }).where(eq(agentWakeupRequests.id, wakeId));
    return { userId, companyId, agentId, issueId, sourceRunId, continuationId, holdId, queuedRunId };
  }

  async function runRow(id: string) {
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  }

  async function startedRunIds(companyId: string) {
    const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.startedAt} is not null`,
        inArray(heartbeatRuns.status, ["running", "succeeded"])));
    return rows.map(row => row.id);
  }

  it("does not hold the task behind the old run's workspace once the continuation moved it to a new epoch", async () => {
    const f = await killedRunAfterFreshContinuation();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.holdId)))[0])
      .toMatchObject({ status: "active" });
  });

  it.each([
    ["no continuation was recorded", { isolation: null }],
    ["the continuation reuses the old workspace", { isolation: "writer_ended" }],
    ["a person owns the hold", { personOwned: true }],
    ["the saved archive is unsafe", { unsafeArchive: true }],
  ] as const)("keeps the hold when %s", async (_name, shape) => {
    const f = await killedRunAfterFreshContinuation(shape);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.holdId });
  });

  it("starts the queued continuation at the execution gate instead of withholding it", async () => {
    held.reset();
    const f = await killedRunAfterFreshContinuation();
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
      await vi.waitFor(async () => {
        const queued = await runRow(f.queuedRunId);
        expect(queued.status).not.toBe("queued");
      }, { timeout: 20_000 });
      const queued = await runRow(f.queuedRunId);
      expect(queued.errorCode).not.toBe("execution_reconciliation_required");
      expect(await startedRunIds(f.companyId)).toEqual([f.queuedRunId]);
      expect(await runRow(f.sourceRunId)).toMatchObject({ status: "failed", errorCode: "native_restart_recovery_blocked" });
    } finally {
      held.release();
      await heartbeat.drainActiveRunExecutions();
    }
  }, 60_000);

  it("still withholds the queued run when a person owns the hold", async () => {
    held.reset();
    const f = await killedRunAfterFreshContinuation({ personOwned: true });
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
      await vi.waitFor(async () => expect((await runRow(f.queuedRunId)).status).toBe("cancelled"), { timeout: 20_000 });
      expect(await runRow(f.queuedRunId)).toMatchObject({ startedAt: null, errorCode: "execution_reconciliation_required" });
      expect(await startedRunIds(f.companyId)).toEqual([]);
    } finally {
      held.release();
      await heartbeat.drainActiveRunExecutions();
    }
  }, 60_000);
});
