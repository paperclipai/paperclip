import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, applyPendingMigrations, companies, createDb, environmentLeases, environments, heartbeatRunEvents,
  heartbeatRuns, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { recoveryService } from "../recovery/service.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

// A remote per-turn run fails while restoring its provider session. The
// coordinator schedules a same-run resume and keeps the task locks. The
// stale-lock sweeper then sees a failed run, and the remote resume must still
// run when its retry delay ends.
(support.supported ? describe : describe.skip)("scheduled remote native resume and the task execution lock", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (externalUrl) {
      await applyPendingMigrations(externalUrl);
      db = createDb(externalUrl);
    } else {
      temporary = await startEmbeddedPostgresTestDatabase("native-scheduled-resume-lock-");
      db = createDb(temporary.connectionString);
    }
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed(options: { lockedBy?: "self" | "none" } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sessionId = randomUUID();
    const failedAt = new Date(Date.now() - 5 * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Scheduled resume", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", adapterType: "paperclip_runner" });
    const lock = options.lockedBy === "none" ? null : runId;
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue after approval", status: "in_progress",
      assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", nativePhase: "retryable_failure", nativeSessionId: sessionId,
      processPid: 4_242, processStartedAt: failedAt, startedAt: failedAt, finishedAt: new Date(),
      errorCode: "native_session_interrupted", error: "native_session_recovery_failed: provider session was not restored",
      contextSnapshot: { issueId },
    });
    const [environment] = await db.insert(environments).values({ name: `Scheduled resume ${runId}`, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      environmentId: environment.id, provider: "daytona", providerLeaseId: randomUUID(), status: "active",
      leasePolicy: "ephemeral", metadata: { driver: "sandbox", remoteCwd: "/work" },
    }).returning();
    await db.update(heartbeatRuns).set({ runnerProfileJson: {
      nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
        baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: runId,
        leaseId: lease.id, providerLeaseId: lease.providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy",
      },
      sessionCheckpoint: {
        sessionId: "driver-session", providerSessionId: "provider-session",
        identity: { runId, companyId, issueId, agentId, sessionId },
      },
    } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: lock, checkoutRunId: lock, executionLockedAt: lock ? failedAt : null })
      .where(eq(issues.id, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "retryable_failure", attempt: 1,
      nextAttemptAt: new Date(Date.now() - 60_000), recoveryState: "resuming_session",
      failureCode: "native_session_interrupted",
      failureDetail: { recoveryMode: "exact_checkpoint_resume", checkpointExists: true,
        providerSessionEstablished: true, providerEventsExist: false },
    });
    return { companyId, agentId, issueId, runId };
  }

  const readIssue = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const readCoordinator = async (runId: string) =>
    (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0]!;
  const sweep = () => recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks();

  it("keeps the task locks while the failed run's coordinator owns a scheduled resume", async () => {
    const f = await seed();
    const result = await sweep();
    expect(result.issueIds).not.toContain(f.issueId);
    expect(await readIssue(f.issueId)).toMatchObject({ executionRunId: f.runId, checkoutRunId: f.runId });
  });

  it("keeps the task locks when a resume claim returns the run to running before the clear", async () => {
    const f = await seed();
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", nextAttemptAt: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const beforeStaleLockClear = vi.fn(async (issueId: string) => {
      if (issueId !== f.issueId) return;
      await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
      await db.update(heartbeatRuns).set({ status: "running", nativePhase: "observed" }).where(eq(heartbeatRuns.id, f.runId));
    });
    const result = await recoveryService(db, { enqueueWakeup: vi.fn(), beforeStaleLockClear }).sweepStaleIssueLocks();
    expect(beforeStaleLockClear).toHaveBeenCalledWith(f.issueId);
    expect(result.issueIds).not.toContain(f.issueId);
    expect(await readIssue(f.issueId)).toMatchObject({ executionRunId: f.runId, checkoutRunId: f.runId });
  });

  it("still clears a closed task's locks for a failed run with a scheduled resume", async () => {
    const f = await seed();
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    expect((await sweep()).issueIds).toContain(f.issueId);
    expect(await readIssue(f.issueId)).toMatchObject({ executionRunId: null, checkoutRunId: null });
  });

  it("claims a due remote resume whose cleared task lock is free and reclaims it", async () => {
    const f = await seed({ lockedBy: "none" });
    const dispositions = await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [f.runId] });
    expect(dispositions).toEqual([expect.objectContaining({ kind: "reattach_remote_runner", runId: f.runId })]);
    expect(await readIssue(f.issueId)).toMatchObject({ executionRunId: f.runId });
    expect(await readCoordinator(f.runId)).toMatchObject({ phase: "observed", attempt: 1, nextAttemptAt: null });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ status: "running", nativePhase: "observed" });
    const events = await db.select({ eventType: heartbeatRunEvents.eventType }).from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.eventType, "native.recovery.execution_reclaimed")));
    expect(events).toHaveLength(1);
  });

  it("does not reclaim a task that another run owns or has admitted", async () => {
    for (const competitor of ["lock", "queued"] as const) {
      const f = await seed({ lockedBy: "none" });
      const otherRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, status: competitor === "lock" ? "running" : "queued", contextSnapshot: { issueId: f.issueId } });
      if (competitor === "lock") await db.update(issues).set({ executionRunId: otherRunId }).where(eq(issues.id, f.issueId));
      expect(await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [f.runId] })).toEqual([
        { kind: "blocked", runId: f.runId, reason: "issue_execution_lock_changed" },
      ]);
      expect((await readIssue(f.issueId)).executionRunId).toBe(competitor === "lock" ? otherRunId : null);
      expect(await readCoordinator(f.runId)).toMatchObject({ phase: "retryable_failure", attempt: 1 });
    }
  });
});
