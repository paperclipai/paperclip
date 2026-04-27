import { randomUUID } from "node:crypto";
import { eq, inArray, or } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  documents,
  documentRevisions,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Bug 8: succeeded-skip on the in_progress branch (F-HB-4) and idempotency
// on (issueId, retryOfRunId) for stranded recovery (F-HB-5). The reconciler
// must not loop a succeeded Ada whose issue is still flipping to done, and
// two parallel sweeps must agree on a single wakeup.

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "noop",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Bug 8 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat reconciler — Bug 8 (succeeded-skip + parallel-sweep idempotency)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-bug8-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function cancelActiveRunsForCleanup(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
        .from(heartbeatRuns)
        .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));
      if (activeRuns.length === 0) return;
      const now = new Date();
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: now, updatedAt: now, errorCode: "test_cleanup", error: "cleanup", processPid: null, processGroupId: null })
        .where(inArray(heartbeatRuns.id, activeRuns.map((r) => r.id)));
      const wakeupIds = activeRuns.map((r) => r.wakeupRequestId).filter((v): v is string => typeof v === "string" && v.length > 0);
      if (wakeupIds.length > 0) {
        await db
          .update(agentWakeupRequests)
          .set({ status: "cancelled", finishedAt: now, error: "cleanup" })
          .where(inArray(agentWakeupRequests.id, wakeupIds));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    // Drain any in-flight wakeup-spawned executions before tearing tables
    // down — they create issue_comments / document_revisions / etc. that
    // would otherwise foreign-key-violate the company DELETE.
    await cancelActiveRunsForCleanup();
    // Loop to absorb any post-cancel writes that landed during teardown.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(activityLog);
        await db.delete(issueComments);
        await db.delete(issueDocuments);
        await db.delete(documentRevisions);
        await db.delete(documents);
        await db.delete(issueRelations);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(issues);
        await db.delete(agentRuntimeState);
        await db.delete(companySkills);
        await db.delete(agents);
        await db.delete(companies);
        return;
      } catch (err) {
        if (attempt === 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedSucceededInProgressFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-04-25T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Charlie Oscar",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ada",
      role: "engineer",
      status: "idle",
      adapterType: "managed_agents",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // The "succeeded" run that the reconciler must NOT continuation-recover.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      startedAt: now,
      finishedAt: new Date("2026-04-25T00:05:00.000Z"),
      updatedAt: new Date("2026-04-25T00:05:00.000Z"),
      errorCode: null,
      error: null,
    });

    // Issue is still in_progress because the success-side flip hasn't run
    // yet (or in the pathological case described by Bug 8, never will).
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Build budget calculator",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    return { companyId, agentId, runId, issueId };
  }

  async function seedFailedInProgressFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-04-25T01:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Charlie Oscar",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ada",
      role: "engineer",
      status: "idle",
      adapterType: "managed_agents",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      startedAt: now,
      finishedAt: new Date("2026-04-25T01:05:00.000Z"),
      updatedAt: new Date("2026-04-25T01:05:00.000Z"),
      errorCode: "process_lost",
      error: "run failed before issue advanced",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded continuation work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    return { companyId, agentId, runId, issueId };
  }

  // F-HB-4: the regression Mal observed — Ada looped after delegate_task
  // succeeded, because the in_progress branch had no succeeded-skip guard.
  it("does NOT enqueue a continuation_recovery wakeup for an in_progress issue whose latest run already succeeded (F-HB-4)", async () => {
    const { agentId, issueId } = await seedSucceededInProgressFixture();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).not.toContain(issueId);

    const newWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(newWakeups).toHaveLength(0);

    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1); // only the original succeeded run; no retry
  });

  // F-HB-5: two parallel reconciler sweeps for the same stranded issue
  // must agree on a single recovery wakeup. The transactional
  // `select for update` claim in enqueueStrandedIssueRecovery serializes
  // the duplicate-detection check.
  it("enqueues exactly ONE wakeup when two reconciler sweeps run in parallel against the same stranded (issue, agent) (F-HB-5)", async () => {
    const { agentId, issueId } = await seedFailedInProgressFixture();
    const heartbeat = heartbeatService(db);

    const [a, b] = await Promise.all([
      heartbeat.reconcileStrandedAssignedIssues(),
      heartbeat.reconcileStrandedAssignedIssues(),
    ]);

    // Exactly one of the two sweeps requeued; the other saw the wakeup the
    // first one wrote and skipped.
    const totalRequeued = a.continuationRequeued + b.continuationRequeued;
    expect(totalRequeued).toBe(1);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    // One recovery wakeup. (Both `claimed` and `queued` count as enqueued —
    // the dispatcher may have already claimed it by the time we read.)
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.payload).toMatchObject({ issueId });
    expect((wakeups[0]?.payload as Record<string, unknown>)?.retryOfRunId).toBeTruthy();
  });

  // Negative case: a legitimately stranded issue (last run failed, not
  // succeeded) STILL gets recovered. We must not have over-rotated F-HB-4
  // into blocking the entire continuation pathway.
  it("still enqueues continuation_recovery for a legitimately stranded in_progress issue with a failed last run (F-HB-4 negative)", async () => {
    const { agentId, issueId } = await seedFailedInProgressFixture();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toContain(issueId);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.length).toBeGreaterThanOrEqual(1);
    expect(wakeups[0]?.payload).toMatchObject({ issueId });
  });
});
