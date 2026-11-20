import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../services/execution-blocker.ts";
import { settleHoldIntoAbandonedEpochContinuation } from "../services/fresh-continuation-fallback.ts";
import { HUMAN_GATE_EVIDENCE_KEYS, hasHumanGateEvidence } from "../services/recovery/human-gate-evidence.ts";
import { recoverRetainedWorkspace } from "../services/workspace-recovery.ts";
import { abandonUnverifiedRemoteWorkspaceEpoch } from "../services/remote-workspace-epoch-abandonment.ts";
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
    delivery?: "pending" | "delivered" | "delegated" | "invalidated" | "not_requested" | "coalesced";
    holdEvidence?: Record<string, unknown>;
    epoch?: "abandoned" | "still_owned" | "none";
  };

  async function killedRunAfterFreshContinuation(shape: Shape = {}) {
    const { isolation = "remote_epoch", personOwned = false, unsafeArchive = false, delivery = "delivered", holdEvidence = {}, epoch = "abandoned" } = shape;
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
    if (epoch !== "none") {
      const workspaceId = randomUUID(), leaseId = randomUUID(), snapshotId = randomUUID();
      const location = { environmentId: randomUUID(), leaseId, providerLeaseId: `sandbox-${sourceRunId}`,
        remoteCwd: `/home/daytona/paperclip-workspace/.paperclip-workspaces/${sourceRunId}` };
      await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, mode: "isolated_workspace",
        strategyType: "project_primary", name: "Task workspace", status: "active", providerType: "cloud_sandbox",
        cwd: `/workspaces/${workspaceId}`, sourceIssueId: issueId, metadata: { remoteWorkspace: {
          schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId, source: { kind: "empty" },
          writerRunId: sourceRunId, dirty: true, location } } });
      await db.update(heartbeatRuns).set({ runnerProfileJson: { remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1",
        workspaceId, leaseId, providerLeaseId: location.providerLeaseId, remoteCwd: location.remoteCwd, epoch: 1,
        state: "prepared", snapshotId } } }).where(eq(heartbeatRuns.id, sourceRunId));
      if (epoch === "abandoned") await db.transaction(tx => abandonUnverifiedRemoteWorkspaceEpoch(tx, { companyId, workspaceId,
        runId: sourceRunId, epoch: 1, snapshotId, location }));
    }
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

  async function holdRow(id: string) {
    return (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  }

  async function recoverHold(f: { companyId: string; issueId: string; sourceRunId: string; holdId: string }) {
    await recoverRetainedWorkspace({ db, companyId: f.companyId, issueId: f.issueId, runId: f.sourceRunId, actionId: f.holdId,
      environmentRuntime: {} as Parameters<typeof recoverRetainedWorkspace>[0]["environmentRuntime"] });
  }

  it.each(["pending", "delivered", "delegated", "not_requested"] as const)(
    "workspace recovery settles its late hold into a %s remote_epoch continuation of the same run", async delivery => {
    const f = await killedRunAfterFreshContinuation({ isolation: "remote_epoch", delivery });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.holdId });
    await recoverHold(f);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect(await holdRow(f.holdId)).toMatchObject({ status: "resolved", outcome: "restored",
      resolutionNote: "continued_fresh_from_last_saved", evidence: { coalescedIntoRecoveryActionId: f.continuationId } });
  });

  it.each([
    ["no continuation was recorded", { isolation: null }],
    ["the continuation is remote_epoch but the run still owns its epoch", { epoch: "still_owned" }],
    ["the continuation is remote_epoch but the run had no remote workspace", { epoch: "none" }],
    ["the continuation is a local fresh_isolated_workspace", { isolation: "fresh_isolated_workspace" }],
    ["the continuation reuses the old workspace", { isolation: "writer_ended" }],
    ["the continuation was invalidated", { delivery: "invalidated" }],
    ["the continuation was coalesced elsewhere", { delivery: "coalesced" }],
    ["a person owns the hold", { personOwned: true }],
    ["the saved archive is unsafe", { unsafeArchive: true }],
    ["the hold records an owner-gone attestation", { holdEvidence: { ownerGoneAttestation: { attestedBy: "board" } } }],
    ["the hold records an explicit continuation", { holdEvidence: { explicitUserContinuation: { runId: randomUUID() } } }],
    ["the hold records a reconciliation", { holdEvidence: { executionReconciliation: { runId: randomUUID() } } }],
    ["the hold records a null-valued owner-gone attestation", { holdEvidence: { ownerGoneAttestation: null } }],
  ] as const)("keeps the hold when %s", async (_name, shape) => {
    const f = await killedRunAfterFreshContinuation(shape);
    expect(await settleHoldIntoAbandonedEpochContinuation(db, { companyId: f.companyId, issueId: f.issueId,
      runId: f.sourceRunId, actionId: f.holdId })).toBe(false);
    expect(await holdRow(f.holdId)).toMatchObject({ status: "active" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.holdId });
  });

  it("treats a present human-gate key as a person's decision in both SQL and TypeScript, whatever its value", () => {
    for (const key of HUMAN_GATE_EVIDENCE_KEYS) {
      expect(hasHumanGateEvidence({ [key]: null })).toBe(true);
      expect(hasHumanGateEvidence({ [key]: false })).toBe(true);
    }
    expect(hasHumanGateEvidence({})).toBe(false);
    expect(hasHumanGateEvidence(null)).toBe(false);
  });

  it("starts the queued continuation at the execution gate once recovery settled its late hold", async () => {
    held.reset();
    const f = await killedRunAfterFreshContinuation({ isolation: "remote_epoch" });
    const heartbeat = heartbeatService(db);
    try {
      await recoverHold(f);
      await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
      await vi.waitFor(async () => expect((await runRow(f.queuedRunId)).status).not.toBe("queued"), { timeout: 20_000 });
      expect((await runRow(f.queuedRunId)).errorCode).not.toBe("execution_reconciliation_required");
      expect(await startedRunIds(f.companyId)).toEqual([f.queuedRunId]);
      expect(await runRow(f.sourceRunId)).toMatchObject({ status: "failed", errorCode: "native_restart_recovery_blocked" });
    } finally {
      held.release();
      await heartbeat.drainActiveRunExecutions();
    }
  }, 60_000);

  it("still withholds the queued run when a person owns the late hold", async () => {
    held.reset();
    const f = await killedRunAfterFreshContinuation({ isolation: "remote_epoch", personOwned: true });
    const heartbeat = heartbeatService(db);
    try {
      await recoverHold(f);
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
