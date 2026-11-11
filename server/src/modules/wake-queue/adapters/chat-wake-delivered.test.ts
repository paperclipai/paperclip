import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createReleaseIssueExecution } from "../application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "./postgres.js";
import { resolveInboundWakeReceipt } from "../../../services/chat-inbound-wakeup-publications.js";
import { createDurableChatWakeupRequest } from "../../../services/durable-chat-wakeup.js";

const support = await getEmbeddedPostgresTestSupport();

// A GitHub message arrives while the agent's run is active. The wake is saved
// behind that run. The run reads the message (it is in its wake input) and
// finishes. Before this fix the saved wake was still promoted, with its message
// ids removed. A reviewed chat run with no message cannot be attested, so it
// failed with `reviewed_chat_execution_binding_not_authorized` (context_mismatch)
// and blocked the task.
describe.skipIf(!support.supported)("release of a saved chat wake whose message was delivered", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("wake-chat-delivered-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Chat wake fixture", issuePrefix: "CWD" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Reviewer", adapterType: "process" }).returning();
    companyId = company.id;
    agentId = agent.id;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function seed(delivered: boolean) {
    const [issue] = await db.insert(issues).values({ companyId, title: "Review a pull request", status: "in_review",
      assigneeAgentId: agentId }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue.id, authorUserId: "chat-user",
      body: "GitHub review request.", createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000) }).returning();
    // The finishing run started after the message and received it as wake input.
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded",
      invocationSource: "assignment", triggerDetail: "system", startedAt: new Date(Date.now() - 30_000), finishedAt: new Date(),
      contextSnapshot: { issueId: issue.id, source: "chat:github", wakeReason: "External chat message received",
        chatConversationId: randomUUID(), ...(delivered ? { wakeCommentIds: [message.id] } : { wakeCommentIds: [randomUUID()] }) },
    }).returning();
    await db.update(issues).set({ executionRunId: run.id, executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    const context = { issueId: issue.id, taskId: issue.id, source: "chat:github", wakeReason: "External chat message received",
      wakeSource: "assignment", chatConversationId: randomUUID(), commentId: message.id, wakeCommentId: message.id,
      wakeCommentIds: [message.id] };
    const wakeId = randomUUID();
    const { idempotencyKey } = createDurableChatWakeupRequest({ id: wakeId, companyId, agentId, issueId: issue.id,
      commentId: message.id, requestedByActorType: "user", requestedByActorId: "chat-user", requestedAt: new Date(),
      authorize: async () => {} });
    const [wake] = await db.insert(agentWakeupRequests).values({ id: wakeId, idempotencyKey, companyId, agentId, source: "assignment",
      triggerDetail: "system", reason: "External chat message received", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "chat-user",
      payload: { issueId: issue.id, mutation: "chat_message_received", wakeCommentId: message.id, _paperclipWakeContext: context },
    }).returning();
    return { issue, run, wake };
  }

  function release(unexpected: () => never) {
    return createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: unexpected, getRoutineEnv: unexpected,
        resolveSessionBeforeForWakeup: unexpected } as never),
      recovery: { escalateStrandedAssignedIssue: unexpected, escalateStrandedRecoveryIssueInPlace: unexpected } as never,
    });
  }

  it("consumes the saved chat wake instead of starting a run with no message", async () => {
    const { run, wake } = await seed(true);
    const unexpected = vi.fn((): never => { throw new Error("Unexpected promotion of a consumed chat wake"); });
    const result = await release(unexpected)({ companyId, runId: run.id, now: new Date() });
    expect(result.outcome.kind).toBe("released");
    expect(unexpected).not.toHaveBeenCalled();
    const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(saved).toMatchObject({ status: "cancelled", runId: null, error: "Queued messages were already delivered to a completed run" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).then(rows =>
      rows.filter(row => row.contextSnapshot?.issueId === saved.payload?.issueId && row.id !== run.id))).toEqual([]);
  });

  it("does not report a delivered chat message as not started", async () => {
    const { wake } = await seed(true);
    const action = { id: wake.id, companyId, kind: "inbound_wakeup", conversationId: randomUUID(), deliveryId: randomUUID(),
      principalId: randomUUID(), createdAt: wake.requestedAt, status: "processed",
      payload: { version: 1, agentId, issueId: wake.payload?.issueId, commentId: wake.payload?.wakeCommentId,
        requestedByActorType: "user", requestedByActorId: "chat-user" } };
    const consumed = { ...wake, status: "cancelled", error: "Queued messages were already delivered to a completed run" };
    expect(resolveInboundWakeReceipt(action as never, consumed, consumed)).toBeNull();
    // Other declines keep their notice.
    const refused = { ...wake, status: "cancelled", error: "Deferred wake suppressed by active subtree pause hold" };
    expect(resolveInboundWakeReceipt(action as never, refused, refused)).toMatchObject({ state: "not_started" });
  });

  it("still promotes a saved chat wake whose message no run has received", async () => {
    const { run, wake } = await seed(false);
    // Promotion reaches the host; the refusal proves the wake was not consumed.
    const unexpected = vi.fn((): never => { throw new Error("promotion reached the host"); });
    await expect(release(unexpected)({ companyId, runId: run.id, now: new Date() })).rejects.toThrow("promotion reached the host");
    expect(unexpected).toHaveBeenCalled();
    const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(saved.status).not.toBe("cancelled");
  });
});
