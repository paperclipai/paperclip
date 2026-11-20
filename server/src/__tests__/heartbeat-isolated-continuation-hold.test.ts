import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentTaskSessions, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueRecoveryActions, issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../services/execution-blocker.ts";
import { readFreshWorkspaceReadiness } from "../services/fresh-workspace-continuation.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { createSystemRecovery, failSystemRecovery, reserveSystemRecoveryAttempt, SystemRecoveryFailure } from "../services/system-recovery-state.ts";

const held = vi.hoisted(() => {
  const state = {
    release: () => undefined as void,
    calls: [] as Array<Record<string, unknown>>,
    released: Promise.resolve(),
    reset() {
      state.released = new Promise<void>((resolve) => { state.release = resolve; });
      state.calls = [];
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
      execute: async (input: Record<string, unknown>) => {
        held.calls.push(input);
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
    delivery?: "pending" | "delivered" | "invalidated" | "not_requested" | "coalesced";
    savedInput?: boolean;
    holdEvidence?: Record<string, unknown>;
    previousCwd?: string;
  };

  async function killedRunAfterFreshContinuation(shape: Shape = {}) {
    const { isolation = "remote_epoch", personOwned = false, unsafeArchive = false, delivery = "delivered",
      holdEvidence = {}, previousCwd, savedInput = false } = shape;
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
          continuationDelivery: delivery,
          ...(delivery === "delivered" ? { continuationRunId: queuedRunId, continuationSupersededByRun: true } : {}) } });
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
          attempt: 1, attemptLimit: 6, retryable: true, requestIds: [] }, ...holdEvidence } });
    if (savedInput) await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", triggerDetail: "manual",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId } });
    if (previousCwd) await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "codex_local", taskKey: issueId,
      sessionParamsJson: { sessionId: "previous-session", cwd: previousCwd }, sessionDisplayId: "previous-session", lastRunId: sourceRunId });

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

  it.each([
    ["a delivered remote_epoch continuation", { isolation: "remote_epoch" }],
    ["a pending remote_epoch continuation", { isolation: "remote_epoch", delivery: "pending" }],
    ["a delivered fresh_isolated_workspace continuation", { isolation: "fresh_isolated_workspace" }],
    ["a pending fresh_isolated_workspace continuation", { isolation: "fresh_isolated_workspace", delivery: "pending" }],
    ["a remote_epoch continuation that saved a person's input", { isolation: "remote_epoch", delivery: "not_requested", savedInput: true }],
  ] as const)("does not hold the task behind the old run's workspace after %s", async (_name, shape) => {
    const f = await killedRunAfterFreshContinuation(shape);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.holdId)))[0])
      .toMatchObject({ status: "active" });
  });

  it.each([
    ["no continuation was recorded", { isolation: null }],
    ["the continuation reuses the old workspace", { isolation: "writer_ended" }],
    ["a person owns the hold", { personOwned: true }],
    ["the saved archive is unsafe", { unsafeArchive: true }],
    ["the continuation was invalidated before it started", { delivery: "invalidated" }],
    ["the continuation only repaired the workspace", { delivery: "not_requested" }],
    ["the record was coalesced into another continuation", { delivery: "coalesced" }],
    ["the continuation was invalidated in a new workspace", { isolation: "fresh_isolated_workspace", delivery: "invalidated" }],
    ["the hold records an owner-gone attestation", { holdEvidence: { ownerGoneAttestation: { attestedBy: "board" } } }],
    ["the hold records an explicit continuation", { holdEvidence: { explicitUserContinuation: { runId: randomUUID() } } }],
    ["the hold records a reconciliation", { holdEvidence: { executionReconciliation: { runId: randomUUID() } } }],
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

  it("starts the queued continuation in a new attempt directory when the continuation isolated a local workspace", async () => {
    held.reset();
    const previousCwd = await mkdtemp(path.join(os.tmpdir(), "isolated-continuation-old-"));
    await writeFile(path.join(previousCwd, "unverified.txt"), "written by the old run\n");
    const f = await killedRunAfterFreshContinuation({ isolation: "fresh_isolated_workspace", delivery: "pending", previousCwd });
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
      await vi.waitFor(async () => expect(await startedRunIds(f.companyId)).toEqual([f.queuedRunId]), { timeout: 20_000 });
      const started = await runRow(f.queuedRunId);
      expect(started.contextSnapshot).toMatchObject({ freshContinuationIsolation: f.continuationId, forceFreshSession: true });
      expect(await readFreshWorkspaceReadiness(db, started)).toMatchObject({ mode: "fresh_isolated_workspace", sourceRunId: f.sourceRunId });
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.continuationId)))[0]!.evidence)
        .toMatchObject({ continuationDelivery: "delivered", continuationRunId: f.queuedRunId });
      await vi.waitFor(() => expect(held.calls).toHaveLength(1), { timeout: 20_000 });
      const call = held.calls[0]!;
      const workspace = (call.context as { paperclipWorkspace?: { cwd?: string; mode?: string } }).paperclipWorkspace;
      expect(workspace).toMatchObject({ mode: "isolated_workspace", cwd: expect.stringContaining("isolated-workspace-attempts") });
      expect(workspace?.cwd).not.toBe(previousCwd);
      expect(call.runtime).toMatchObject({ sessionId: null, sessionParams: null });
    } finally {
      held.release();
      await heartbeat.drainActiveRunExecutions();
      await rm(previousCwd, { recursive: true, force: true });
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
