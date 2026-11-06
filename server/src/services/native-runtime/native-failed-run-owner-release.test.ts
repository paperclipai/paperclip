import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  nativeRunFinalizations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { agentExecutionsHaveStopped } from "../agent-execution-stop.js";
import { executionControlSchedule } from "../execution-control-work.js";
import { reconcileAbandonedExecutionControl } from "../execution-control-reconciliation.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";
import {
  nextAbandonedNativeOwnerReleaseAt,
  releaseAbandonedNativeOwners,
  settleUnstartedNativeSessionResume,
} from "./native-failed-run-owner-release.js";

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
  }) {
    const issueId = randomUUID();
    const runId = randomUUID();
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
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 1,
      ...input.coordinator } as typeof nativeRunFinalizations.$inferInsert);
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
