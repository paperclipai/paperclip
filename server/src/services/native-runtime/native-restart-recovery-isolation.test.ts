import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, authUsers, companyMemberships, agents, applyPendingMigrations, companies, createDb, closeCheckpointDb, environmentLeases, environments, heartbeatRunEvents,
  heartbeatRuns, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";
import { requestTaskRetry, taskRetryMutationAllowed } from "../task-retry.js";
import { subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { claimNativeRestartRecoveries, NATIVE_RESTART_RECOVERY_FAILED } from "./native-restart-recovery.js";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

// An hourly routine has two open tasks. The older task's remote run failed with
// a scheduled resume, and its execution lock was released. The current hour's
// task holds the routine's execution slot. Startup recovery also meets a run
// whose claim fails for an unrelated reason. Neither may stop the batch.
(support.supported ? describe : describe.skip)("native restart recovery isolates one run's failure", () => {
  let db: ReturnType<typeof createDb>;
  let runtimeRoot: string;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const companyId = randomUUID();
  const agentId = randomUUID();
  beforeAll(async () => {
    if (externalUrl) {
      await applyPendingMigrations(externalUrl);
      db = createDb(externalUrl, { maxConnections: 2 });
    } else {
      temporary = await startEmbeddedPostgresTestDatabase("native-restart-recovery-isolation-");
      db = createDb(temporary.connectionString, { maxConnections: 2 });
    }
    await db.insert(companies).values({ id: companyId, name: "Restart isolation", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", adapterType: "paperclip_runner" });
    runtimeRoot = await mkdtemp(resolve(tmpdir(), "restart-isolation-authority-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "83".repeat(32));
  }, 30_000);
  afterAll(async () => {
    if (db) await closeCheckpointDb(db, 1);
    await db?.$client.end(); await temporary?.cleanup();
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function seedScheduledResume(options: { lock: "self" | "none"; routine?: { id: string; fingerprint: string } }) {
    const issueId = randomUUID(), runId = randomUUID(), sessionId = randomUUID();
    const failedAt = new Date(Date.now() - 5 * 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Hourly report", status: "in_progress",
      assigneeAgentId: agentId,
      ...(options.routine ? { originKind: "routine_execution", originId: options.routine.id,
        originFingerprint: options.routine.fingerprint } : {}) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", nativePhase: "retryable_failure", nativeSessionId: sessionId,
      processPid: 4_242, processStartedAt: failedAt, startedAt: failedAt, finishedAt: new Date(),
      errorCode: "native_session_interrupted", contextSnapshot: { issueId } });
    const [environment] = await db.insert(environments).values({ name: `Restart isolation ${runId}`, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      environmentId: environment.id, provider: "daytona", providerLeaseId: randomUUID(), status: "active",
      leasePolicy: "ephemeral", metadata: { driver: "sandbox", remoteCwd: "/work" } }).returning();
    await db.update(heartbeatRuns).set({ runnerProfileJson: {
      nativeExecutionInput: { binding: { companyId, issueId, runId, agentId } },
      nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
        baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: runId,
        leaseId: lease.id, providerLeaseId: lease.providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy",
      },
      sessionCheckpoint: { sessionId: "driver-session", providerSessionId: "provider-session",
        identity: { runId, companyId, issueId, agentId, sessionId } },
    } }).where(eq(heartbeatRuns.id, runId));
    if (options.lock === "self") {
      await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId, executionLockedAt: failedAt })
        .where(eq(issues.id, issueId));
    }
    const owner = { bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "retryable_failure", attempt: 1,
      controllerBootId: owner.bootId, controllerGeneration: owner.generation,
      leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000),
      nextAttemptAt: new Date(Date.now() - 60_000), recoveryState: "resuming_session",
      failureCode: "native_session_interrupted",
      failureDetail: { recoveryMode: "exact_checkpoint_resume", checkpointExists: true,
        providerSessionEstablished: true, providerEventsExist: false } });
    const authority = new DurablePrpControlPlane({ stateDirectory: resolve(runtimeRoot, runId),
      identity: { runId, normalizedSessionId: sessionId, runnerInstanceId: randomUUID(),
        environmentLeaseId: lease.id, turnId: randomUUID(), itemId: randomUUID() },
      expectedRunnerVersion: "restart-isolation-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    authority.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, {
      companyId, issueId, runId, authorityRunId: runId, ...owner,
    }));
    await authority.flushCheckpoint();
    await authority.stop();
    await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, runId));
    return { issueId, runId };
  }

  async function seedRoutineSlotHolder(routine: { id: string; fingerprint: string }) {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Hourly report", status: "in_progress",
      assigneeAgentId: agentId, originKind: "routine_execution", originId: routine.id,
      originFingerprint: routine.fingerprint });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "running",
      startedAt: new Date(), contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, issueId));
    return { issueId, runId };
  }

  async function rejectClaimsFor(runId: string) {
    const name = sql.raw(`reject_recovery_claim_${runId.replaceAll("-", "")}`);
    await db.execute(sql`create function ${name}() returns trigger language plpgsql as ${sql.raw(`$$
      begin
        if new.run_id = '${runId}' and new.phase = 'observed' then
          raise exception 'injected recovery claim failure';
        end if;
        return new;
      end $$`)}`);
    await db.execute(sql`create trigger ${name} before update on native_run_finalizations
      for each row execute function ${name}()`);
    return async () => {
      await db.execute(sql`drop trigger ${name} on native_run_finalizations`);
      await db.execute(sql`drop function ${name}()`);
    };
  }

  it("defers the routine collision and the failing run, claims the healthy run, and completes", async () => {
    const routine = { id: randomUUID(), fingerprint: "scheduled" };
    const older = await seedScheduledResume({ lock: "none", routine });
    const newer = await seedRoutineSlotHolder(routine);
    const failing = await seedScheduledResume({ lock: "self" });
    const healthy = await seedScheduledResume({ lock: "self" });
    const coordinator = async (runId: string) =>
      (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0]!;
    const task = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    const restore = await rejectClaimsFor(failing.runId);
    const heartbeat = heartbeatService(db);
    try {
      const now = new Date();
      const dispositions = await claimNativeRestartRecoveries({ db, restartKind: "hard", now,
        runIds: [older.runId, failing.runId, healthy.runId] });
      const byRun = new Map(dispositions.map(disposition => [disposition.runId, disposition]));
      expect(byRun.get(older.runId)).toEqual({ kind: "awaiting_evidence", runId: older.runId,
        reason: "routine_execution_busy", retryAt: new Date(now.getTime() + 30_000) });
      expect(byRun.get(failing.runId)).toEqual({ kind: "awaiting_evidence", runId: failing.runId,
        reason: NATIVE_RESTART_RECOVERY_FAILED, retryAt: new Date(now.getTime() + 30_000) });
      expect(byRun.get(healthy.runId)).toMatchObject({ kind: "reattach_remote_runner", runId: healthy.runId });

      // The losing transactions rolled back: no owner, lock, or attempt changed.
      expect(await coordinator(older.runId)).toMatchObject({ phase: "retryable_failure", attempt: 1, leaseOwner: null });
      expect(await coordinator(failing.runId)).toMatchObject({ phase: "retryable_failure", attempt: 1, leaseOwner: null });
      expect(await task(older.issueId)).toMatchObject({ executionRunId: null });
      expect(await task(newer.issueId)).toMatchObject({ executionRunId: newer.runId });
      expect(await task(failing.issueId)).toMatchObject({ executionRunId: failing.runId });

      // The startup entry point completes and records each deferral on its run.
      await expect(heartbeat.recoverNativeRunsAfterRestart(now, [older.runId, failing.runId]))
        .resolves.toMatchObject({ claims: [], awaitingEvidenceRunIds: expect.arrayContaining([older.runId, failing.runId]) });
      const events = await db.select({ runId: heartbeatRunEvents.runId, level: heartbeatRunEvents.level,
        payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
        inArray(heartbeatRunEvents.runId, [older.runId, failing.runId]),
        eq(heartbeatRunEvents.eventType, "native.recovery.transition")));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: older.runId, level: "info",
          payload: expect.objectContaining({ reason: "routine_execution_busy" }) }),
        expect.objectContaining({ runId: failing.runId, level: "warn",
          payload: expect.objectContaining({ reason: NATIVE_RESTART_RECOVERY_FAILED }) }),
      ]));
      expect(await coordinator(older.runId)).toMatchObject({ phase: "retryable_failure", attempt: 1 });
      expect(await task(newer.issueId)).toMatchObject({ executionRunId: newer.runId });
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await restore();
    }
  });

  it("normal remote original claim releases its exact Retry wait atomically across rollback and lost response", async () => {
    const f = await seedScheduledResume({ lock: "self" });
    const actorId = randomUUID();
    await db.insert(authUsers).values({ id: actorId, name: "Remote Retry operator",
      email: `${actorId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user",
      principalId: actorId, status: "active", membershipRole: "operator" });
    expect(await taskRetryMutationAllowed(db, { companyId, issueId: f.issueId,
      actorId, actorSource: "session" })).toBe(true);
    const receipt = await requestTaskRetry({ db, companyId, issueId: f.issueId,
      actorId, observedRunId: f.runId, idempotencyKey: randomUUID() });
    expect(receipt.requestId).toBeTruthy();
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
    const readWait = async (id: string) => (await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, id)))[0]!;
    const originalWait = await readWait(receipt.requestId!);
    expect(originalWait).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { executionWait: { reason: "native_checkpoint_recovery_pending" } } });
    const otherSource = randomUUID(), otherReason = randomUUID();
    const base = { companyId, agentId, source: "on_demand", triggerDetail: "manual",
      requestedByActorType: "user", requestedByActorId: actorId, reason: "task_retry", status: "deferred_issue_execution" };
    await db.insert(agentWakeupRequests).values([
      { ...base, id: otherSource, payload: { issueId: f.issueId,
        taskRetry: { schema: "paperclip.task-retry.v1", sourceRunId: randomUUID() },
        executionWait: { reason: "native_checkpoint_recovery_pending" } } },
      { ...base, id: otherReason, payload: { issueId: f.issueId,
        taskRetry: { schema: "paperclip.task-retry.v1", sourceRunId: f.runId },
        executionWait: { reason: "budget_hard_stop" } } },
    ]);
    const unrelated = [await readWait(otherSource), await readWait(otherReason)];
    const [originalRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId));
    const settled: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.deferredExecutionReceipts, (event, hints) => {
      if (event === "settled") settled.push(...hints ?? []);
    });
    const claim = (owner: typeof db) => claimNativeRestartRecoveries({ db: owner,
      restartKind: "hard", now: new Date(), runIds: [f.runId] });
    try {
      const rollback = new Error("remote-original-claim-outer-rollback");
      await expect(db.transaction(async tx => {
        expect(await claim(tx as unknown as typeof db)).toEqual([
          expect.objectContaining({ kind: "reattach_remote_runner", runId: f.runId })]);
        const [inside] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
        expect(inside.payload?.executionWait).toBeUndefined();
        expect(settled).toEqual([]);
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await readWait(receipt.requestId!)).toEqual(originalWait);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(originalRun);
      settled.length = 0;
      const lostReply = new Error("remote-original-claim-committed-application-response-lost");
      await expect((async () => {
        expect(await claim(db)).toEqual([
          expect.objectContaining({ kind: "reattach_remote_runner", runId: f.runId })]);
        throw lostReply;
      })()).rejects.toBe(lostReply);
      const released = await readWait(receipt.requestId!);
      expect(released).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(released.payload?.executionWait).toBeUndefined();
      expect(released.payload?.taskRetry).toEqual(originalWait.payload?.taskRetry);
      expect(settled).toContain(JSON.stringify({ companyId, requestId: receipt.requestId }));
      expect([await readWait(otherSource), await readWait(otherReason)]).toEqual(unrelated);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
        .toMatchObject({ executionRunId: f.runId, checkoutRunId: f.runId });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
        .toMatchObject({ status: "running", processPid: originalRun.processPid, runnerProfileJson: originalRun.runnerProfileJson });
      expect(await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId))).toEqual(leases);
      const hintCount = settled.length;
      expect(await claim(db)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "reattach_remote_runner", runId: f.runId })]));
      expect(settled).toHaveLength(hintCount);
    } finally { unsubscribe(); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);
});
