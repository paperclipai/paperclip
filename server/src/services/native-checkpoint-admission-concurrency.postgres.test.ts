import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, completionContracts, createDb, dotAgentBindings,
  dotRunnerAssignments, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, agentWakeupRequests,
  applyPendingMigrations, closeLivenessDb, closeCheckpointDb } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { prepareNativeHeartbeatRun } from "./native-runtime/prepare-native-run.js";
import { buildNativeExecutionInput } from "./native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "./native-runtime/runtime-context.test-fixture.js";
import type { StrictCompletionContractInput } from "../vendor/paperclip-runner/index.js";
import { requestTaskRetry, taskRetryMutationAllowed } from "./task-retry.js";
import { heartbeatService } from "./heartbeat.js";
import { currentControllerProcessStamp } from "./controller-process-identity.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { commitNativeStatusDecision, NativeStatusRaceError } from "./native-runtime/status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "./native-runtime/status-arbiter.js";
import * as checkpointAdmission from "./native-runtime/native-session-resumption-admission.js";
import { postgresErrorCode } from "./transient-lock-contention.js";

/** Real queue/committer locks and the existing 30s retry owner, never a fake lock manager. */
describe("native checkpoint Retry beside a status commit", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let databaseURL: string;
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_CHECKPOINT_ADMISSION_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("native-checkpoint-admission-");
    else await applyPendingMigrations(external);
    databaseURL = external ?? temporary!.connectionString;
    db = createDb(databaseURL, { maxConnections: 2 });
  }, 30_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    const failures: unknown[] = [];
    try { if (db) await closeLivenessDb(db, 1); } catch (error) { failures.push(error); }
    try { if (db) await closeCheckpointDb(db, 1); } catch (error) { failures.push(error); }
    try { await db?.$client.end({ timeout: 1 }); } catch (error) { failures.push(error); }
    try { await temporary?.cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Native checkpoint admission fixture cleanup failed");
  }, 30_000);
  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retry company", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue saved work", status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "failed",
      contextSnapshot: { issueId }, finishedAt: new Date() });
    return { db, companyId, issueId, actorId: "board", observedRunId: runId, idempotencyKey: randomUUID() };
  }
  async function nativeCheckpointRetryFixture(running: boolean) {
    const input = await seed();
    input.actorId = randomUUID();
    await db.insert(authUsers).values({ id: input.actorId, name: "Retry operator",
      email: `${input.actorId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: input.companyId, principalType: "user",
      principalId: input.actorId, status: "active", membershipRole: "operator" });
    expect(await taskRetryMutationAllowed(db, { companyId: input.companyId, issueId: input.issueId,
      actorId: input.actorId, actorSource: "session" })).toBe(true);
    const [issue] = await db.update(issues).set({ status: "in_progress", workMode: "standard",
      executionRunId: input.observedRunId, checkoutRunId: input.observedRunId }).where(eq(issues.id, input.issueId)).returning();
    const [initial] = await db.update(heartbeatRuns).set({ runtimeMode: "native", status: "running",
      nativeIssueId: issue.id, startedAt: new Date(), finishedAt: null }).where(eq(heartbeatRuns.id, input.observedRunId)).returning();
    const prepared = await prepareNativeHeartbeatRun({ db, run: initial, issue, environmentLeaseId: randomUUID() });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, initial.id));
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.id, run.completionContractId!));
    const bindingId = randomUUID();
    await db.insert(dotAgentBindings).values({ id: bindingId, companyId: input.companyId, agentId: run.agentId,
      operatorId: input.actorId, generation: 1, status: "ready", providerKind: "openai_dot" });
    const snapshot = { companyId: input.companyId, agentId: run.agentId, bindingId, bindingGeneration: 1,
      acceptByUnixMs: Date.now() + 60_000, expiresAtUnixMs: Date.now() + 3_600_000 };
    const execution = buildNativeExecutionInput({ companyId: input.companyId, agentId: run.agentId, runId: run.id,
      issue, taskPrompt: issue.title, normalizedSessionId: prepared.normalizedSessionId,
      provider: "openai_dot", dotBinding: snapshot,
      workspace: { id: randomUUID(), cwd: "/component/unused", repoUrl: null, repoRef: null, branchName: null },
      runtimeContext: nativeRuntimeContextFixture(), completionContract: { id: contract.id,
        sha256: contract.canonicalSha256, schemaVersion: contract.schemaVersion,
        contract: contract.contractJson as unknown as StrictCompletionContractInput } });
    await db.update(heartbeatRuns).set({ status: running ? "running" : "failed", finishedAt: running ? null : new Date(),
      nativePhase: running ? "observed" : "retryable_failure", driverKind: "openai_dot_mcp",
      runnerProfileJson: { ...run.runnerProfileJson, nativeExecutionInput: execution,
        sessionCheckpoint: { providerSessionId: "retained-component-checkpoint" } } }).where(eq(heartbeatRuns.id, run.id));
    const stamp = currentControllerProcessStamp();
    const [owner] = await db.insert(nativeRunFinalizations).values({ companyId: input.companyId, issueId: issue.id,
      runId: run.id, phase: running ? "observed" : "retryable_failure", attempt: 1, controllerGeneration: 1,
      recoveryState: running ? null : "resuming_session", nextAttemptAt: running ? null : new Date(Date.now() + 30_000),
      leaseOwner: running ? "component-original-controller" : null, leaseExpiresAt: running ? new Date(Date.now() + 60_000) : null,
      controllerBootId: stamp.bootId, controllerPid: stamp.pid, controllerHostHash: stamp.hostHash,
      controllerProcessStartedAt: stamp.processStartedAt ? new Date(stamp.processStartedAt) : null,
      failureDetail: running ? null : { recoveryMode: "exact_checkpoint_resume", checkpointExists: true, providerSessionEstablished: true } }).returning();
    const [assignment] = await db.insert(dotRunnerAssignments).values({ companyId: input.companyId, agentId: run.agentId,
      bindingId, bindingGeneration: 1, runId: run.id, normalizedSessionId: prepared.normalizedSessionId,
      turnId: randomUUID(), controllerGeneration: 1, catalogDigest: "component-original-catalog", status: "accepted",
      projection: {}, acceptBy: new Date(snapshot.acceptByUnixMs), expiresAt: new Date(snapshot.expiresAtUnixMs), acceptedAt: new Date() }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: input.companyId, issueId: issue.id,
      heartbeatRunId: run.id, provider: "component-original-owner", providerLeaseId: randomUUID(),
      status: "pending_cleanup", cleanupStatus: "failed", releasedAt: new Date() }).returning();
    return { input, owner, assignment, lease, run: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0] };
  }

  it.each([false, true])("retries the same saved native Retry after status-commit contention without duplicate work: running=%s", async running => {
    // Save the actual request while failed. A click on an already-running
    // source lawfully coalesces at request creation and never enters this race.
    const f = await nativeCheckpointRetryFixture(false);
    const receipt = await requestTaskRetry(f.input);
    if (!receipt.requestId) throw new Error("Normal Retry did not save its durable receipt");
    if (running) {
      const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId));
      expect(saved).toMatchObject({ status: "deferred_issue_execution", runId: null,
        requestedByActorId: f.input.actorId, payload: { taskRetry: { sourceRunId: f.run.id } } });
      // PREMISE ONLY, not proof of restoration: arrange the same canonical
      // already-restored tuple used by nativeCheckpointRetryFixture(true).
      // The saved Retry is untouched; Queue must authorize and coalesce it.
      const restored = await db.transaction(async tx => {
        const [task] = await tx.select({ id: issues.id }).from(issues).where(and(
          eq(issues.id, f.input.issueId), eq(issues.companyId, f.input.companyId),
          eq(issues.executionRunId, f.run.id), eq(issues.checkoutRunId, f.run.id),
        )).for("update");
        if (!task) throw new Error("Restored-source fixture task changed");
        const [owner] = await tx.update(nativeRunFinalizations).set({ phase: "observed", recoveryState: null,
          nextAttemptAt: null, failureDetail: null, leaseOwner: "component-original-controller",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }).where(and(eq(nativeRunFinalizations.companyId, f.input.companyId),
          eq(nativeRunFinalizations.issueId, f.input.issueId), eq(nativeRunFinalizations.runId, f.run.id),
          eq(nativeRunFinalizations.phase, "retryable_failure"), isNull(nativeRunFinalizations.resultId),
          isNull(nativeRunFinalizations.leaseOwner),
        )).returning();
        if (!owner) throw new Error("Restored-source fixture coordinator changed");
        const [run] = await tx.update(heartbeatRuns).set({ status: "running", finishedAt: null, nativePhase: "observed" })
          .where(and(eq(heartbeatRuns.id, f.run.id), eq(heartbeatRuns.companyId, f.input.companyId),
            eq(heartbeatRuns.agentId, f.run.agentId), eq(heartbeatRuns.nativeIssueId, f.input.issueId),
            eq(heartbeatRuns.status, "failed"))).returning();
        if (!run) throw new Error("Restored-source fixture run changed");
        return { owner, run };
      });
      f.owner = restored.owner; f.run = restored.run;
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId)))[0]).toEqual(saved);
    }
    const [before] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.input.issueId));
    const applicationName = "checkpoint-status-" + randomUUID();
    const committingDb = createDb(databaseURL, { maxConnections: 1, applicationName });
    const blockingDb = createDb(databaseURL, { maxConnections: 1 });
    const previousCommitDebug = committingDb.$client.options.debug;
    let committerIssuedCoordinatorLock = false, committerIssuedIssueLock = false, blockerObserved = false;
    committingDb.$client.options.debug = (connection, query, parameters, types) => {
      if (typeof previousCommitDebug === "function") previousCommitDebug(connection, query, parameters, types);
      const text = query.toLowerCase();
      if (text.includes('from "native_run_finalizations"') && text.includes("for update")) committerIssuedCoordinatorLock = true;
      if (text.includes('from "issues"') && text.includes("for update")) committerIssuedIssueLock = true;
    };
    const admissionErrors: unknown[] = [];
    let release!: () => void, releaseCoordinator!: () => void, coordinatorLocked!: () => void, queued!: () => void, second!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const holdCoordinator = new Promise<void>(resolve => { releaseCoordinator = resolve; });
    const coordinatorReady = new Promise<void>(resolve => { coordinatorLocked = resolve; });
    let blocking: Promise<unknown> | undefined;
    const queueAtIssue = new Promise<void>(resolve => { queued = resolve; });
    const secondAttempt = new Promise<void>(resolve => { second = resolve; });
    let queuePID: number | undefined, admissionCalls = 0, secondAt = 0;
    const actualPending = checkpointAdmission.pendingNativeCheckpointRetry;
    const admission = vi.spyOn(checkpointAdmission, "pendingNativeCheckpointRetry").mockImplementation(async (tx, input) => {
      if (input.runId === f.run.id) {
        admissionCalls++;
        if (admissionCalls === 1) {
          const [identity] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
          queuePID = identity.pid; queued(); await held;
        } else if (admissionCalls === 6) { secondAt = Date.now(); second(); }
        // The real stale committer must first roll back. This separate owner
        // then holds ONLY the coordinator row, never the task row, so the
        // public Retry can exhaust its normal five rolled-back attempts.
        if (admissionCalls > 1 && admissionCalls <= 5) await coordinatorReady;
      }
      // Retain the actual owner error before Queue/deferred handlers can consume it.
      return actualPending(tx, input).catch(error => {
        admissionErrors.push(error);
        if (admissionErrors.length === 1 && postgresErrorCode(error) === "55P03") {
          blocking = blockingDb.transaction(async tx => {
            const [owner] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
              .where(and(eq(nativeRunFinalizations.companyId, f.input.companyId),
                eq(nativeRunFinalizations.issueId, f.input.issueId), eq(nativeRunFinalizations.runId, f.run.id))).for("update");
            if (!owner) throw new Error("Original coordinator lock fixture changed");
            coordinatorLocked(); await holdCoordinator;
          });
          void blocking.catch(() => {});
        }
        if (admissionErrors.length === 5) releaseCoordinator();
        throw error;
      });
    });
    const failures: unknown[] = [], sqlStates: string[] = [];
    const allErrors = (error: unknown): unknown[] => {
      const values: unknown[] = [], seen = new Set<unknown>();
      const visit = (value: unknown) => {
        if (!value || typeof value !== "object" || seen.has(value) || values.length >= 24) return;
        seen.add(value); values.push(value);
        if (value instanceof AggregateError) for (const item of value.errors) visit(item);
        if ("cause" in value) visit(value.cause);
      };
      visit(error); return values;
    };
    const makeCoordinator = () => {
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
        onError: error => { failures.push(error); for (const value of allErrors(error)) { const code = postgresErrorCode(value); if (code) sqlStates.push(code); } } });
      let nextDeferred: (() => number | null) | undefined;
      const register = coordinator.register.bind(coordinator);
      coordinator.register = (queue, task) => {
        if (queue === DELIVERY_QUEUES.deferredExecutionReceipts) nextDeferred = () => task.nextRunAt?.() ?? null;
        return register(queue, task);
      };
      return { coordinator, next: () => nextDeferred?.() ?? null };
    };
    const firstOwner = makeCoordinator();
    let restarted: ReturnType<typeof makeCoordinator> | undefined;
    let ready: Promise<unknown> | undefined, committing: Promise<unknown> | undefined, primary: unknown;
    let commitError: unknown, actorOutcomesReported = false;
    onTestFailed(() => console.error("NATIVE_CHECKPOINT_LOCK_FRONTIER", JSON.stringify({
      committerIssuedCoordinatorLock, committerIssuedIssueLock, blockerObserved, admissionCalls,
      admission: admissionErrors.map(error => ({ name: error instanceof Error ? error.name : "unknown", sqlState: postgresErrorCode(error) })),
      committer: commitError ? { name: commitError instanceof Error ? commitError.name : "unknown", sqlState: postgresErrorCode(commitError) } : null,
      deferredErrors: failures.length, sqlStates,
    })));
    try {
      ready = heartbeatService(db).registerDeferredReceiptWork(firstOwner.coordinator, () => true).ready;
      void ready.catch(() => {});
      await queueAtIssue;
      committing = commitNativeStatusDecision({ db: committingDb, companyId: f.input.companyId,
        issueId: f.input.issueId, runId: f.run.id, assessmentId: randomUUID(), priorStatus: issue.status,
        priorStatusVersion: Number(issue.statusVersion) + 1, priorDecisionId: issue.lastStatusDecisionId,
        decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "preserve", toStatus: "blocked",
          reasonCode: "stale_checkpoint_admission_control", unblockDescriptor: null, effects: [] } })
        .catch(error => { commitError = error; const code = postgresErrorCode(error); if (code) sqlStates.push(code); });
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity
          where datname=current_database() and application_name=${applicationName} and wait_event_type='Lock'
            and ${queuePID!}=any(pg_blocking_pids(pid))) as waiting`);
        // pg_stat_activity.query is bounded; the owned driver's untruncated
        // call-through debug proves the real statements without a suffix guess.
        expect(committerIssuedCoordinatorLock).toBe(true);
        expect(committerIssuedIssueLock).toBe(true);
        expect(row.waiting).toBe(true);
      }, { timeout: 5_000 });
      blockerObserved = true;
      release(); await Promise.all([ready, committing]);
      // A deadlock in EITHER real actor is an original PostgreSQL failure, never an expected status refusal.
      if (sqlStates.includes("40P01") || admissionErrors.some(error => postgresErrorCode(error) === "40P01")) {
        actorOutcomesReported = true;
        throw new AggregateError([...new Set([...admissionErrors, ...failures, ...(commitError ? [commitError] : [])])], "Native Retry/status commit PostgreSQL deadlock");
      }
      expect(commitError).toBeInstanceOf(NativeStatusRaceError);
      expect(failures).toHaveLength(1);
      expect(allErrors(failures[0]).some(error => error instanceof Error && error.name === "NativeCheckpointAdmissionBusyError")).toBe(true);
      expect(sqlStates).not.toContain("40P01");
      expect(admissionErrors).toHaveLength(5);
      expect(admissionErrors.every(error => postgresErrorCode(error) === "55P03"
        && allErrors(error).some(value => value instanceof Error && value.name === "NativeCheckpointAdmissionBusyError"))).toBe(true);
      expect(postgresErrorCode(admissionErrors[0])).toBe("55P03");
      expect(allErrors(admissionErrors[0]).some(error => error instanceof Error && error.name === "NativeCheckpointAdmissionBusyError")).toBe(true);
      actorOutcomesReported = true;
      const retryAt = firstOwner.next();
      expect(retryAt).not.toBeNull();
      expect(retryAt!).toBeGreaterThan(Date.now());
      expect(retryAt!).toBeLessThanOrEqual(Date.now() + 30_000);
      const [busyWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId));
      expect(busyWake).toMatchObject({ id: before.id, status: "deferred_issue_execution", runId: null,
        requestedByActorId: f.input.actorId, idempotencyKey: before.idempotencyKey, payload: before.payload });
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0]).toEqual(f.owner);
      // Real existing scheduler waits its 30s failure deadline; this does not manually resume the queue.
      await secondAttempt;
      expect(secondAt).toBeGreaterThanOrEqual(retryAt!);
      await vi.waitFor(async () => {
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId));
        if (running) expect(wake).toMatchObject({ status: "coalesced", runId: f.run.id });
        else expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null,
          payload: { executionWait: { reason: "native_checkpoint_recovery_pending" } } });
      }, { timeout: 5_000 });
      await firstOwner.coordinator.stop();
      const [settledWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId));
      expect((await requestTaskRetry(f.input)).requestId).toBe(receipt.requestId);
      restarted = makeCoordinator();
      await heartbeatService(db).registerDeferredReceiptWork(restarted.coordinator, () => true).ready;
      const [restoredWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId));
      expect(restoredWake).toMatchObject({ id: settledWake.id, status: settledWake.status, runId: settledWake.runId,
        requestedByActorId: f.input.actorId, idempotencyKey: settledWake.idempotencyKey, payload: settledWake.payload });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.input.companyId))).toHaveLength(1);
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0]).toEqual(f.owner);
      expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, f.assignment.id)))[0]).toEqual(f.assignment);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
    } catch (error) { primary = error; throw error; }
    finally {
      release(); releaseCoordinator();
      const joins = await Promise.allSettled([...(ready ? [ready] : []), ...(committing ? [committing] : []), ...(blocking ? [blocking] : [])]);
      const cleanup = joins.filter(value => value.status === "rejected").map(value => value.reason);
      if (!actorOutcomesReported) cleanup.push(...new Set([...admissionErrors, ...failures, ...(commitError ? [commitError] : [])]));
      for (const stop of [() => firstOwner.coordinator.stop(), () => restarted?.coordinator.stop(),
        () => committingDb.$client.end({ timeout: 1 }), () => blockingDb.$client.end({ timeout: 1 })]) {
        try { await stop(); } catch (error) { cleanup.push(error); }
      }
      admission.mockRestore();
      committingDb.$client.options.debug = previousCommitDebug;
      if (cleanup.length) throw new AggregateError([...(primary ? [primary] : []), ...cleanup], "Native checkpoint Retry concurrency cleanup failed");
    }
  }, 90_000);
});
