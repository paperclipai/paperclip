import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat lock-release-on-reassignment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat lock release on cross-agent reassignment", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-lock-release-on-reassignment-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCrossAgentScenario(opts: { holderStatus: "queued" | "running" }) {
    const companyId = randomUUID();
    const coderAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const holderRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: coderAgentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: coderAgentId,
      source: "assignment",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId: coderAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.holderStatus,
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cross-agent reassignment race",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      executionRunId: holderRunId,
      executionAgentNameKey: "coder",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return {
      companyId,
      coderAgentId,
      reviewerAgentId,
      issueId,
      holderRunId,
      wakeupRequestId,
    };
  }

  it("defers a cross-agent wake while the holder is still running and leaves the holder alone", async () => {
    const { coderAgentId, reviewerAgentId, issueId, holderRunId, wakeupRequestId } =
      await seedCrossAgentScenario({ holderStatus: "running" });

    const heartbeat = heartbeatService(db);
    const followupRun = await heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(followupRun).toBeNull();

    const holder = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        agentId: heartbeatRuns.agentId,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder?.status).toBe("running");
    expect(holder?.errorCode).toBeNull();
    expect(holder?.finishedAt).toBeNull();
    expect(holder?.agentId).toBe(coderAgentId);

    const heldWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);

    expect(heldWakeup?.status).toBe("queued");

    const deferred = await db
      .select({ status: agentWakeupRequests.status, agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, reviewerAgentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    expect(deferred).not.toBeNull();

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.executionRunId).toBe(holderRunId);
  });

  it.each([false, true])("promotes the new assignee after stale queued cancellation (older former-agent wake: %s)", async olderWake => {
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } =
      await seedCrossAgentScenario({ holderStatus: "queued" });
    // Occupy the reviewer's slot so promotion is observable without executing
    // the process adapter. Only the old coder has a queued run to dispatch.
    await db.update(agents).set({
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, reviewerAgentId));
    await db.insert(heartbeatRuns).values({ companyId, agentId: reviewerAgentId,
      status: "running", startedAt: new Date(), contextSnapshot: {},
    });
    const obsolete = olderWake ? (await db.insert(agentWakeupRequests).values({ companyId,
      agentId: coderAgentId, source: "automation", reason: "issue_execution_deferred",
      status: "deferred_issue_execution", requestedAt: new Date(0), payload: { issueId,
        _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      }, requestedByActorType: "user", requestedByActorId: "responsible-user",
    }).returning())[0] : null;
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId,
      agentId: reviewerAgentId, source: "automation", reason: "issue_execution_deferred",
      status: "deferred_issue_execution", payload: { issueId,
        _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      },
      requestedByActorType: "user", requestedByActorId: "responsible-user",
    }).returning();

    await heartbeat.resumeQueuedRuns();

    const [holder] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, holderRunId));
    expect(holder).toMatchObject({ status: "cancelled", agentId: coderAgentId,
      errorCode: "issue_assignee_changed", resultJson: { executionRecovery: {
        kind: "bootstrap", providerWorkStarted: false,
      } },
    });
    const [promoted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(promoted.status).toBe("queued");
    expect(promoted.runId).toBeTruthy();
    const [next] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, promoted.runId!));
    expect(next).toMatchObject({ status: "queued", agentId: reviewerAgentId,
      contextSnapshot: { issueId },
    });
    if (obsolete) {
      const [oldWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, obsolete.id));
      const [oldRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, oldWake.runId!));
      expect(oldRun).toMatchObject({ status: "cancelled", errorCode: "issue_assignee_changed",
        startedAt: null, executionStage: null, processPid: null,
      });
    }
  }, 10_000);

  it("continues other task handoffs when one queued promotion fails", async () => {
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } =
      await seedCrossAgentScenario({ holderStatus: "queued" });
    await db.update(issues).set({ priority: "critical" }).where(eq(issues.id, issueId));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, reviewerAgentId));
    await db.insert(heartbeatRuns).values({ companyId, agentId: reviewerAgentId,
      status: "running", startedAt: new Date(), contextSnapshot: {},
    });
    const secondIssueId = randomUUID(), secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: secondRunId, companyId, agentId: coderAgentId,
      status: "queued", contextSnapshot: { issueId: secondIssueId, taskId: secondIssueId, wakeReason: "issue_assigned" },
    });
    await db.insert(issues).values({ id: secondIssueId, companyId, title: "Independent review handoff",
      status: "in_review", priority: "medium", assigneeAgentId: reviewerAgentId,
      executionRunId: secondRunId, executionAgentNameKey: "coder", executionLockedAt: new Date(),
    });
    const wakes = await db.insert(agentWakeupRequests).values([issueId, secondIssueId].map(id => ({
      companyId, agentId: reviewerAgentId, source: "automation", reason: "issue_execution_deferred",
      status: "deferred_issue_execution", payload: { issueId: id,
        _paperclipWakeContext: { issueId: id, taskId: id, wakeReason: "issue_assigned" },
      }, requestedByActorType: "user", requestedByActorId: "responsible-user",
    }))).returning();
    const failingWake = wakes.find(w => w.payload?.issueId === issueId)!;
    const otherWake = wakes.find(w => w.payload?.issueId === secondIssueId)!;
    // Fail the actual first promotion transaction, rather than mocking cleanup.
    await db.execute(sql.raw(`CREATE FUNCTION fail_test_wake_promotion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${failingWake.id}' AND NEW.status = 'queued' THEN
        RAISE EXCEPTION 'injected promotion failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql`CREATE TRIGGER fail_test_wake_promotion BEFORE UPDATE ON agent_wakeup_requests
      FOR EACH ROW EXECUTE FUNCTION fail_test_wake_promotion()`);
    try {
      await heartbeat.resumeQueuedRuns();
      for (const id of [holderRunId, secondRunId]) {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
        expect(run).toMatchObject({ status: "cancelled", startedAt: null });
      }
      const [failed] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, failingWake.id));
      const [promoted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, otherWake.id));
      expect(failed.status).toBe("deferred_issue_execution");
      expect(promoted.status).toBe("queued");
      expect(promoted.runId).toBeTruthy();
    } finally {
      await db.execute(sql`DROP TRIGGER fail_test_wake_promotion ON agent_wakeup_requests`);
      await db.execute(sql`DROP FUNCTION fail_test_wake_promotion()`);
    }
  }, 10_000);

  // Race-guard regression: the cancel UPDATE for the queued holder is pinned
  // to the exact non-running status that was read just above it. If a worker
  // races in and flips the holder from `queued` → `running` between that
  // SELECT and the cancel UPDATE, the status predicate in the WHERE clause
  // must guarantee zero rows are clobbered. We simulate the race by
  // pre-running the same UPDATE shape against a row that is already
  // `running` (the snapshot we would have read was `queued`); the row must
  // remain untouched, no wake-request cascade fires, and the lock stays
  // owned by the freshly-claimed running holder.
  it("guards the cancel UPDATE WHERE clause against a concurrent claim flip to running", async () => {
    const { coderAgentId, issueId, holderRunId, wakeupRequestId } = await seedCrossAgentScenario({
      holderStatus: "queued",
    });

    const snapshotStatus = "queued" as const;

    // Concurrent worker claims the queued run after the SELECT but before
    // the cancel UPDATE. In production this is a separate transaction
    // flipping the row from queued → running.
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, holderRunId));

    const cancelled = await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        error: "Execution lock released after issue reassigned to a different agent",
        errorCode: "lock_released_on_reassignment",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, holderRunId),
          eq(heartbeatRuns.status, snapshotStatus),
        ),
      )
      .returning({ id: heartbeatRuns.id });

    expect(cancelled).toHaveLength(0);

    const holder = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        agentId: heartbeatRuns.agentId,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder?.status).toBe("running");
    expect(holder?.errorCode).toBeNull();
    expect(holder?.finishedAt).toBeNull();
    expect(holder?.agentId).toBe(coderAgentId);

    const heldWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(heldWakeup?.status).toBe("queued");

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.executionRunId).toBe(holderRunId);
  });

  it("cancels a queued holder's run on reassignment and emits agent.task_run for it", async () => {
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } =
      await seedCrossAgentScenario({ holderStatus: "queued" });

    // Keep the reviewer's queue from auto-claiming/executing the new run
    // during this unit test, matching the pattern used for the sibling
    // reassignment scenario in heartbeat-retry-scheduling.test.ts: cap
    // concurrency at 1, then occupy that one slot with a busy run.
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, reviewerAgentId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { wakeReason: "test_busy_slot" },
      startedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const newAssigneeRun = await heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(reviewerAgentId);
    expect(newAssigneeRun?.status).toBe("queued");

    const holder = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder).toEqual({
      status: "cancelled",
      errorCode: "lock_released_on_reassignment",
    });

    // The cancel runs inside enqueueWakeup's transaction, and the run's own
    // required lifecycle work never awaits the telemetry emission, so wait
    // for it here instead of asserting it fired synchronously.
    await vi.waitFor(() => {
      expect(mockTrackAgentTaskRun).toHaveBeenCalledWith(
        mockTelemetryClient,
        expect.objectContaining({
          agentId: coderAgentId,
          state: "cancelled",
        }),
      );
    });
  });
});
