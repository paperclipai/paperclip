import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-lock sweeper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery sweepStaleIssueLocks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-lock-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(nativeRunFinalizations);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const runningRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date(),
      },
      {
        id: runningRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return { companyId, agentId, failedRunId, runningRunId };
  }

  it("clears lock columns when checkoutRunId points at a terminal heartbeat run", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale lock — terminal checkoutRunId",
      // Status off in_progress + checkoutRunId still set → exactly the recurrence shape.
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: null, executionRunId: null, executionLockedAt: null });

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_lock_cleared"))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.stale_lock_cleared");
    expect((audit?.details as { clearedCheckoutRunId?: string } | null)?.clearedCheckoutRunId).toBe(
      failedRunId,
    );
  });

  it("does not clear locks while the referenced run is still running", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live lock — must be preserved",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: runningRunId, executionRunId: runningRunId });
  });

  it("does not clear when checkoutRunId is terminal but executionRunId is still running", async () => {
    const { companyId, agentId, failedRunId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mixed lock — preserve",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: failedRunId, executionRunId: runningRunId });
  });

  it("is idempotent — second pass finds nothing to clear", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Idempotency",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.sweepStaleIssueLocks();
    const second = await heartbeat.sweepStaleIssueLocks();
    expect(first.cleared).toBe(1);
    expect(second.cleared).toBe(0);
  });

  it("terminalizes an orphaned running run whose process is gone, then clears the lock", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    // The run recorded a pid, but the process and its sandbox are gone. A pid
    // this large never maps to a live process, so isPidAlive returns false.
    // The issue is not terminal, so only the process-death authority applies.
    await db
      .update(heartbeatRuns)
      .set({ processPid: 2_000_000_000 })
      .where(eq(heartbeatRuns.id, runningRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Orphaned running run — terminalize then clear",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.terminalizedRunIds).toEqual([runningRunId]);
    expect(result.cleared).toBe(1);

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]);
    // Process died, outcome unknown, so the backstop uses "interrupted".
    expect(run?.status).toBe("interrupted");
    expect(run?.errorCode).toBe("orphaned_running_run");

    const lock = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(lock).toEqual({ checkoutRunId: null, executionRunId: null });

    const event = await db
      .select({ message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runningRunId))
      .then((rows) => rows[0]);
    expect(event?.message).toContain("process and sandbox gone");
  });

  it("preserves a process-less native run while same-run resumption owns its retry", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Native same-run retry remains live",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });
    await db
      .update(heartbeatRuns)
      .set({
        runtimeMode: "native",
        nativeIssueId: issueId,
        nativePhase: "retryable_failure",
        processPid: 2_000_000_000,
      })
      .where(eq(heartbeatRuns.id, runningRunId));
    await db.insert(nativeRunFinalizations).values({
      runId: runningRunId,
      companyId,
      issueId,
      phase: "retryable_failure",
      attempt: 1,
      nextAttemptAt: new Date(Date.now() + 30_000),
    });

    const result = await heartbeatService(db).sweepStaleIssueLocks();

    expect(result).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
    await expect(db.select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId)))
      .resolves.toEqual([{ status: "running" }]);
    await expect(db.select({
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
    }).from(issues).where(eq(issues.id, issueId)))
      .resolves.toEqual([{ checkoutRunId: runningRunId, executionRunId: runningRunId }]);
  });

  it("terminalizes a running run whose issue is terminal, even while the process stays alive (reuse-lease path)", async () => {
    // Reuse Lease ON stops the sandbox but keeps the server process alive, so
    // the in-memory handle and the recorded pid can both persist. The
    // process-death authority misses this case. The issue-terminal authority
    // catches it: the issue reached "done" while the run row stayed "running".
    const { companyId, agentId, runningRunId } = await seed();
    // process.pid is the live test process, so isPidAlive returns true.
    await db
      .update(heartbeatRuns)
      .set({ processPid: process.pid })
      .where(eq(heartbeatRuns.id, runningRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reused sandbox stopped — issue done, run still running",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.terminalizedRunIds).toEqual([runningRunId]);
    expect(result.cleared).toBe(1);

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]);
    // The issue is "done", so the terminal run status is "succeeded". A
    // succeeded run carries no error code.
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();

    const lock = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(lock).toEqual({ checkoutRunId: null, executionRunId: null });

    const event = await db
      .select({ message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runningRunId))
      .then((rows) => rows[0]);
    expect(event?.message).toContain("issue reached a terminal status");
  });

  it("terminalizes a running run to cancelled when its issue is cancelled (reuse-lease path)", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    await db
      .update(heartbeatRuns)
      .set({ processPid: process.pid })
      .where(eq(heartbeatRuns.id, runningRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reused sandbox stopped — issue cancelled, run still running",
      status: "cancelled",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.terminalizedRunIds).toEqual([runningRunId]);

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("cancelled");
  });

  it("does not terminalize a running run whose process is alive and whose issue is not terminal", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    // process.pid is the live test process, so isPidAlive returns true.
    await db
      .update(heartbeatRuns)
      .set({ processPid: process.pid })
      .where(eq(heartbeatRuns.id, runningRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live run — preserve",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.terminalizedRunIds).toEqual([]);
    expect(result.cleared).toBe(0);

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("running");
  });

  it("does not terminalize a live run that a terminal issue and an active issue both reference", async () => {
    // A stale lock on a terminal issue and the real lock on an active issue can
    // point at the same running run. The terminal reference alone must not
    // terminalize the run, because the run is still live for the active issue.
    const { companyId, agentId, runningRunId } = await seed();
    // process.pid is the live test process, so isPidAlive returns true.
    await db
      .update(heartbeatRuns)
      .set({ processPid: process.pid })
      .where(eq(heartbeatRuns.id, runningRunId));

    const terminalIssueId = randomUUID();
    const activeIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: terminalIssueId,
        companyId,
        title: "Terminal issue holds a stale lock on the shared run",
        status: "done",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: runningRunId,
        executionRunId: null,
      },
      {
        id: activeIssueId,
        companyId,
        title: "Active issue owns the live shared run",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: runningRunId,
        executionRunId: runningRunId,
        executionLockedAt: new Date(),
      },
    ]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    // The run stays live, so the sweep terminalizes nothing and clears nothing.
    expect(result.terminalizedRunIds).toEqual([]);
    expect(result.cleared).toBe(0);

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("running");

    const activeLock = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, activeIssueId))
      .then((rows) => rows[0]);
    expect(activeLock).toEqual({ checkoutRunId: runningRunId, executionRunId: runningRunId });
  });

  it("does not terminalize a shared live run when its context snapshot names the terminal issue", async () => {
    // The run context snapshot names the terminal issue. The context-snapshot
    // fallback in terminalizeOrphanedRunningRun could read that terminal status
    // and terminalize the run. An active issue still owns the run, so the sweep
    // must suppress the fallback and keep the run live.
    const { companyId, agentId, runningRunId } = await seed();
    // process.pid is the live test process, so isPidAlive returns true.
    await db
      .update(heartbeatRuns)
      .set({ processPid: process.pid })
      .where(eq(heartbeatRuns.id, runningRunId));

    const terminalIssueId = randomUUID();
    const activeIssueId = randomUUID();
    // The run context snapshot names the terminal issue. This is the path the
    // shared-run guard must still block.
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: terminalIssueId } })
      .where(eq(heartbeatRuns.id, runningRunId));
    await db.insert(issues).values([
      {
        id: terminalIssueId,
        companyId,
        title: "Terminal issue named in the run context snapshot",
        status: "done",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: runningRunId,
        executionRunId: null,
      },
      {
        id: activeIssueId,
        companyId,
        title: "Active issue owns the live shared run",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: runningRunId,
        executionRunId: runningRunId,
        executionLockedAt: new Date(),
      },
    ]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    // The run stays live, so the sweep terminalizes nothing and clears nothing.
    expect(result.terminalizedRunIds).toEqual([]);
    expect(result.cleared).toBe(0);

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("running");

    const activeLock = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, activeIssueId))
      .then((rows) => rows[0]);
    expect(activeLock).toEqual({ checkoutRunId: runningRunId, executionRunId: runningRunId });
  });

  it("still clears the lock when the audit write fails after terminalization", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    // The run recorded a pid that never maps to a live process, so the sweep
    // decides to terminalize it. The issue is not terminal, so the
    // process-death authority drives the terminalization here.
    await db
      .update(heartbeatRuns)
      .set({ processPid: 2_000_000_000 })
      .where(eq(heartbeatRuns.id, runningRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Audit write fails — still clear the lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    // Make only the audit-event insert fail. The run update commits the
    // terminal status first, so the audit write is best-effort. The sweep must
    // catch the failure and still clear the lock.
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockRejectedValueOnce(new Error("simulated audit write failure"));

    try {
      const heartbeat = heartbeatService(db);
      const result = await heartbeat.sweepStaleIssueLocks();

      expect(result.terminalizedRunIds).toEqual([runningRunId]);
      expect(result.cleared).toBe(1);
    } finally {
      transactionSpy.mockRestore();
    }

    // The run reached its terminal status even though the audit write failed.
    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("interrupted");

    // The sweep cleared the lock in the same pass.
    const lock = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(lock).toEqual({ checkoutRunId: null, executionRunId: null });

    // The audit write failed, so no run event exists for this run.
    const events = await db
      .select({ id: heartbeatRunEvents.id })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runningRunId));
    expect(events).toEqual([]);
  });
});
