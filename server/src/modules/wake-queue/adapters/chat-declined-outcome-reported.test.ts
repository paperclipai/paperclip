import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createReleaseIssueExecution } from "../application/use-cases.js";
import { ALREADY_REPORTED_WAKE_REASON, createPostgresWakeQueueAdapter } from "./postgres.js";
import { recordDeclinedInteractionRead } from "../../../services/chat-interaction-outcome-report.js";

const support = await getEmbeddedPostgresTestSupport();

// Chat eval questions-and-approvals.decline-tool: the person said "Do not use that app" and
// declined the tool review a second later. The turn woken by the message read the action
// declined and said so. The decline continuation, saved behind that turn, then posted the
// same declined outcome again.
describe.skipIf(!support.supported)("release of a decline continuation an earlier reply already reported", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("wake-chat-declined-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Declined outcome fixture", issuePrefix: "CDO" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Lead", adapterType: "process" }).returning();
    companyId = company.id;
    agentId = agent.id;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function seed(input: { outcomeCount?: number; read: boolean; toolAction?: boolean; status?: string; historical?: number }) {
    const [issue] = await db.insert(issues).values({ companyId, title: "Chat with CEO", status: "in_progress", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: `person-${randomUUID()}`, conversationState: "waiting" }).returning();
    // Older declines come first in the agent's interaction list.
    const history = input.historical ? await db.insert(issueThreadInteractions).values(Array.from({ length: input.historical }, (_, index) => ({
      companyId, issueId: issue.id, kind: "request_confirmation", status: "rejected", resolvedByUserId: "person",
      createdAt: new Date(Date.now() - 600_000 + index), resolvedAt: new Date(Date.now() - 500_000 + index),
      payload: { version: 1, prompt: "Approve an earlier read?", toolAction: { connectionId: randomUUID() } } as never,
    }))).returning() : [];
    const resolvedAt = new Date(Date.now() - 30_000);
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id, kind: "request_confirmation",
      status: input.status ?? "rejected", resolvedAt, resolvedByUserId: "person",
      payload: { version: 1, prompt: "Approve Read launch notes?", ...(input.toolAction === false ? {} : { toolAction: { connectionId: randomUUID() } }) } as never,
    }).returning();
    // The turn woken by the person's message was running when the card was declined.
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", invocationSource: "automation",
      startedAt: new Date(Date.now() - 31_000), contextSnapshot: { issueId: issue.id } }).returning();
    if (input.read) {
      await recordDeclinedInteractionRead(db, { companyId, agentId, runId: run.id, issue,
        interactions: [...history, card].map(row => ({ id: row.id, kind: row.kind, status: row.status, payload: row.payload })) });
    }
    const [reply] = await db.insert(issueComments).values({ companyId, issueId: issue.id, authorAgentId: agentId, createdByRunId: run.id,
      body: "Understood. The approval for that read was already declined, so I won't use the app." }).returning();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    await db.update(issues).set({ executionRunId: run.id, executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    const context = { issueId: issue.id, taskId: issue.id, interactionId: card.id, interactionIds: [card.id],
      interactionKind: "request_confirmation", interactionStatus: card.status, wakeReason: "issue_commented", source: "tool_action_review",
      ...(input.outcomeCount === undefined ? {} : { toolActionOutcomeCount: input.outcomeCount }) };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "person",
      payload: { ...context, mutation: "interaction", _paperclipWakeContext: context } }).returning();
    return { issue, run, wake, reply };
  }

  function release(promotion: () => never) {
    return createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: promotion, getRoutineEnv: promotion,
        resolveSessionBeforeForWakeup: promotion } as never),
      recovery: { escalateStrandedAssignedIssue: promotion, escalateStrandedRecoveryIssueInPlace: promotion } as never,
    });
  }

  it.each([0, 20])("settles the decline continuation with no run when the earlier turn read the decline and replied after it (%s older declines)", async historical => {
    const { issue, run, wake } = await seed({ read: true, historical });
    const promotion = vi.fn((): never => { throw new Error("promotion reached the host"); });
    const result = await release(promotion)({ companyId, runId: run.id, now: new Date() });
    expect(result.outcome.kind).not.toBe("promoted");
    expect(promotion).not.toHaveBeenCalled();
    const [settled] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(settled).toMatchObject({ status: "skipped", runId: null, error: ALREADY_REPORTED_WAKE_REASON });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .filter(row => row.contextSnapshot?.issueId === issue.id && row.id !== run.id)).toEqual([]);
  });

  it.each([
    ["the earlier turn never read the decline", { read: false }],
    ["the card is not a tool action", { read: true, toolAction: false }],
    ["the card was accepted", { read: true, status: "accepted" }],
    ["the batch recorded more outcomes than it lists", { read: true, outcomeCount: 9 }],
  ] as const)("still runs the continuation when %s", async (_label, input) => {
    const { run, wake } = await seed(input);
    const promotion = vi.fn((): never => { throw new Error("promotion reached the host"); });
    await expect(release(promotion)({ companyId, runId: run.id, now: new Date() })).rejects.toThrow("promotion reached the host");
    const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(saved.status).not.toBe("skipped");
  });
});
