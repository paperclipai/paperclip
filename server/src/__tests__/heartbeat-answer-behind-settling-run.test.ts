import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const gate = vi.hoisted(() => ({ release: () => {}, onTurn: async () => {}, turns: 0 }));
const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => {
  gate.turns += 1;
  if (gate.turns === 1) await new Promise<void>(resolve => { gate.release = resolve; });
  // Each turn finishes the task, as the worker in the eval did.
  await gate.onTurn();
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Turn finished.", provider: "test", model: "test-model" };
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error("Timed out waiting for condition");
}

describeEmbeddedPostgres("an answer saved while the worker settles its turn", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const userId = "answer-behind-settling-user";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-answer-behind-settling-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Board", email: "board@example.test", createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  /**
   * Morgan's turn is running while the person answers its question and the chat lead relays the answer as a
   * task comment; both wait behind the turn. The turn then completes the task without reading the answer.
   */
  async function settleWithQueuedAnswer(options: { answerAfterCompletion?: boolean; blockerReopens?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), leadId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Answer fixture", issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    for (const [id, name] of [[agentId, "Morgan"], [leadId, "CEO"]] as const) {
      await db.insert(agents).values({ id, companyId, name, role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    }
    await db.insert(issues).values({ id: issueId, companyId, title: "Website naming task", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId });
    const [question] = await db.insert(issueThreadInteractions).values({ companyId, issueId, createdByAgentId: agentId, kind: "ask_user_questions", status: "pending",
      continuationPolicy: "wake_assignee", title: "Website product name",
      payload: { version: 1, questions: [{ id: "name", prompt: "Which product name?", selectionMode: "single", options: [{ id: "acorn", label: "Acorn" }, { id: "birch", label: "Birch" }] }] } }).returning();

    gate.turns = 0;
    const answeredAt = new Date(), completedAt = new Date(answeredAt.getTime() + (options.answerAfterCompletion ? -60_000 : 60_000));
    const blockerId = randomUUID();
    gate.onTurn = async () => {
      // A blocker can reopen while the turn runs; the turn still marks this task done.
      if (options.blockerReopens && gate.turns === 1) {
        await db.insert(issues).values({ id: blockerId, companyId, title: "Brand review", status: "todo", responsibleUserId: userId });
        await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
      }
      await db.update(issues).set({ status: "done", completedAt }).where(eq(issues.id, issueId));
    };
    const first = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" }, requestedByActorType: "system", requestedByActorId: null });
    expect(first).not.toBeNull();
    await waitFor(async () => gate.turns === 1);

    // The person answers while the worker is still settling its turn.
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedByUserId: userId, resolvedAt: answeredAt,
      result: { version: 1, answers: [{ questionId: "name", optionIds: ["acorn"] }] } }).where(eq(issueThreadInteractions.id, question!.id));
    const answerContext = { issueId, taskId: issueId, mutation: "interaction", interactionId: question!.id, interactionKind: "ask_user_questions",
      interactionStatus: "answered", wakeReason: "issue_commented", source: "issue.interaction.respond" };
    await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented", payload: answerContext,
      contextSnapshot: answerContext, requestedByActorType: "user", requestedByActorId: userId });
    // The chat lead relays the answer as its own comment on the task.
    const [relay] = await db.insert(issueComments).values({ companyId, issueId, authorAgentId: leadId, body: "The product name is Acorn." }).returning();
    await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId, commentId: relay!.id }, contextSnapshot: { issueId, taskId: issueId, commentId: relay!.id, wakeCommentId: relay!.id, wakeReason: "issue_commented" },
      requestedByActorType: "agent", requestedByActorId: leadId });

    gate.release();
    const settled = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).every(r => ["succeeded", "failed", "cancelled", "timed_out"].includes(r.status));
    await waitFor(async () => (await settled()) && (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, agentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")))).length === 0, 60_000);
    await heartbeat.drainActiveRunExecutions();
    await waitFor(settled, 60_000);
    return { question: question!, issueId, agentId, blockerId };
  }

  it("delivers a person's answer saved before the worker closed the task, without replaying it", async () => {
    const { question, agentId } = await settleWithQueuedAnswer();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)).orderBy(asc(heartbeatRuns.createdAt));
    const bound = runs.filter(r => (r.contextSnapshot as Record<string, unknown> | null)?.interactionId === question.id);
    expect(bound.map(r => ({ status: r.status, started: !!r.startedAt }))).toEqual([{ status: "succeeded", started: true }]);
    const [answerWake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, agentId),
      sql`${agentWakeupRequests.payload}->>'interactionId' = ${question.id}`));
    expect(answerWake?.status).not.toBe("cancelled");
    expect(answerWake?.runId).toBe(bound[0]!.id);
  }, 120_000);

  it("still drops an answer saved only after the task was completed", async () => {
    const { question, agentId } = await settleWithQueuedAnswer({ answerAfterCompletion: true });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.filter(r => (r.contextSnapshot as Record<string, unknown> | null)?.interactionId === question.id)).toEqual([]);
    const [answerWake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, agentId),
      sql`${agentWakeupRequests.payload}->>'interactionId' = ${question.id}`));
    expect(answerWake).toMatchObject({ status: "cancelled", error: "Deferred execution wake no longer applies to a terminal task" });
  }, 120_000);

  it("settles without reopening when a blocker reopened during the turn forbids in_progress", async () => {
    const { question, agentId, issueId, blockerId } = await settleWithQueuedAnswer({ blockerReopens: true });
    const [task] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(task?.status).toBe("done");
    const [answerWake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, agentId),
      sql`${agentWakeupRequests.payload}->>'interactionId' = ${question.id}`));
    expect(answerWake).toMatchObject({ status: "cancelled", error: "Queued answer cannot continue a task with unresolved blockers", runId: null });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.map(r => r.status)).toEqual(["succeeded"]);
    expect(blockerId).toBeTruthy();
  }, 120_000);
});
