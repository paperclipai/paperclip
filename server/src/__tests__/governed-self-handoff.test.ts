import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { createWakeQueue } from "../modules/wake-queue/index.js";
import { createHeartbeatQueue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } from "../services/heartbeat/queue.js";
import { mergeCoalescedContextSnapshot } from "../services/heartbeat/run-preparation.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("governed legacy handoff persistence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("governed-self-handoff-");
    db = createDb(database.connectionString);
  }, 90000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("retains execution until the outgoing run settles, then admits one reviewer", async () => {
    const [company] = await db.insert(companies).values({ name: "Review handoff", issuePrefix: "GH", defaultResponsibleUserId: "board" }).returning();
    const [worker, reviewer] = await db.insert(agents).values(["Worker", "Reviewer"].map(name => ({ companyId: company.id, name,
      status: "idle" as const, role: "engineer" as const, adapterType: "process", runtimeConfig: { heartbeat: { wakeOnDemand: true } } }))).returning();
    const stageId = randomUUID();
    const policy = normalizeIssueExecutionPolicy({ stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: reviewer.id }] }] });
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Review implementation", status: "in_progress",
      assigneeAgentId: worker.id, executionPolicy: policy ? { ...policy } : null }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: worker.id, status: "running",
      runtimeMode: "legacy", startedAt: new Date(), contextSnapshot: { issueId: issue.id } }).returning();
    await db.update(issues).set({ executionRunId: source.id, checkoutRunId: source.id, executionAgentNameKey: worker.name,
      executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    const state = { status: "pending" as const, currentStageId: stageId, currentStageIndex: 0, currentStageType: "review" as const,
      currentParticipant: { type: "agent" as const, agentId: reviewer.id }, returnAssignee: { type: "agent" as const, agentId: worker.id },
      completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, reviewRequest: null };
    const service = issueService(db);
    const mutationId = randomUUID();
    await expect(service.update(issue.id, { status: "in_review", assigneeAgentId: reviewer.id, executionState: state,
      preserveActorExecutionOnHandoff: true, handoffMutationId: mutationId })).rejects.toThrow("running agent");
    expect(await service.getById(issue.id)).toMatchObject({ status: "in_progress", assigneeAgentId: worker.id, executionRunId: source.id });
    const [other] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: worker.id, status: "running", runtimeMode: "legacy" }).returning();
    await db.update(issues).set({ executionRunId: other.id }).where(eq(issues.id, issue.id));
    await expect(service.update(issue.id, { status: "in_review", assigneeAgentId: reviewer.id, executionState: state,
      actorAgentId: worker.id, actorRunId: source.id, preserveActorExecutionOnHandoff: true, handoffMutationId: mutationId })).rejects.toThrow("owner changed");
    expect(await service.getById(issue.id)).toMatchObject({ status: "in_progress", assigneeAgentId: worker.id, executionRunId: other.id });
    await db.update(issues).set({ executionRunId: source.id }).where(eq(issues.id, issue.id));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, other.id));
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id)))[0].contextSnapshot)
      .not.toHaveProperty("governedSelfHandoff");
    const handoffPatch = { status: "in_review" as const, assigneeAgentId: reviewer.id, executionState: state,
      actorAgentId: worker.id, actorRunId: source.id, preserveActorExecutionOnHandoff: true, handoffMutationId: mutationId };
    await expect(db.transaction(async tx => {
      await service.update(issue.id, handoffPatch, tx);
      await service.addComment(issue.id, "Unbound comment", { agentId: worker.id, runId: source.id }, undefined, tx);
    })).rejects.toThrow("handed off");
    expect(await service.getById(issue.id)).toMatchObject({ status: "in_progress", assigneeAgentId: worker.id, executionRunId: source.id });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id)))[0].contextSnapshot)
      .not.toHaveProperty("governedSelfHandoff");
    await db.transaction(async tx => {
      await service.update(issue.id, handoffPatch, tx);
      const comment = await service.addComment(issue.id, "Ready for review", { agentId: worker.id, runId: source.id },
        { governedHandoffMutationId: mutationId }, tx);
      expect(comment.body).toBe("Ready for review");
    });
    expect(await service.getById(issue.id)).toMatchObject({ assigneeAgentId: reviewer.id, executionRunId: source.id, checkoutRunId: null });

    await expect(service.addComment(issue.id, "Late comment", { agentId: worker.id, runId: source.id })).rejects.toThrow("handed off");
    await expect(service.addComment(issue.id, "Forged comment", { agentId: worker.id, runId: source.id },
      { governedHandoffMutationId: "wrong-request" })).rejects.toThrow("handed off");
    await expect(service.update(issue.id, { title: "Late mutation", actorAgentId: worker.id, actorRunId: source.id })).rejects.toThrow("handed off");
    const [recorded] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
    expect(recorded.contextSnapshot).toMatchObject({ governedSelfHandoff: { runId: source.id, issueId: issue.id } });
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockResolvedValue(reviewer);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false, enableNativeRunner: false } as never);
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    const admission = createWakeQueue(db, {
      resolveResponsibleUserId: async () => "board",
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: { filterZombieCoalesceTarget: deps.filterZombieCoalesceTarget, mergeCoalescedContextSnapshot,
        shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    deps.wakeQueue.createAdmissionTransactionScope.mockImplementation(admission.createAdmissionTransactionScope);
    deps.wakeQueue.admitWakeBehindIssueExecution.mockImplementation(admission.admitWakeBehindIssueExecution);
    const queue = createHeartbeatQueue(db, deps);
    await queue.enqueueWakeup(reviewer.id, { source: "assignment", triggerDetail: "system", reason: "execution_review_requested",
      payload: { issueId: issue.id, interruptedRunId: source.id, executionStage: { wakeRole: "reviewer", stageId, stageType: "review", currentParticipant: state.currentParticipant } },
      contextSnapshot: { issueId: issue.id, interruptedRunId: source.id }, requestedByActorType: "agent", requestedByActorId: worker.id });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, reviewer.id))).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, source.id));
    await admission.releaseIssueExecution({ companyId: company.id, runId: source.id, now: new Date(), suppressImmediateRecovery: true });
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, company.id), eq(heartbeatRuns.agentId, reviewer.id)));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ status: "queued", contextSnapshot: { issueId: issue.id } });
    await admission.releaseIssueExecution({ companyId: company.id, runId: source.id, now: new Date(), suppressImmediateRecovery: true });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, reviewer.id))).toHaveLength(1);
    expect(deps.executeRun).not.toHaveBeenCalled();
  });
});
