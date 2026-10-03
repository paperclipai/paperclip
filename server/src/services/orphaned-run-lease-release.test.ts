import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", async () => {
  const actual = await vi.importActual<typeof import("../sentry.js")>("../sentry.js");
  return { ...actual, captureRunFailure: mockCaptureRunFailure };
});

import { heartbeatService, type HeartbeatEnvironmentRuntime } from "./heartbeat.js";
import { reconcileAbandonedExecutionControl } from "./execution-control-reconciliation.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { validateExecutionReconciliation } from "./execution-recovery-resolution.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres orphaned-run lease-release regression tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * Regression coverage for the gap ALE-211 reports upstream: terminalizing an
 * orphaned run (either the process-death/issue-terminal backstop in
 * recovery/service.ts, or the execution-control-deadline backstop in
 * execution-control-reconciliation.ts) writes only the terminal run row.
 * `sweepOrphanedActiveLeases` / `sweepPendingCleanupLeases` (heartbeat.ts) are
 * the code path that actually claims and releases the run's
 * `environment_leases` row. Until that full loop completes,
 * `getConversationOwnershipBlocker` keeps refusing every later attempt on the
 * issue with `execution_owner_active`. These tests drive both terminalization
 * causes all the way through to a cleared blocker, and confirm a lease
 * belonging to a still-running sibling on the same environment is left alone.
 */
