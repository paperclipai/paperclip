import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns, issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { heartbeatService } from "./heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

// A sandboxed reviewer approves, and the review handoff cancels its run with
// `issue_reassigned`. Its environment lease is released a moment later. The
// next participant's wake arrives while the lease is still held, so admission
// records it as a `skipped` execution wait. After the lease is released, the
// participant must still get a run.
(support.supported ? describe : describe.skip)("review handoff wake after a held environment lease", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("review-handoff-lease-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), reviewerId = randomUUID(), participantId = randomUUID();
    const issueId = randomUUID(), reviewerRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff", defaultResponsibleUserId: "board",
      issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: reviewerId, companyId, name: "Reviewer", role: "engineer", adapterType: "claude_local", status: "idle",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: participantId, companyId, name: "Next reviewer", role: "engineer", adapterType: "claude_local",
        status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
    ]);
    const stageId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Two-stage review", status: "in_review",
      assigneeAgentId: participantId, executionState: { status: "pending", currentStageId: stageId,
        currentStageType: "review", currentParticipant: { type: "agent", agentId: participantId, userId: null } } });
    // The approving run was stopped by the handoff; no process remains.
    await db.insert(heartbeatRuns).values({ id: reviewerRunId, companyId, agentId: reviewerId,
      runtimeMode: "legacy", status: "cancelled", errorCode: "issue_reassigned",
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      contextSnapshot: { issueId }, finishedAt: new Date() });
    // Its sandbox lease is still being cleaned up.
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: reviewerRunId,
      status: "active", provider: "kubernetes" }).returning();
    // Saturate the participant so an admitted wake stops at `queued`.
    await db.insert(heartbeatRuns).values({ companyId, agentId: participantId, status: "running" });
    return { companyId, participantId, issueId, reviewerRunId, stageId, leaseId: lease.id };
  }

  // The wake shape an approval produces for the next review participant.
  const stageWake = (f: Awaited<ReturnType<typeof seed>>) => {
    const executionStage = { stageId: f.stageId, stageType: "review", wakeRole: "reviewer",
      currentParticipant: { type: "agent", agentId: f.participantId, userId: null } };
    return { source: "assignment" as const, triggerDetail: "system" as const, reason: "execution_review_requested",
      payload: { issueId: f.issueId, mutation: "update", executionStage },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "execution_review_requested",
        source: "issue.execution_stage", executionStage } };
  };

  const queuedRuns = (companyId: string, agentId: string) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.status, "queued")));

  it("starts the next participant after the finishing run's lease is released", async () => {
    const f = await seed();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      cause: "execution_owner_active", runId: f.reviewerRunId,
    });
    await heartbeatService(db).wakeup(f.participantId, stageWake(f));
    const [wait] = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.participantId)));
    expect(wait).toMatchObject({ status: "skipped", reason: "execution_reconciliation_required" });
    expect(await queuedRuns(f.companyId, f.participantId)).toHaveLength(0);

    // Lease cleanup finishes; the gate is gone.
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
      .where(eq(environmentLeases.id, f.leaseId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();

    // Let the cleanup delay elapse, then run the ordinary periodic sweep twice
    // concurrently: exactly one run starts, and a later pass adds none.
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(0) }).where(eq(agentWakeupRequests.id, wait.id));
    await Promise.all([heartbeatService(db).resumeQueuedRuns(), heartbeatService(db).resumeQueuedRuns()]);
    const runs = await queuedRuns(f.companyId, f.participantId);
    expect(runs).toHaveLength(1);
    expect(runs[0].contextSnapshot).toMatchObject({ issueId: f.issueId, wakeReason: "execution_review_requested",
      executionStage: { stageId: f.stageId } });
    await heartbeatService(db).resumeQueuedRuns();
    expect(await queuedRuns(f.companyId, f.participantId)).toHaveLength(1);

    // An interruption after admission but before retirement leaves the receipt
    // unretired. The next pass finds the keyed replacement and only retires it.
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(0),
      payload: sql`${agentWakeupRequests.payload} #- '{executionWait,readmittedAt}'` })
      .where(eq(agentWakeupRequests.id, wait.id));
    await heartbeatService(db).resumeQueuedRuns();
    expect(await queuedRuns(f.companyId, f.participantId)).toHaveLength(1);
    const [retired] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wait.id));
    expect((retired.payload as { executionWait?: { readmittedAt?: string } }).executionWait?.readmittedAt)
      .toBeTruthy();
  });

  it("leaves a handoff alone while the gate is up or the stage has moved on", async () => {
    const f = await seed();
    await heartbeatService(db).wakeup(f.participantId, stageWake(f));
    const [wait] = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.participantId)));
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(0) }).where(eq(agentWakeupRequests.id, wait.id));
    // Gate still up: nothing starts.
    await heartbeatService(db).resumeQueuedRuns();
    expect(await queuedRuns(f.companyId, f.participantId)).toHaveLength(0);
    // Gate gone, but the task no longer waits on this stage: nothing starts.
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
      .where(eq(environmentLeases.id, f.leaseId));
    await db.update(issues).set({ executionState: { status: "completed", currentStageId: null } })
      .where(eq(issues.id, f.issueId));
    await heartbeatService(db).resumeQueuedRuns();
    expect(await queuedRuns(f.companyId, f.participantId)).toHaveLength(0);
  });
});
