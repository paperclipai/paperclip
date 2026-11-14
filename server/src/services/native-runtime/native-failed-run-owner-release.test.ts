import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases,
  heartbeatRuns,
  issues,
  issueRecoveryActions,
  nativeRunFinalizations,
  subscribeDatabaseWork,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { agentExecutionsHaveStopped } from "../agent-execution-stop.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { currentProcessSpaceHash } from "../controller-process-identity.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { environmentService } from "../environments.js";
import { executionControlSchedule } from "../execution-control-work.js";
import { reconcileAbandonedExecutionControl } from "../execution-control-reconciliation.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";
import {
  nextAbandonedNativeOwnerReleaseAt,
  releaseAbandonedNativeOwners,
  resetAbandonedNativeOwnerReleaseForTests,
  settleUnstartedNativeSessionResume,
} from "./native-failed-run-owner-release.js";

import * as controllerProcess from "../controller-process-identity.js";

const LEASE_FAILURE = 'Failed to acquire lease for environment "Managed computer" (sandbox): Sandbox creation has failed';

describe("failed native run owner release", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-owner-release-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => temporary?.cleanup());
  // The release deadline is instance-wide; keep each case's rows to itself.
  afterEach(async () => {
    resetAbandonedNativeOwnerReleaseForTests();
    await db.delete(environmentLeases);
    await db.delete(nativeRunFinalizations);
  });

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Owner release", issuePrefix: `OR${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Resume agent", adapterType: "codex_local", status: "running" });
  });

  async function nativeRun(input: {
    status: string;
    errorCode?: string;
    error?: string;
    coordinator: Partial<typeof nativeRunFinalizations.$inferInsert>;
    runId?: string;
  }) {
    const issueId = randomUUID();
    const runId = input.runId ?? randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Resume the native run", status: "in_progress",
      assigneeAgentId: agentId, workMode: "standard" });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, nativeIssueId: issueId, status: input.status, runtimeMode: "native",
      runtimeModeResolvedAt: new Date(), contextSnapshot: { issueId },
      startedAt: new Date(), finishedAt: input.status === "running" ? null : new Date(),
      errorCode: input.errorCode ?? null, error: input.error ?? null,
      runnerProfileJson: {
        mode: "native",
        nativeExecutionInput: { schema: "paperclip.native-execution-input.v1", binding: { runId } },
        sessionCheckpoint: { backendKind: "codex_app_server", sessionId: "persisted-session", identity: { runId },
          providerSessionId: "provider-session", activeTurnId: "active-turn" },
      },
    });
    const current = await controllerProcess.currentControllerProcess();
    expect(current.hostHash).not.toBe("unknown");
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 1,
      controllerHostHash: current.hostHash, ...input.coordinator } as typeof nativeRunFinalizations.$inferInsert);
    return { runId, issueId };
  }

  const coordinator = async (runId: string) =>
    (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0]!;

  /** What the heartbeat setup-failure path writes; it never touches the coordinator. */
  async function failRunDuringSetup(runId: string, errorCode = "setup_failed", error = LEASE_FAILURE) {
    await db.update(heartbeatRuns).set({ status: "failed", errorCode, error, finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
  }

  it("releases a session resume that failed at environment lease acquisition", async () => {
    const { runId } = await nativeRun({ status: "failed", errorCode: "native_session_interrupted",
      coordinator: { phase: "retryable_failure", nextAttemptAt: new Date(0), recoveryState: "resuming_session" } });
    const [claim] = await claimNativeSessionResumptions({ db, runnerInstanceId: "default", runIds: [runId] });
    expect(claim).toEqual({ runId, leaseOwner: expect.stringContaining("default:resume:"), attempt: 1 });
    expect(await coordinator(runId)).toMatchObject({ phase: "observed", leaseOwner: claim!.leaseOwner });
    await failRunDuringSetup(runId);
    // This is the leaked state that kept the agent in `pausing`.
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);

    await expect(settleUnstartedNativeSessionResume(db, claim!)).resolves.toBe(true);

    expect(await coordinator(runId)).toMatchObject({
      phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null, recoveryState: "blocked",
      failureCode: "setup_failed", resultId: null,
      failureDetail: expect.objectContaining({ message: LEASE_FAILURE, originalFailureCode: "setup_failed",
        releasedOwner: { reason: "unstarted_resume", leaseOwner: claim!.leaseOwner, attempt: 1 } }),
    });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0])
      .toMatchObject({ status: "failed", nativePhase: "terminal_failure" });
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
      eq(activityLog.action, "native.failed_run_owner_released")))).toHaveLength(1);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    // Settlement is idempotent.
    await expect(settleUnstartedNativeSessionResume(db, claim!)).resolves.toBe(false);
  });

  it("leaves an owner the native executor claimed, and a run that is still running", async () => {
    const { runId } = await nativeRun({ status: "failed",
      coordinator: { phase: "retryable_failure", nextAttemptAt: new Date(0) } });
    const [claim] = await claimNativeSessionResumptions({ db, runnerInstanceId: "default", runIds: [runId] });
    // Still preparing: the run has not ended.
    await expect(settleUnstartedNativeSessionResume(db, claim!)).resolves.toBe(false);
    // A failed run whose recorded process is still alive keeps its owner.
    await failRunDuringSetup(runId);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
    await once(child, "spawn");
    try {
      await db.update(heartbeatRuns).set({ processPid: child.pid! }).where(eq(heartbeatRuns.id, runId));
      await expect(settleUnstartedNativeSessionResume(db, claim!)).resolves.toBe(false);
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await db.update(heartbeatRuns).set({ status: "running", processPid: null }).where(eq(heartbeatRuns.id, runId));
    // The executor's claim bumps the attempt; its own failure path owns settlement.
    await db.update(nativeRunFinalizations).set({ attempt: 2 }).where(eq(nativeRunFinalizations.runId, runId));
    await failRunDuringSetup(runId, "adapter_failed", "provider turn failed");
    await expect(settleUnstartedNativeSessionResume(db, claim!)).resolves.toBe(false);
    expect(await coordinator(runId)).toMatchObject({ phase: "observed", leaseOwner: claim!.leaseOwner, attempt: 2 });
  });

  it("reaps an already leaked owner on a failed run so the agent can stop", async () => {
    const leaseOwner = `default:resume:${randomUUID()}`;
    const { runId } = await nativeRun({ status: "failed", errorCode: "adapter_failed",
      error: "runner_state_identity_mismatch: session_scope_mismatch",
      coordinator: { leaseOwner, leaseExpiresAt: new Date(Date.now() - 60_000), recoveryState: "resuming_session" } });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    expect(await nextAbandonedNativeOwnerReleaseAt(db)).not.toBeNull();

    const reconciled = await reconcileAbandonedExecutionControl(db);
    expect(reconciled.releasedOwners).toBe(1);

    expect(await coordinator(runId)).toMatchObject({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null,
      recoveryState: "blocked", failureCode: "adapter_failed",
      failureDetail: expect.objectContaining({ releasedOwner: { reason: "expired_owner", leaseOwner, attempt: 1 } }) });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    // Nothing is left to schedule once the owner is settled.
    expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();
  });

  it.each(["null", "foreign", "unknown-current"] as const)("keeps a failed namespace-held source out of automatic expired-owner release: %s", async mode => {
    const actual = await controllerProcess.currentControllerProcess();
    expect(actual.hostHash).not.toBe("unknown");
    const recordedPid = 2_000_000_001;
    const { runId } = await nativeRun({ status: "failed", errorCode: "setup_failed",
      coordinator: { leaseOwner: `foreign-controller:${randomUUID()}`, leaseExpiresAt: new Date(0),
        controllerBootId: randomUUID(), controllerPid: recordedPid,
        controllerHostHash: mode === "null" ? null : mode === "foreign" ? `foreign:${actual.hostHash}` : actual.hostHash,
        recoveryState: "awaiting_evidence" } });
    await db.update(heartbeatRuns).set({ processPid: recordedPid, processGroupId: recordedPid })
      .where(eq(heartbeatRuns.id, runId));
    const before = await coordinator(runId);
    const originalKill = process.kill.bind(process);
    const probes: number[] = [];
    const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (Math.abs(pid) === recordedPid && signal === 0) {
        probes.push(pid);
        throw Object.assign(new Error("controlled local PID absent; not foreign stop proof"), { code: "ESRCH" });
      }
      return originalKill(pid, signal);
    });
    const identity = mode === "unknown-current" ? vi.spyOn(controllerProcess, "currentProcessSpaceHash")
      .mockReturnValue("unknown") : null;
    try {
      expect(await releaseAbandonedNativeOwners(db)).toBe(0);
      expect(probes).toEqual([]);
      expect(await coordinator(runId)).toEqual(before);
      const [attention] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, before.issueId));
      expect(attention).toMatchObject({ cause: "native_restart_recovery_blocked", attemptCount: 0, wakePolicy: null, monitorPolicy: null,
        evidence: { runId, reason: "controller_process_space_unverified" } });
      for (let inspection = 0; inspection < 3; inspection++) {
        expect(await releaseAbandonedNativeOwners(db)).toBe(0);
        expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();
        expect(await executionControlSchedule(db).finalization()).toBeNull();
      }
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, before.issueId))).toEqual([attention]);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
        eq(activityLog.action, "native.failed_run_owner_released")))).toHaveLength(0);
    } finally { identity?.mockRestore(); probe.mockRestore(); }
  });

  it.each(["timed_out", "interrupted"] as const)("publishes quiet operator attention after an already %s owner expires", async status => {
    const { runId, issueId } = await nativeRun({ status, coordinator: { leaseOwner: `foreign:${randomUUID()}`,
      controllerBootId: randomUUID(), controllerHostHash: null, leaseExpiresAt: new Date(0) } });
    expect(await releaseAbandonedNativeOwners(db)).toBe(0);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toMatchObject({ ownerType: "board", cause: "native_restart_recovery_blocked", attemptCount: 0,
      evidence: { runId, reason: "controller_process_space_unverified", controllerAuthority: { digest: expect.any(String) } } });
    expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();
    expect(await coordinator(runId)).toMatchObject({ phase: "observed", leaseOwner: expect.any(String) });
  });

  it("keeps empty deadline and release scans from stamping controller ownership", async () => {
    const stamped = vi.fn();
    const unsubscribe = controllerProcess.onControllerStamp(stamped);
    try {
      expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();
      expect(await releaseAbandonedNativeOwners(db)).toBe(0);
      expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();
      expect(stamped).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it("retains a foreign owner's original deadline until its returned unstarted claim settles", async () => {
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    const leaseOwner = `default:resume:${randomUUID()}`;
    // This dispatched claim returned before the executor took an attempt. Its
    // exact returned token/attempt, not the PID or lease age, authorizes release.
    const { runId, issueId } = await nativeRun({ status: "failed", errorCode: "setup_failed",
      coordinator: { leaseOwner, leaseExpiresAt, controllerBootId: randomUUID(),
        controllerHostHash: `foreign:${currentProcessSpaceHash()}` } });
    const before = await coordinator(runId);
    expect((await nextAbandonedNativeOwnerReleaseAt(db))?.getTime()).toBe(leaseExpiresAt.getTime());
    expect(await releaseAbandonedNativeOwners(db)).toBe(0);
    expect(await coordinator(runId)).toEqual(before);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toEqual([]);
    expect(await settleUnstartedNativeSessionResume(db, { runId, leaseOwner, attempt: before.attempt })).toBe(true);
    expect(await coordinator(runId)).toMatchObject({ phase: "terminal_failure", leaseOwner: null });
    expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toEqual([]);
  });

  it("surfaces a foreign owner only at its original expiry without stamping or probing it", async () => {
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    const recordedPid = 2_000_000_001;
    const { runId, issueId } = await nativeRun({ status: "failed", coordinator: {
      leaseOwner: `foreign:${randomUUID()}`, leaseExpiresAt, controllerBootId: randomUUID(),
      controllerPid: recordedPid, controllerHostHash: null } });
    const before = await coordinator(runId);
    const stamped = vi.fn();
    const unsubscribe = controllerProcess.onControllerStamp(stamped);
    const kill = process.kill.bind(process);
    const probes: number[] = [];
    const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (Math.abs(pid) === recordedPid && signal === 0) {
        probes.push(pid);
        throw Object.assign(new Error("foreign PID is not local stop evidence"), { code: "ESRCH" });
      }
      return kill(pid, signal);
    });
    try {
      expect((await nextAbandonedNativeOwnerReleaseAt(db))?.getTime()).toBe(leaseExpiresAt.getTime());
      expect(await releaseAbandonedNativeOwners(db, new Date(leaseExpiresAt.getTime() - 1))).toBe(0);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toEqual([]);
      expect(await releaseAbandonedNativeOwners(db, leaseExpiresAt)).toBe(0);
      const [attention] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(attention).toMatchObject({ status: "active", ownerType: "board", attemptCount: 0,
        wakePolicy: null, monitorPolicy: null, evidence: { runId, reason: "controller_process_space_unverified" } });
      expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();
      expect(await releaseAbandonedNativeOwners(db, leaseExpiresAt)).toBe(0);
      expect(await coordinator(runId)).toEqual(before);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toEqual([attention]);
      expect(probes).toEqual([]);
      expect(stamped).not.toHaveBeenCalled();
    } finally { probe.mockRestore(); unsubscribe(); }
  });

  it("finishes each requested namespace inspection pass and preserves the original local deadline", async () => {
    const foreign = [];
    for (let index = 0; index < 5; index++) foreign.push(await nativeRun({ status: "failed", coordinator: {
      leaseOwner: `foreign:${randomUUID()}`, controllerHostHash: null, leaseExpiresAt: new Date(0) } }));
    const localDeadline = new Date(Date.now() + 600_000);
    await nativeRun({ status: "failed", coordinator: { leaseOwner: `local:${randomUUID()}`, leaseExpiresAt: localDeadline } });
    for (let page = 0; page < 2; page++) {
      expect(await releaseAbandonedNativeOwners(db, new Date(), 2)).toBe(0);
      expect((await nextAbandonedNativeOwnerReleaseAt(db))!.getTime()).toBeLessThan(localDeadline.getTime());
    }
    expect(await releaseAbandonedNativeOwners(db, new Date(), 2)).toBe(0);
    expect((await nextAbandonedNativeOwnerReleaseAt(db))?.getTime()).toBe(localDeadline.getTime());
    const rows = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    expect(rows).toHaveLength(foreign.length);
    expect(rows.every(row => row.attemptCount === 0 && row.wakePolicy === null && row.monitorPolicy === null)).toBe(true);
    // Deadline reads do not request another pass or turn surfaced holds into timers.
    for (let read = 0; read < 2; read++) {
      expect((await nextAbandonedNativeOwnerReleaseAt(db))?.getTime()).toBe(localDeadline.getTime());
    }
    // A later explicit mutation inspection must recheck all retained authorities.
    // Finish its known three-page pass before expecting the local timer again.
    expect(await releaseAbandonedNativeOwners(db, new Date(), 2)).toBe(0);
    expect((await nextAbandonedNativeOwnerReleaseAt(db))!.getTime()).toBeLessThan(localDeadline.getTime());
    expect(await releaseAbandonedNativeOwners(db, new Date(), 2)).toBe(0);
    expect((await nextAbandonedNativeOwnerReleaseAt(db))!.getTime()).toBeLessThan(localDeadline.getTime());
    expect(await releaseAbandonedNativeOwners(db, new Date(), 2)).toBe(0);
    expect((await nextAbandonedNativeOwnerReleaseAt(db))?.getTime()).toBe(localDeadline.getTime());
    const reinspected = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    const byId = (a: typeof rows[number], b: typeof rows[number]) => a.id.localeCompare(b.id);
    expect(reinspected.sort(byId)).toEqual([...rows].sort(byId));
  });

  it("keeps a lower-sorting arrival durable when its notification coalesces between inspection pages", async () => {
    for (let index = 1; index <= 4; index++) await nativeRun({ status: "failed",
      runId: `ffffffff-ffff-4fff-8fff-${String(index).padStart(12, "0")}`, coordinator: {
        leaseOwner: `foreign:${randomUUID()}`, controllerHostHash: null, leaseExpiresAt: new Date(0) } });
    expect(await releaseAbandonedNativeOwners(db, new Date(), 2)).toBe(0);
    const lower = await nativeRun({ status: "failed", runId: "00000000-0000-4000-8000-000000000001", coordinator: {
      leaseOwner: `foreign:${randomUUID()}`, controllerHostHash: null, leaseExpiresAt: new Date(0) } });
    // Simulate one coalesced dirty signal by continuing the actual existing
    // page, not resetting its cursor or creating a second artificial worker.
    expect(await releaseAbandonedNativeOwners(db, new Date(), 2)).toBe(0);
    expect(await nextAbandonedNativeOwnerReleaseAt(db)).not.toBeNull();
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, lower.issueId))).toEqual([]);
    expect(await releaseAbandonedNativeOwners(db, new Date(), 2)).toBe(0);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, lower.issueId))).toHaveLength(1);
    expect(await releaseAbandonedNativeOwners(db, new Date(), 5)).toBe(0);
    expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();
  });

  it("surfaces a preserved namespace waiter when an unrelated action is actually resolved", async () => {
    const { runId, issueId } = await nativeRun({ status: "failed", coordinator: {
      leaseOwner: `foreign:${randomUUID()}`, controllerHostHash: null, leaseExpiresAt: new Date(0) } });
    const service = issueRecoveryActionService(db);
    const unrelated = await service.upsertSourceScoped({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "independent-test-recovery", fingerprint: "independent-test-identity", ownerType: "board",
      nextAction: "Resolve this independently owned action first.", wakePolicy: null, monitorPolicy: null, attemptCount: 0 });
    expect(await releaseAbandonedNativeOwners(db)).toBe(0);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))[0].id).toBe(unrelated.id);
    expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();
    expect(await committedWakes(DELIVERY_QUEUES.executionFinalization, () => service.resolveActiveForIssue({ companyId,
      sourceIssueId: issueId, actionId: unrelated.id, status: "resolved", outcome: "restored" }))).toBeGreaterThan(0);
    expect(await releaseAbandonedNativeOwners(db)).toBe(0);
    const rows = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === unrelated.id)).toMatchObject({ status: "resolved", fingerprint: "independent-test-identity" });
    expect(rows.find(row => row.id !== unrelated.id)).toMatchObject({ attemptCount: 0,
      evidence: { runId, reason: "controller_process_space_unverified" } });
    expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();
  });

  it("keeps an unexpired owner blocking the stop check and schedules its expiry", async () => {
    const leaseExpiresAt = new Date(Date.now() + 10 * 60_000);
    const { runId } = await nativeRun({ status: "failed", errorCode: "setup_failed", error: LEASE_FAILURE,
      coordinator: { leaseOwner: `default:resume:${randomUUID()}`, leaseExpiresAt } });

    await expect(releaseAbandonedNativeOwners(db)).resolves.toBe(0);
    expect(await coordinator(runId)).toMatchObject({ phase: "observed", leaseOwner: expect.any(String) });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    expect((await nextAbandonedNativeOwnerReleaseAt(db))?.getTime()).toBe(leaseExpiresAt.getTime());
    expect(await executionControlSchedule(db).finalization()).toBe(leaseExpiresAt.getTime());
  });

  it("does not reap while the run's environment lease or controller may still be live", async () => {
    const leaseOwner = `default:resume:${randomUUID()}`;
    const { runId, issueId } = await nativeRun({ status: "failed", errorCode: "adapter_failed",
      coordinator: { leaseOwner, leaseExpiresAt: new Date(0) } });
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      provider: "test", providerLeaseId: `lease-${runId}`, status: "active" }).returning();
    await expect(releaseAbandonedNativeOwners(db)).resolves.toBe(0);
    // An unreleased sandbox is outside this pass, so it is not polled for.
    expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();

    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, lease!.id));
    const controller = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
    await once(controller, "spawn");
    try {
      await db.update(nativeRunFinalizations).set({ controllerPid: controller.pid!, controllerBootId: randomUUID() })
        .where(eq(nativeRunFinalizations.runId, runId));
      await expect(releaseAbandonedNativeOwners(db)).resolves.toBe(0);
      expect(await coordinator(runId)).toMatchObject({ phase: "observed", leaseOwner });
    } finally {
      const exited = once(controller, "exit");
      controller.kill("SIGKILL");
      await exited;
    }
    await expect(releaseAbandonedNativeOwners(db)).resolves.toBe(1);
    expect(await coordinator(runId)).toMatchObject({ phase: "terminal_failure", leaseOwner: null });
  });

  /** Records committed wake signals for one delivery queue while `work` runs. */
  async function committedWakes(topic: string, work: () => Promise<unknown>) {
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, topic, event => { events.push(event); });
    try { await work(); } finally { unsubscribe(); }
    return events.filter(event => event === "settled").length;
  }

  it("wakes cost accounting when it settles an owner", async () => {
    const { runId } = await nativeRun({ status: "failed", errorCode: "adapter_failed",
      coordinator: { leaseOwner: `default:resume:${randomUUID()}`, leaseExpiresAt: new Date(0) } });
    await db.update(heartbeatRuns).set({ costAccountingPending: true }).where(eq(heartbeatRuns.id, runId));
    expect(await committedWakes(DELIVERY_QUEUES.accounting, () => releaseAbandonedNativeOwners(db))).toBeGreaterThan(0);
    expect(await coordinator(runId)).toMatchObject({ phase: "terminal_failure", leaseOwner: null });
  });

  it("wakes the finalization queue when the run's environment lease settles", async () => {
    const leaseOwner = `default:resume:${randomUUID()}`;
    const { runId, issueId } = await nativeRun({ status: "failed", errorCode: "adapter_failed",
      coordinator: { leaseOwner, leaseExpiresAt: new Date(0) } });
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      provider: "test", providerLeaseId: `lease-${runId}`, status: "active" }).returning();
    // Blocked and unscheduled while the sandbox lease is unsettled.
    expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();
    expect(await committedWakes(DELIVERY_QUEUES.executionFinalization,
      () => environmentService(db).releaseLease(lease!.id, "released", { cleanupStatus: "success" }))).toBeGreaterThan(0);
    expect(await nextAbandonedNativeOwnerReleaseAt(db)).not.toBeNull();
    await expect(releaseAbandonedNativeOwners(db)).resolves.toBe(1);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
  });

  it("ignores a recorded process and group whose PID now belongs to another process", async () => {
    const { runId } = await nativeRun({ status: "failed", errorCode: "adapter_failed",
      coordinator: { leaseOwner: `default:resume:${randomUUID()}`, leaseExpiresAt: new Date(0) } });
    // A detached child leads its own group, as a local native runner does.
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore", detached: true });
    await once(unrelated, "spawn");
    try {
      await db.update(heartbeatRuns).set({ processPid: unrelated.pid!, processGroupId: unrelated.pid!,
        processStartedAt: new Date("2020-01-01T00:00:00.000Z") }).where(eq(heartbeatRuns.id, runId));
      await expect(releaseAbandonedNativeOwners(db)).resolves.toBe(1);
      expect(await coordinator(runId)).toMatchObject({ phase: "terminal_failure", leaseOwner: null });
    } finally {
      const exited = once(unrelated, "exit");
      unrelated.kill("SIGKILL");
      await exited;
    }
  });

  // Phase 2: run processes and controllers are judged by the shared prover.
  it("never releases on a dead PID recorded in another PID space", async () => {
    const { runId } = await nativeRun({ status: "failed", errorCode: "adapter_failed",
      coordinator: { leaseOwner: `default:resume:${randomUUID()}`, leaseExpiresAt: new Date(0) } });
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_001, processGroupId: null,
      processStartedAt: new Date(Date.now() - 60_000), processHostHash: "another-pid-space" })
      .where(eq(heartbeatRuns.id, runId));
    await expect(releaseAbandonedNativeOwners(db)).resolves.toBe(0);
    expect(await coordinator(runId)).toMatchObject({ phase: "observed" });
    await db.update(heartbeatRuns).set({ processHostHash: currentProcessSpaceHash() }).where(eq(heartbeatRuns.id, runId));
    await expect(releaseAbandonedNativeOwners(db)).resolves.toBe(1);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.runId, runId),
      eq(activityLog.action, "legacy_host_unknown_dead_pid_proof")))).toEqual([]);
  });

  it("keeps the one-release fallback for a run process saved before its PID space, and records it", async () => {
    const { runId } = await nativeRun({ status: "failed", errorCode: "adapter_failed",
      coordinator: { leaseOwner: `default:resume:${randomUUID()}`, leaseExpiresAt: new Date(0) } });
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_001, processGroupId: null,
      processStartedAt: new Date(Date.now() - 60_000), processHostHash: null }).where(eq(heartbeatRuns.id, runId));
    await expect(releaseAbandonedNativeOwners(db)).resolves.toBe(1);
    const proofs = await db.select().from(activityLog).where(and(eq(activityLog.runId, runId),
      eq(activityLog.action, "legacy_host_unknown_dead_pid_proof")));
    expect(proofs.map(proof => proof.details)).toEqual([{ reason: "pid_dead", source: "native_failed_run_process" }]);
  });

  // `ps -o lstart` on macOS reports whole seconds, while a recorded start can
  // carry milliseconds. A sub-second gap must not be read as a recycled PID.
  it.each(["controller", "run process"])("keeps the owner when the live %s start time differs by under a second", async (holder) => {
    const { runId } = await nativeRun({ status: "failed", errorCode: "adapter_failed",
      coordinator: { leaseOwner: `default:resume:${randomUUID()}`, leaseExpiresAt: new Date(0) } });
    const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore", detached: true });
    await once(live, "spawn");
    try {
      const observed = new Date((await readProcessStartedAt(live.pid!))!);
      const recorded = new Date(observed.getTime() + 500);
      if (holder === "controller") {
        await db.update(nativeRunFinalizations).set({ controllerPid: live.pid!, controllerBootId: randomUUID(),
          controllerProcessStartedAt: recorded }).where(eq(nativeRunFinalizations.runId, runId));
      } else {
        await db.update(heartbeatRuns).set({ processPid: live.pid!, processGroupId: live.pid!, processStartedAt: recorded })
          .where(eq(heartbeatRuns.id, runId));
      }
      await expect(releaseAbandonedNativeOwners(db)).resolves.toBe(0);
      expect(await coordinator(runId)).toMatchObject({ phase: "observed", leaseOwner: expect.any(String) });
    } finally {
      const exited = once(live, "exit");
      live.kill("SIGKILL");
      await exited;
    }
  });

  it("rotates bounded passes past owners that a live controller still holds", async () => {
    const runs = await Promise.all([0, 1, 2].map(() => nativeRun({ status: "failed", errorCode: "adapter_failed",
      coordinator: { leaseOwner: `default:resume:${randomUUID()}`, leaseExpiresAt: new Date(0) } })));
    const [held, ...free] = [...runs].sort((left, right) => left.runId.localeCompare(right.runId));
    const controller = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
    await once(controller, "spawn");
    try {
      // The first page holds only the row a live controller still owns.
      await db.update(nativeRunFinalizations).set({ controllerPid: controller.pid!, controllerBootId: randomUUID() })
        .where(eq(nativeRunFinalizations.runId, held!.runId));
      // Each pass handles one bounded page; the cursor moves past the held row.
      const passes = [];
      for (let pass = 0; pass < 3; pass += 1) passes.push(await releaseAbandonedNativeOwners(db, new Date(), 1));
      expect(passes).toEqual([0, 1, 1]);
      // After a full rotation the held row is inspected again, not skipped forever.
      await expect(releaseAbandonedNativeOwners(db, new Date(), 1)).resolves.toBe(0);
      expect(await coordinator(held!.runId)).toMatchObject({ phase: "observed", leaseOwner: expect.any(String) });
      for (const { runId } of free) expect(await coordinator(runId)).toMatchObject({ phase: "terminal_failure", leaseOwner: null });
    } finally {
      const exited = once(controller, "exit");
      controller.kill("SIGKILL");
      await exited;
    }
  });

  it("leaves cancelled runs and pending Stops to their own stop-proof paths", async () => {
    const { runId: cancelledRunId } = await nativeRun({ status: "cancelled",
      coordinator: { leaseOwner: `default:resume:${randomUUID()}`, leaseExpiresAt: new Date(0) } });
    const { runId: stoppingRunId } = await nativeRun({ status: "interrupted",
      coordinator: { leaseOwner: `default:resume:${randomUUID()}`, leaseExpiresAt: new Date(0) } });
    await db.update(heartbeatRuns).set({ resultJson: { nativeCancellation: { dispatchState: "pending" } } })
      .where(eq(heartbeatRuns.id, stoppingRunId));
    await expect(releaseAbandonedNativeOwners(db)).resolves.toBe(0);
    expect(await nextAbandonedNativeOwnerReleaseAt(db)).toBeNull();
    for (const runId of [cancelledRunId, stoppingRunId]) {
      expect(await coordinator(runId)).toMatchObject({ phase: "observed", leaseOwner: expect.any(String) });
    }
  });
});
