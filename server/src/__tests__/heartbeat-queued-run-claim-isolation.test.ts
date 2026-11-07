import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  externalAgentHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Queued-run claim isolation test run.",
    provider: "test",
    model: "test-model",
  })),
);

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres queued-run claim isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat queued-run claim isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-queued-run-claim-isolation-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    // Executed runs write to many company-scoped tables; clear them all.
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Claim Isolation Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claim Isolation Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function insertQueuedRun(
    companyId: string,
    agentId: string,
    wake: Partial<typeof agentWakeupRequests.$inferInsert>,
    createdAt: Date,
  ) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      runId,
      ...wake,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      createdAt,
    });

    return { runId, wakeupRequestId };
  }

  // A queued-comment interrupt wake whose receipt cannot be verified. The run
  // identity check rejects it with a 403 every time the run is claimed.
  function insertUnverifiableInterruptRun(companyId: string, agentId: string, createdAt = new Date(Date.now() - 60_000)) {
    return insertQueuedRun(companyId, agentId, {
      reason: "issue_commented",
      idempotencyKey: `queued-comment-interrupt:${randomUUID()}`,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    }, createdAt);
  }

  // A system wake with no issue in a company without members. Its responsible
  // user cannot be resolved yet (422), but a user added later would fix that.
  function insertUnresolvableOwnerRun(companyId: string, agentId: string, createdAt = new Date(Date.now() - 60_000)) {
    return insertQueuedRun(companyId, agentId, {
      source: "automation",
      triggerDetail: "system",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_test",
    }, createdAt);
  }

  // A manual wake from a user. It resolves its identity from the receipt, so it
  // can always be claimed.
  function insertClaimableRun(companyId: string, agentId: string, createdAt = new Date()) {
    return insertQueuedRun(companyId, agentId, {
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      payload: { manualUserWake: true },
    }, createdAt);
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} = ${runId}`)
      .then((rows) => rows[0] ?? null);
  }

  it("cancels a queued run whose claim is rejected instead of failing recovery", async () => {
    const { companyId, agentId } = await insertAgent();
    const { runId, wakeupRequestId } = await insertUnverifiableInterruptRun(companyId, agentId);

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

    expect(await runStatus(runId)).toMatchObject({
      status: "cancelled",
      errorCode: "queued_run_claim_rejected",
      error: "Cancelled because the queued run cannot be claimed: Queued-message interrupt authority is unavailable",
    });
    const wakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.id} = ${wakeupRequestId}`)
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({ status: "cancelled" });

    // Recovery runs again on the next cycle and on every restart. The run must
    // stay settled instead of failing the claim loop again.
    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    expect(await runStatus(runId)).toMatchObject({ status: "cancelled" });
  });

  it("claims the agent's next queued run after a rejected one", async () => {
    const { companyId, agentId } = await insertAgent();
    const { runId: rejectedRunId } = await insertUnverifiableInterruptRun(companyId, agentId);
    const { runId: healthyRunId } = await insertClaimableRun(companyId, agentId);

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(rejectedRunId)).toMatchObject({
      status: "cancelled",
      errorCode: "queued_run_claim_rejected",
    });
    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    expect(await runStatus(healthyRunId)).toMatchObject({ status: "succeeded" });
  });

  it("dispatches saved reviewer rework before an older peer after a busy agent finishes", async () => {
    const { companyId, agentId } = await insertAgent();
    const busyEntered = Promise.withResolvers<void>();
    const releaseBusy = Promise.withResolvers<void>();
    const nextEntered = Promise.withResolvers<void>();
    const releaseNext = Promise.withResolvers<void>();
    const complete = mockAdapterExecute.getMockImplementation()!;
    mockAdapterExecute.mockImplementationOnce(async () => {
      busyEntered.resolve();
      await releaseBusy.promise;
      return complete();
    }).mockImplementationOnce(async () => {
      nextEntered.resolve();
      await releaseNext.promise;
      return complete();
    });

    try {
      const { runId: busyRunId } = await insertClaimableRun(companyId, agentId);
      await heartbeat.resumeQueuedRuns();
      await busyEntered.promise;
      expect(await runStatus(busyRunId)).toMatchObject({ status: "running" });

      const userId = `rework-owner-${randomUUID()}`;
      await db.insert(authUsers).values({ id: userId, name: "Rework owner",
        email: `qa-mail+${userId}@zolotenkov.site`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
        status: "active", membershipRole: "owner" });
      const olderIssueId = randomUUID();
      const reworkIssueId = randomUUID();
      await db.insert(issues).values([
        { id: olderIssueId, companyId, title: "Older peer", status: "in_progress", priority: "medium",
          assigneeAgentId: agentId, responsibleUserId: userId },
        { id: reworkIssueId, companyId, title: "Reviewer rework", status: "in_progress", priority: "medium",
          assigneeAgentId: agentId, responsibleUserId: userId,
          executionState: { status: "changes_requested", currentStageId: null, currentStageIndex: null,
            currentStageType: null, currentParticipant: null, returnAssignee: { type: "agent", agentId },
            completedStageIds: [], lastDecisionId: randomUUID(), lastDecisionOutcome: "changes_requested" } },
      ]);
      const runIds: string[] = [];
      for (const [index, issueId] of [olderIssueId, reworkIssueId].entries()) {
        const { runId } = await insertQueuedRun(companyId, agentId, {
          requestedByActorType: "user", requestedByActorId: userId,
          payload: { manualUserWake: true, issueId },
        }, new Date(Date.now() - 60_000 + index * 1_000));
        await db.update(heartbeatRuns).set({ contextSnapshot: { issueId } })
          .where(sql`${heartbeatRuns.id} = ${runId}`);
        runIds.push(runId);
      }
      const [olderRunId, reworkRunId] = runIds;
      await heartbeat.resumeQueuedRuns();
      expect(await runStatus(olderRunId)).toMatchObject({ status: "queued" });
      expect(await runStatus(reworkRunId)).toMatchObject({ status: "queued" });
      expect(mockAdapterExecute).toHaveBeenCalledOnce();

      releaseBusy.resolve();
      await nextEntered.promise;
      const executedRunIds = mockAdapterExecute.mock.calls.map(call => ((call as unknown[])[0] as { runId: string }).runId);
      expect(executedRunIds).toEqual([busyRunId, reworkRunId]);
      expect(await runStatus(olderRunId)).toMatchObject({ status: "queued" });
      expect(await runStatus(reworkRunId)).toMatchObject({ status: "running" });
      const [reworkIssue] = await db.select({ executionRunId: issues.executionRunId }).from(issues)
        .where(sql`${issues.id} = ${reworkIssueId}`);
      expect(reworkIssue.executionRunId).toBe(reworkRunId);
      releaseNext.resolve();
      await heartbeat.drainActiveRunExecutions();
      expect(await runStatus(busyRunId)).toMatchObject({ status: "succeeded" });
      expect(await runStatus(reworkRunId)).toMatchObject({ status: "succeeded" });
      expect(await runStatus(olderRunId)).toMatchObject({ status: "succeeded" });
    } finally {
      releaseBusy.resolve();
      releaseNext.resolve();
      await heartbeat.drainActiveRunExecutions();
    }
  });

  it("keeps a recoverable rejection queued without blocking the runs behind it", async () => {
    const { companyId, agentId } = await insertAgent();
    const { runId: deferredRunId } = await insertUnresolvableOwnerRun(companyId, agentId);
    const { runId: healthyRunId } = await insertClaimableRun(companyId, agentId);

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(deferredRunId)).toMatchObject({ status: "queued", errorCode: null });
    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    expect(await runStatus(healthyRunId)).toMatchObject({ status: "succeeded" });
  });

  it("keeps a routine run queued while another task holds the routine slot, then runs it once the slot is free", async () => {
    const { companyId, agentId } = await insertAgent();
    const origin = { originKind: "routine_execution", originId: randomUUID(), originFingerprint: "scheduled" };
    // The earlier task keeps its lock while its failed run waits for a scheduled resume.
    const holderIssueId = randomUUID();
    const holderRunId = randomUUID();
    await db.insert(issues).values({ id: holderIssueId, companyId, title: "Earlier routine task",
      status: "in_progress", assigneeAgentId: agentId, ...origin });
    await db.insert(heartbeatRuns).values({ id: holderRunId, companyId, agentId, status: "failed",
      finishedAt: new Date(), contextSnapshot: { issueId: holderIssueId } });
    await db.update(issues).set({ executionRunId: holderRunId }).where(sql`${issues.id} = ${holderIssueId}`);
    const userId = `routine-owner-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Routine owner", email: `${userId}@paperclip.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    const routineIssueId = randomUUID();
    await db.insert(issues).values({ id: routineIssueId, companyId, title: "Current routine task",
      status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, ...origin });
    const { runId: routineRunId } = await insertQueuedRun(companyId, agentId, {
      requestedByActorType: "user", requestedByActorId: userId,
      payload: { manualUserWake: true, issueId: routineIssueId },
    }, new Date(Date.now() - 60_000));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: routineIssueId } })
      .where(sql`${heartbeatRuns.id} = ${routineRunId}`);
    const { runId: healthyRunId } = await insertClaimableRun(companyId, agentId);

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(routineRunId)).toMatchObject({ status: "queued", errorCode: null });
    expect(await runStatus(healthyRunId)).toMatchObject({ status: "succeeded" });
    expect(mockAdapterExecute).toHaveBeenCalledOnce();

    await db.update(issues).set({ executionRunId: null }).where(sql`${issues.id} = ${holderIssueId}`);
    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(routineRunId)).toMatchObject({ status: "succeeded" });
    // Count executions per run: the finished task may queue its own follow-up run.
    const executedRunIds = mockAdapterExecute.mock.calls.map(call => ((call as unknown[])[0] as { runId?: string }).runId);
    expect(executedRunIds.filter(id => id === routineRunId)).toHaveLength(1);
    expect(executedRunIds.filter(id => id === healthyRunId)).toHaveLength(1);
  });

  it.each(["worker", "native-effects"])("retains a %s barrier across provider changes and resumes only after reconciliation", async barrier => {
    const { companyId, agentId } = await insertAgent();
    const { runId } = await insertClaimableRun(companyId, agentId);
    const [hold] = await db.insert(externalAgentHolds).values({ companyId, agentId, provider: "muse", assignmentId: randomUUID(), bindingId: randomUUID(),
      bindingGeneration: 1, runId: randomUUID(), workerUnknown: barrier === "worker", nativeEffectsUnknown: barrier === "native-effects" }).returning();
    // The agent now uses Codex; old external uncertainty still owns admission.
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(runId)).toMatchObject({ status: "queued" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    await db.update(externalAgentHolds).set({ workerUnknown: false, nativeEffectsUnknown: false, releasedAt: new Date() }).where(sql`${externalAgentHolds.id} = ${hold.id}`);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(runId)).toMatchObject({ status: "succeeded" });
    expect(mockAdapterExecute).toHaveBeenCalledOnce();
  });

  it("keeps processing other agents' queued runs after one agent's run is rejected", async () => {
    const first = await insertAgent();
    const second = await insertAgent();
    const { runId: rejectedRunId } = await insertUnverifiableInterruptRun(first.companyId, first.agentId);
    const { runId: healthyRunId } = await insertClaimableRun(second.companyId, second.agentId);

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(rejectedRunId)).toMatchObject({ status: "cancelled" });
    expect(await runStatus(healthyRunId)).toMatchObject({ status: "succeeded" });
  });
});
