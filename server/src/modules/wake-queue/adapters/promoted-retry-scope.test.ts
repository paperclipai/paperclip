import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createReleaseIssueExecution } from "../application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "./postgres.js";

const support = await getEmbeddedPostgresTestSupport();

// A board Retry receipt stores only `{ issueId, taskRetry }`, with no saved
// wake context. Its promoted run takes the issue's execution lock, so it must
// stay issue-scoped for workspace and trust-boundary preparation.
describe.skipIf(!support.supported)("promoted Retry receipt scope", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("wake-promoted-retry-scope-");
    db = createDb(database.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  it("keeps a promoted Retry receipt without saved wake context scoped to its issue", async () => {
    const [company] = await db.insert(companies).values({ name: "Retry scope fixture", issuePrefix: "RSF",
      defaultResponsibleUserId: "responsible-user" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Retry agent", adapterType: "process",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Retry scope fixture issue",
      status: "in_review", priority: "medium", assigneeAgentId: agent.id }).returning();
    const [finished] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      invocationSource: "on_demand", status: "succeeded", contextSnapshot: { issueId: issue.id } }).returning();
    const [otherIssue] = await db.insert(issues).values({ companyId: company.id, title: "Unrelated issue",
      status: "in_review", priority: "medium", assigneeAgentId: agent.id }).returning();
    const [foreignRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      invocationSource: "on_demand", status: "succeeded", contextSnapshot: { issueId: otherIssue.id } }).returning();
    await db.update(issues).set({ executionRunId: finished.id }).where(eq(issues.id, issue.id));
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId: company.id, agentId: agent.id, source: "on_demand", triggerDetail: "manual", reason: "task_retry",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "responsible-user",
      payload: { issueId: issue.id,
        taskRetry: { schema: "paperclip.task-retry.v1", generationId: crypto.randomUUID(), sourceRunId: finished.id,
          actorId: "responsible-user", strategy: "continue" } },
    }).returning();
    const release = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => "responsible-user",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      }),
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });

    const result = await release({ companyId: company.id, runId: finished.id, now: new Date(), suppressImmediateRecovery: true });

    expect(result.outcome.kind).toBe("promoted");
    const [promoted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wake.id));
    expect(promoted).toMatchObject({ scopeKind: "issue", issueId: issue.id, retryOfRunId: finished.id,
      contextSnapshot: { issueId: issue.id, taskId: issue.id, taskKey: issue.id, wakeReason: "task_retry" } });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].executionRunId).toBe(promoted.id);

    const [otherWake] = await db.insert(agentWakeupRequests).values({
      companyId: company.id, agentId: agent.id, source: "on_demand", triggerDetail: "manual", reason: "task_retry",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "responsible-user",
      payload: { issueId: issue.id,
        taskRetry: { schema: "paperclip.task-retry.v1", generationId: crypto.randomUUID(), sourceRunId: foreignRun.id,
          actorId: "responsible-user", strategy: "continue" } },
    }).returning();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, promoted.id));
    const second = await release({ companyId: company.id, runId: promoted.id, now: new Date(), suppressImmediateRecovery: true });
    expect(second.outcome.kind).toBe("promoted");
    const [secondPromoted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, otherWake.id));
    expect(secondPromoted.retryOfRunId).toBeNull();
  });
});