describeEmbeddedPostgres("orphaned run termination releases its environment lease", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphaned-run-lease-release-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    mockTelemetryClient.track.mockClear();
    mockCaptureRunFailure.mockClear();
  });

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(environments);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const oldEnough = () => new Date(Date.now() - 60 * 60 * 1000);

  async function seedCompanyAgentEnvironment() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Stuck worker",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(environments).values({
      id: environmentId,
      name: `Fake Sandbox ${environmentId}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "fake", image: "ubuntu:24.04" },
    });
    return { companyId, agentId, environmentId };
  }

  // A conversation adapter (claude_local/codex_local/...) is required for
  // `getConversationOwnershipBlocker` to consider the run at all; that is the
  // exact ownership check the still-open lease permanently defeats.
  async function seedRunWithLease(input: {
    companyId: string;
    agentId: string;
    environmentId: string;
    issueId: string;
    executionControlDeadlineAt?: Date;
    processPid?: number;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "running",
      startedAt: new Date(),
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      contextSnapshot: { issueId: input.issueId },
      processPid: input.processPid,
      executionControlDeadlineAt: input.executionControlDeadlineAt,
    });
    const leaseId = randomUUID();
    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId: input.companyId,
      environmentId: input.environmentId,
      heartbeatRunId: runId,
      status: "active",
      leasePolicy: "reuse_by_environment",
      provider: "fake",
      providerLeaseId: `sandbox://fake/${leaseId}`,
      acquiredAt: oldEnough(),
      lastUsedAt: oldEnough(),
      createdAt: oldEnough(),
      updatedAt: oldEnough(),
    });
    return { runId, leaseId };
  }

  function driverThatReleasesOnDestroy() {
    const destroyRunLease = vi.fn(async ({ lease }: { lease: { id: string } }) => {
      const now = new Date();
      const row = await db
        .update(environmentLeases)
        .set({ status: "expired", cleanupStatus: "success", releasedAt: now, updatedAt: now })
        .where(eq(environmentLeases.id, lease.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? { ...row, status: "expired" as const } : null;
    });
    return { destroyRunLease };
  }

  async function leaseRow(leaseId: string) {
    return db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
  }

  it("clears execution_owner_active once an orphaned_running_run termination's lease finishes releasing", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentEnvironment();
    const issueId = randomUUID();
    // A pid this large never maps to a live process, so the process-death
    // authority in terminalizeOrphanedRunningRun fires (errorCode
    // "orphaned_running_run" — the exact cause ALE-211 names).
    const { runId, leaseId } = await seedRunWithLease({
      companyId, agentId, environmentId, issueId, processPid: 2_000_000_000,
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Orphaned running run", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db, { environmentRuntime: driverThatReleasesOnDestroy() as unknown as HeartbeatEnvironmentRuntime });

    const lockSweep = await heartbeat.sweepStaleIssueLocks();
    expect(lockSweep.terminalizedRunIds).toEqual([runId]);
    const runAfterTerminalize = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(runAfterTerminalize).toMatchObject({ status: "interrupted", errorCode: "orphaned_running_run" });

    // The terminal write alone never touches environment_leases: the run is
    // terminal but the lease is still "active" with releasedAt null, so the
    // task remains permanently un-startable at this point.
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ cause: "execution_owner_active" });
    expect((await leaseRow(leaseId))?.status).toBe("active");

    const activeSweep = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 });
    expect(activeSweep.recovered).toBe(1);
    // pending_cleanup still blocks by design: the sandbox teardown has not
    // run yet, so a resumed task must not race a live provider resource.
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ cause: "execution_owner_active" });

    const cleanupSweep = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(cleanupSweep.destroyed).toBe(1);

    expect(await leaseRow(leaseId)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect((await leaseRow(leaseId))?.releasedAt).toBeInstanceOf(Date);
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
  });

  it("clears execution_owner_active once an execution_finalization_deadline_exceeded termination's lease finishes releasing", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentEnvironment();
    const issueId = randomUUID();
    const { runId, leaseId } = await seedRunWithLease({
      companyId, agentId, environmentId, issueId,
      executionControlDeadlineAt: new Date(Date.now() - 60_000),
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Abandoned execution control", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId,
    });

    const result = await reconcileAbandonedExecutionControl(db);
    expect(result.surfaced).toBe(1);
    const runAfterReconcile = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(runAfterReconcile).toMatchObject({ status: "failed", errorCode: "execution_finalization_deadline_exceeded" });

    // Same gap: this backstop only ever wrote heartbeat_runs, never
    // environment_leases, so the lease is still active immediately after
    // this call. This is exactly the "missing half" ALE-211 describes for
    // ALE-210: even a permitted agent's `POST recovery-actions/resolve` hits
    // `validateExecutionReconciliation`'s own environment_leases check and
    // is refused with a 409, independent of the recovery-action gate itself.
    const decision = {
      runId, providerStopped: true as const, actionOutcome: "not_performed" as const,
      outcomeEvidence: "Provider confirmed stopped; run made no external writes.",
    };
    const reconciliationInput = { db, companyId, issueId, agentId, sourceRunId: runId, decision };
    await expect(validateExecutionReconciliation(reconciliationInput)).rejects.toThrow(
      "has not finished releasing its authority",
    );

    const heartbeat = heartbeatService(db, { environmentRuntime: driverThatReleasesOnDestroy() as unknown as HeartbeatEnvironmentRuntime });
    await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 });
    await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

    expect(await leaseRow(leaseId)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    await expect(validateExecutionReconciliation(reconciliationInput)).resolves.toMatchObject({ id: runId });
  });

  it("never touches a still-running sibling run's lease on the same environment while releasing the dead one's", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentEnvironment();
    const deadIssueId = randomUUID();
    const { runId: deadRunId, leaseId: deadLeaseId } = await seedRunWithLease({
      companyId, agentId, environmentId, issueId: deadIssueId, processPid: 2_000_000_000,
    });
    await db.insert(issues).values({
      id: deadIssueId, companyId, title: "Dead run", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: deadRunId, executionRunId: deadRunId, executionLockedAt: new Date(),
    });

    // A second, genuinely live run holding its own lease on the *same*
    // environment. Nothing here terminalizes it; it must stay untouched.
    const liveIssueId = randomUUID();
    const { runId: liveRunId, leaseId: liveLeaseId } = await seedRunWithLease({
      companyId, agentId, environmentId, issueId: liveIssueId,
    });
    await db.insert(issues).values({
      id: liveIssueId, companyId, title: "Live run", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: liveRunId, executionRunId: liveRunId, executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db, { environmentRuntime: driverThatReleasesOnDestroy() as unknown as HeartbeatEnvironmentRuntime });
    await heartbeat.sweepStaleIssueLocks();
    await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 });
    await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

    expect(await leaseRow(deadLeaseId)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect(await leaseRow(liveLeaseId)).toMatchObject({ status: "active", releasedAt: null });
    expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, liveRunId))).toEqual([{ status: "running" }]);
    expect(await getExecutionBlocker(db, companyId, liveIssueId)).toBeNull();
  });

  it("does not re-attempt teardown on a lease the sweep already released", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentEnvironment();
    const issueId = randomUUID();
    const { runId, leaseId } = await seedRunWithLease({
      companyId, agentId, environmentId, issueId, processPid: 2_000_000_000,
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Orphaned running run", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date(),
    });

    const driver = driverThatReleasesOnDestroy();
    const heartbeat = heartbeatService(db, { environmentRuntime: driver as unknown as HeartbeatEnvironmentRuntime });
    await heartbeat.sweepStaleIssueLocks();
    await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 });
    await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(driver.destroyRunLease).toHaveBeenCalledTimes(1);

    // A second pass over an already-"expired" lease must not call the
    // provider destroy again.
    await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 });
    await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(driver.destroyRunLease).toHaveBeenCalledTimes(1);
    expect(await leaseRow(leaseId)).toMatchObject({ status: "expired", cleanupStatus: "success" });
  });
});
