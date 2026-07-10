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

  // Runs stuck in a non-terminal state (queued / scheduled_retry) whose process is
  // dead never become terminal on their own, so sweepStaleIssueLocks (which only
  // clears terminal-referenced locks) can never release their execution lock.
  // reapOrphanedRuns must finalize them ("finalize-then-sweep") so the sweep can
  // then clear the lock. These stuck runs are exactly the orphans observed in the
  // wild at status=scheduled_retry, process_pid=NULL.
  async function seedCompanyAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
    return { companyId, agentId };
  }

  const HOUR_MS = 60 * 60 * 1000;

  it("finalizes a stuck scheduled_retry run with a dead process past threshold, then the sweep clears the lock with an audit event", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const stuckRunId = randomUUID();
    const issueId = randomUUID();
    const dueLongAgo = new Date(Date.now() - HOUR_MS);

    await db.insert(heartbeatRuns).values({
      id: stuckRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      invocationSource: "automation",
      processPid: null, // dead: no tracked process — the orphan shape we reap
      scheduledRetryAt: dueLongAgo,
      updatedAt: dueLongAgo,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Permanently locked by stuck scheduled_retry run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: stuckRunId,
      executionAgentNameKey: "coder",
      executionLockedAt: dueLongAgo,
    });

    const heartbeat = heartbeatService(db);

    // The plain sweep cannot clear it yet — the run is still non-terminal.
    const preSweep = await heartbeat.sweepStaleIssueLocks();
    expect(preSweep.cleared).toBe(0);

    // Finalize step (R1): drive the dead stuck run terminal.
    const reap = await heartbeat.reapOrphanedRuns({
      reapStuckNonTerminalRuns: true,
      stuckRunStaleThresholdMs: 5 * 60 * 1000,
    });
    expect(reap.stuckFinalized).toBe(1);
    expect(reap.stuckRunIds).toContain(stuckRunId);

    const runAfter = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, stuckRunId))
      .then((rows) => rows[0]);
    expect(runAfter?.status).toBe("failed");

    // Sweep step: the now-terminal run's lock is cleared, with the audit event.
    const swept = await heartbeat.sweepStaleIssueLocks();
    expect(swept.cleared).toBe(1);
    expect(swept.issueIds).toEqual([issueId]);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ executionRunId: null, executionLockedAt: null });

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_lock_cleared"))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.stale_lock_cleared");
    expect(
      (audit?.details as { clearedExecutionRunId?: string } | null)?.clearedExecutionRunId,
    ).toBe(stuckRunId);
  });

  it("does NOT reap a live scheduled_retry whose scheduledRetryAt is still in the future", async () => {
    // A legitimately-scheduled retry can sit for up to the 2h+ bounded backoff — or
    // far longer behind a rate-limit Retry-After. Staleness is measured from the due
    // time, so a not-yet-due retry keeps its lock and is never reaped.
    const { companyId, agentId } = await seedCompanyAgent();
    const liveRunId = randomUUID();
    const issueId = randomUUID();
    const dueInFuture = new Date(Date.now() + 2 * HOUR_MS);

    await db.insert(heartbeatRuns).values({
      id: liveRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      invocationSource: "automation",
      processPid: null,
      scheduledRetryAt: dueInFuture,
      updatedAt: new Date(Date.now() - 3 * HOUR_MS), // created long ago, but not yet due
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live scheduled retry — lock must be preserved",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: liveRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const reap = await heartbeat.reapOrphanedRuns({
      reapStuckNonTerminalRuns: true,
      stuckRunStaleThresholdMs: 5 * 60 * 1000,
    });
    expect(reap.stuckFinalized).toBe(0);

    const runAfter = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, liveRunId))
      .then((rows) => rows[0]);
    expect(runAfter?.status).toBe("scheduled_retry");

    const swept = await heartbeat.sweepStaleIssueLocks();
    expect(swept.cleared).toBe(0);
  });

  it("does NOT reap a recently-queued run still within the staleness threshold", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const freshRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: freshRunId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      processPid: null,
      updatedAt: new Date(), // fresh — legitimately waiting for its agent slot
    });

    const heartbeat = heartbeatService(db);
    const reap = await heartbeat.reapOrphanedRuns({
      reapStuckNonTerminalRuns: true,
      stuckRunStaleThresholdMs: 30 * 60 * 1000,
    });
    expect(reap.stuckFinalized).toBe(0);

    const runAfter = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, freshRunId))
      .then((rows) => rows[0]);
    expect(runAfter?.status).toBe("queued");
  });

  it("leaves stuck non-terminal runs untouched when reapStuckNonTerminalRuns is not enabled (opt-in default off)", async () => {
    // Guards the existing contract: queued runs are legitimately waiting and the
    // default reapOrphanedRuns() call (used by many callers/tests) must never reap
    // them. The stuck-run reap is strictly opt-in.
    const { companyId, agentId } = await seedCompanyAgent();
    const stuckRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: stuckRunId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      processPid: null,
      updatedAt: new Date(Date.now() - 2 * HOUR_MS),
    });

    const heartbeat = heartbeatService(db);
    const reap = await heartbeat.reapOrphanedRuns();
    expect(reap.stuckFinalized ?? 0).toBe(0);

    const runAfter = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, stuckRunId))
      .then((rows) => rows[0]);
    expect(runAfter?.status).toBe("queued");
  });

  it("clears a mass-killed run's lock under suppressed hygiene mode without dispatching any new run (proves defect A)", async () => {
    // During a rate-limit outage (the window in which runs get mass-killed)
    // scheduling is suppressed, but lock hygiene must still run: reap the dead run
    // and sweep its lock, with zero model/agent spend (no retry enqueue, no
    // next-run dispatch).
    const { companyId, agentId } = await seedCompanyAgent();
    const killedRunId = randomUUID();
    const issueId = randomUUID();
    const longAgo = new Date(Date.now() - HOUR_MS);

    await db.insert(heartbeatRuns).values({
      id: killedRunId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      processPid: null, // process was mass-killed; nothing tracks it anymore
      updatedAt: longAgo,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mass-killed run left a permanent lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: killedRunId,
      executionLockedAt: longAgo,
    });

    const heartbeat = heartbeatService(db);
    const reap = await heartbeat.reapOrphanedRuns({
      reapStuckNonTerminalRuns: true,
      stuckRunStaleThresholdMs: 5 * 60 * 1000,
      suppressed: true,
    });
    expect(reap.stuckFinalized).toBe(1);

    const swept = await heartbeat.sweepStaleIssueLocks();
    expect(swept.cleared).toBe(1);

    const row = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBeNull();

    // Zero-spend proof: the only run in the table is the one we finalized — the
    // suppressed hygiene path did not enqueue a retry or dispatch a next run.
    const allRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toEqual({ id: killedRunId, status: "failed" });
  });
});
