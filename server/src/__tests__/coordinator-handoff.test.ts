import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, assets, chatTaskHandoffs, companies, companyMemberships, createDb, documentRevisions, documents, heartbeatRuns,
  inboxDismissals, issueAttachments, issueComments, issueDocuments, issues, issueThreadInteractions } from "@paperclipai/db";
import { requestConfirmationTargetSchema, suggestedTaskDraftSchema } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { conversationDecisionReceiptsService } from "../services/conversation-decision-receipts.js";
import { attentionService } from "../services/attention.js";

describe("Coordinator task and artifact contracts", () => {
  it("keeps a proposed plan until explicit acceptance and requires immutable attachment identity", () => {
    expect(suggestedTaskDraftSchema.parse({ clientKey: "blog", title: "Write the post", initialPlan: "Draft, review, revise." }).initialPlan)
      .toBe("Draft, review, revise.");
    expect(requestConfirmationTargetSchema.safeParse({ type: "issue_attachment", attachmentId: randomUUID(), assetId: randomUUID(), label: "Latest visual" }).success).toBe(false);
    expect(requestConfirmationTargetSchema.safeParse({ type: "issue_attachment", attachmentId: randomUUID(), assetId: randomUUID(), sha256: "a".repeat(64) }).success).toBe(true);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Coordinator canonical handoffs", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("coordinator-handoff-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false, enableAgentChat: true });
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), conversationId = randomUUID();
    const userId = "local-board";
    await db.insert(companies).values({ id: companyId, name: "Coordinator", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", status: "idle", adapterType: "process" });
    await db.insert(issues).values({ id: conversationId, companyId, title: "Writer chat", status: "in_progress",
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "waiting", assigneeAgentId: agentId,
      visibility: "private", privacyRootIssueId: conversationId, responsibleUserId: userId });
    const scope = { id: conversationId, companyId, projectId: null, goalId: null };
    const service = issueThreadInteractionService(db);
    const propose = () => service.create(scope, { kind: "suggest_tasks", payload: { version: 1, tasks: [
      { clientKey: "blog", title: "Write the launch post", description: "Review-ready blog copy.", initialPlan: "Draft, review, revise." },
    ] } }, { userId });
    const handoff = async () => {
      const suggestion = await propose();
      const accepted = await service.acceptSuggestedTasks(scope, suggestion.id, {}, { userId });
      const [task] = await db.select().from(issues).where(eq(issues.id, accepted.createdIssues[0]!.id));
      return { task, suggestion, accepted };
    };
    const receipts = () => conversationDecisionReceiptsService(db).list(companyId, conversationId, {
      actor: { type: "board", userId, source: "session", ignoreInstanceAdmin: true }, userId,
    });
    const pendingQuestions = () => conversationDecisionReceiptsService(db).listPendingQuestions(companyId, conversationId, {
      actor: { type: "board", userId, source: "session", ignoreInstanceAdmin: true }, userId,
    });
    const ask = (issue: { id: string; companyId: string }) => service.create(issue, {
      kind: "ask_user_questions", payload: { version: 1, questions: [
        { id: "channel", prompt: "Which channel?", selectionMode: "single", options: [{ id: "blog", label: "Blog" }] },
      ] },
    }, { userId });
    const direct = () => issueService(db).create(companyId, {
      title: "Task from the New Task composer", description: "Prepare the next launch post.",
      status: "todo", createdByUserId: userId, assigneeAgentId: agentId,
    });
    return { companyId, agentId, conversationId, userId, scope, service, propose, handoff, receipts, pendingQuestions, ask, direct };
  }

  it.each(["omitted", "null", "agent", "person", "non-chat"])("assigns accepted suggestions correctly for %s ownership", async (mode) => {
    const f = await seed();
    const [otherAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Editor", status: "idle", adapterType: "process" }).returning();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: f.userId, status: "active", membershipRole: "owner" });
    const source = mode === "non-chat" ? await f.direct() : f.scope;
    const assignment = mode === "agent" ? { assigneeAgentId: otherAgent.id }
      : mode === "person" ? { assigneeUserId: f.userId }
      : mode === "null" ? { assigneeAgentId: null, assigneeUserId: null } : {};
    const suggestion = await f.service.create(source, { kind: "suggest_tasks", payload: { version: 1, tasks: [
      { clientKey: "work", title: "Prepare the draft", ...assignment },
    ] } }, { userId: f.userId });
    const result = await f.service.acceptSuggestedTasks(source, suggestion.id, {}, { userId: f.userId });
    const [task] = await db.select().from(issues).where(eq(issues.id, result.createdIssues[0]!.id));
    expect(task).toMatchObject({
      assigneeAgentId: mode === "agent" ? otherAgent.id : mode === "person" || mode === "non-chat" ? null : f.agentId,
      assigneeUserId: mode === "person" ? f.userId : null,
    });
  });

  it("projects direct New Task questions and answers into the assigned agent chat without inventing a chat handoff", async () => {
    const f = await seed();
    const task = await f.direct();
    const question = await f.ask(task);
    expect(await f.pendingQuestions()).toMatchObject([{ subject: { id: question.id }, relatedIssue: { id: task.id } }]);
    expect(await db.select().from(chatTaskHandoffs).where(eq(chatTaskHandoffs.taskId, task.id))).toEqual([]);
    expect((await conversationDecisionReceiptsService(db).listCreatedTasks(f.companyId, f.conversationId, {
      actor: { type: "board", userId: f.userId, source: "session", ignoreInstanceAdmin: true }, userId: f.userId,
    })).items).toEqual([]);
    await f.service.answerQuestions(task, question.id, { answers: [{ questionId: "channel", optionIds: ["blog"] }] }, { userId: f.userId });
    expect(await f.pendingQuestions()).toEqual([]);
    expect((await f.receipts()).items).toMatchObject([{ sourceId: question.id, outcome: "answered", issueId: task.id }]);
  });

  it("limits direct-task projections to this creator, current assignee and company, retaining current privacy checks", async () => {
    const f = await seed(), other = await seed();
    const task = await f.direct();
    const [otherAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Other", adapterType: "process" }).returning();
    const [otherCreator, otherAssignee, privateTask] = await db.insert(issues).values([
      { companyId: f.companyId, title: "Another person's task", createdByUserId: "another-person", assigneeAgentId: f.agentId },
      { companyId: f.companyId, title: "My task with another agent", createdByUserId: f.userId, assigneeAgentId: otherAgent.id },
      { companyId: f.companyId, title: "Someone else's private task", createdByUserId: "another-person", assigneeAgentId: f.agentId, visibility: "private" },
    ]).returning();
    const foreignTask = await other.direct();
    const questions = await Promise.all([task, otherCreator, otherAssignee, privateTask, foreignTask].map(t => f.ask(t)));
    expect((await f.pendingQuestions()).map(item => item.subject.id)).toEqual([questions[0]!.id]);
    for (const [index, item] of [task, otherCreator, otherAssignee, privateTask, foreignTask].entries()) {
      await f.service.answerQuestions(item, questions[index]!.id, { answers: [{ questionId: "channel", optionIds: ["blog"] }] }, { userId: f.userId });
    }
    expect((await f.receipts()).items.map(item => item.sourceId)).toEqual([questions[0]!.id]);
    await db.update(issues).set({ assigneeAgentId: otherAgent.id }).where(eq(issues.id, task.id));
    expect((await f.receipts()).items).toEqual([]);
    await db.update(issues).set({ assigneeAgentId: f.agentId }).where(eq(issues.id, task.id));
    expect((await f.receipts()).items).toHaveLength(1);
    await db.update(issues).set({ visibility: "private", createdByUserId: "another-person", responsibleUserId: "another-person" })
      .where(eq(issues.id, task.id));
    await f.ask(task);
    expect(await f.pendingQuestions()).toEqual([]);
    expect((await f.receipts()).items).toEqual([]);
  });

  it("keeps direct questions across reset but shows direct answers only since the current session boundary", async () => {
    const f = await seed();
    const base = Date.now() - 60_000;
    await db.update(issues).set({ createdAt: new Date(base) }).where(eq(issues.id, f.conversationId));
    const task = await f.direct();
    const oldAnswer = await f.ask(task);
    await f.service.answerQuestions(task, oldAnswer.id, { answers: [{ questionId: "channel", optionIds: ["blog"] }] }, { userId: f.userId });
    await db.update(issueThreadInteractions).set({ resolvedAt: new Date(base + 10_000) }).where(eq(issueThreadInteractions.id, oldAnswer.id));
    const pending = await f.ask(task);
    expect((await f.receipts()).items.map(item => item.sourceId)).toEqual([oldAnswer.id]);
    const [boundary] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.conversationId,
      authorUserId: f.userId, body: "/new", conversationSessionGeneration: 1, createdAt: new Date(base + 20_000) }).returning();
    await db.update(issues).set({ conversationSessionGeneration: 1, conversationBoundaryCommentId: boundary.id })
      .where(eq(issues.id, f.conversationId));
    expect((await f.pendingQuestions()).map(item => item.subject.id)).toEqual([pending.id]);
    expect((await f.receipts()).items).toEqual([]);
    await f.service.answerQuestions(task, pending.id, { answers: [{ questionId: "channel", optionIds: ["blog"] }] }, { userId: f.userId });
    expect((await f.receipts()).items.map(item => item.sourceId)).toEqual([pending.id]);
    // Handoffs still use their captured generation; no new date filter applies.
    const { task: handedTask } = await f.handoff();
    const handedAnswer = await f.ask(handedTask);
    await f.service.answerQuestions(handedTask, handedAnswer.id, { answers: [{ questionId: "channel", optionIds: ["blog"] }] }, { userId: f.userId });
    await db.update(issueThreadInteractions).set({ resolvedAt: new Date(base + 10_000) }).where(eq(issueThreadInteractions.id, handedAnswer.id));
    expect((await f.receipts()).items.map(item => item.sourceId)).toEqual([pending.id, handedAnswer.id]);
    // An incomplete reset cannot fall back to all direct-task history.
    await db.update(issues).set({ conversationBoundaryCommentId: null }).where(eq(issues.id, f.conversationId));
    expect((await f.receipts()).items.map(item => item.sourceId)).toEqual([handedAnswer.id]);
  });

  it("paginates a mixed direct-task and handoff receipt timeline without losing either source's remaining records", async () => {
    const f = await seed();
    const task = await f.direct(), { task: handoffTask } = await f.handoff();
    const sourceIds: string[] = [];
    const base = Date.now();
    for (const [index, target] of [task, task, handoffTask, task].entries()) {
      const question = await f.ask(target);
      await f.service.answerQuestions(target, question.id, { answers: [{ questionId: "channel", optionIds: ["blog"] }] }, { userId: f.userId });
      await db.update(issueThreadInteractions).set({ resolvedAt: new Date(base + index * 1_000) }).where(eq(issueThreadInteractions.id, question.id));
      sourceIds.push(question.id);
    }
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const page = await conversationDecisionReceiptsService(db).list(f.companyId, f.conversationId, {
        actor: { type: "board", userId: f.userId, source: "session", ignoreInstanceAdmin: true }, userId: f.userId, cursor, limit: 1,
      });
      collected.push(...page.items.map(item => item.sourceId));
      cursor = page.nextCursor ?? undefined;
      if (pageNumber < 3) expect(cursor).toBeDefined();
    }
    expect(collected).toEqual(sourceIds.reverse());
    expect(cursor).toBeUndefined();
  });

  it("projects the canonical task question unchanged and removes it after answering without duplicating chat forms", async () => {
    const f = await seed();
    const { task } = await f.handoff();
    const question = await f.ask(task);
    await f.ask(f.scope);
    await f.service.create(task, { kind: "request_confirmation", payload: { version: 1, prompt: "Approve quality?" } }, { userId: f.userId });
    const [unlinked] = await db.insert(issues).values({ companyId: f.companyId, title: "Unrelated task" }).returning();
    await f.ask(unlinked);
    const canonical = await attentionService(db).list(f.companyId, {
      all: true, allowUnscopedAll: true,
      actor: { type: "board", userId: f.userId, source: "session", ignoreInstanceAdmin: true }, userId: f.userId,
    });
    expect(await f.pendingQuestions()).toEqual(canonical.items.filter(item => item.subject.id === question.id));
    expect(await f.pendingQuestions()).toMatchObject([{ sourceKind: "issue_thread_interaction",
      subject: { id: question.id, status: "pending" }, relatedIssue: { id: task.id }, detail: { kind: "questions" } }]);
    await f.service.answerQuestions(task, question.id, { answers: [{ questionId: "channel", optionIds: ["blog"] }] }, { userId: f.userId });
    expect(await f.pendingQuestions()).toEqual([]);
    expect((await f.receipts()).items).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: question.id, outcome: "answered" })]));
  });

  it("shows only questions from tasks handed off by this agent in the current conversation generation", async () => {
    const f = await seed();
    const first = await f.handoff();
    await f.ask(first.task);
    expect(await f.pendingQuestions()).toHaveLength(1);
    await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.conversationId));
    expect(await f.pendingQuestions()).toEqual([]);
    const current = await f.handoff();
    const question = await f.ask(current.task);
    expect((await f.pendingQuestions()).map(item => item.subject.id)).toEqual([question.id]);
    const [otherAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Other", adapterType: "process" }).returning();
    await db.update(chatTaskHandoffs).set({ agentId: otherAgent.id }).where(eq(chatTaskHandoffs.taskId, current.task.id));
    expect(await f.pendingQuestions()).toEqual([]);
  });

  it("denies another conversation owner or company and omits tasks after private access is revoked", async () => {
    const f = await seed(), other = await seed();
    const { task } = await f.handoff();
    await f.ask(task);
    const service = conversationDecisionReceiptsService(db);
    const actor = { type: "board" as const, userId: f.userId, source: "session" as const, ignoreInstanceAdmin: true };
    expect(await f.pendingQuestions()).toHaveLength(1);
    await expect(service.listPendingQuestions(f.companyId, f.conversationId, {
      actor: { type: "board", userId: "another-person", source: "local_implicit" }, userId: "another-person",
    })).rejects.toMatchObject({ status: 404, message: "Conversation not found" });
    await expect(service.listPendingQuestions(other.companyId, f.conversationId, {
      actor, userId: f.userId,
    })).rejects.toMatchObject({ status: 404, message: "Conversation not found" });
    await db.update(issues).set({ visibility: "private", privacyParentIssueId: null, privacyRootIssueId: task.id,
      responsibleUserId: "another-person", createdByUserId: "another-person" }).where(eq(issues.id, task.id));
    expect(await f.pendingQuestions()).toEqual([]);
  });

  it("inherits Needs You dismissal and named-user audience rules", async () => {
    const f = await seed();
    const { task } = await f.handoff();
    const question = await f.ask(task);
    const [item] = await f.pendingQuestions();
    expect(item.subject.id).toBe(question.id);
    await db.insert(inboxDismissals).values({ companyId: f.companyId, userId: f.userId,
      itemKey: item.dismissalKey, kind: "dismiss", dismissedAt: new Date(Date.now() + 1_000) });
    expect(await f.pendingQuestions()).toEqual([]);
    await db.delete(inboxDismissals).where(eq(inboxDismissals.companyId, f.companyId));
    expect(await f.pendingQuestions()).toHaveLength(1);
    await db.update(issueThreadInteractions).set({ addresseeUserId: "another-person" }).where(eq(issueThreadInteractions.id, question.id));
    expect(await f.pendingQuestions()).toEqual([]);
    await db.update(issueThreadInteractions).set({ addresseeUserId: f.userId }).where(eq(issueThreadInteractions.id, question.id));
    expect(await f.pendingQuestions()).toHaveLength(1);
  });

  it("creates exactly one standalone task only on acceptance, with atomic plan, privacy and durable chat audience", async () => {
    const f = await seed();
    const suggestion = await f.propose();
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(chatTaskHandoffs).where(eq(chatTaskHandoffs.companyId, f.companyId))).toHaveLength(0);
    const accepted = await f.service.acceptSuggestedTasks(f.scope, suggestion.id, {}, { userId: f.userId });
    const taskId = accepted.createdIssues[0]!.id;
    expect(accepted.interaction.result).toMatchObject({ createdTasks: [{ issueId: taskId, parentIssueId: null }] });
    const [task] = await db.select().from(issues).where(eq(issues.id, taskId));
    expect(task).toMatchObject({ assigneeAgentId: f.agentId, assigneeUserId: null, parentId: null, visibility: "private", privacyParentIssueId: f.conversationId, privacyRootIssueId: f.conversationId });
    expect(await db.select().from(chatTaskHandoffs).where(eq(chatTaskHandoffs.taskId, taskId))).toMatchObject([
      { conversationId: f.conversationId, agentId: f.agentId, sessionGeneration: 0 },
    ]);
    expect(await conversationDecisionReceiptsService(db).listCreatedTasks(f.companyId, f.conversationId, {
      actor: { type: "board", userId: f.userId, source: "session", ignoreInstanceAdmin: true }, userId: f.userId,
    })).toMatchObject({ items: [{ issueId: taskId, suggestionInteractionId: suggestion.id, sourceRunId: null, status: "todo" }] });
    const plan = await db.select({ body: documentRevisions.body }).from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .innerJoin(documentRevisions, eq(documentRevisions.id, documents.latestRevisionId))
      .where(and(eq(issueDocuments.issueId, taskId), eq(issueDocuments.key, "plan")));
    expect(plan).toEqual([{ body: "Draft, review, revise." }]);
    await expect(f.service.acceptSuggestedTasks(f.scope, suggestion.id, {}, { userId: f.userId })).rejects.toThrow("already been resolved");
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(2);
  });

  it("projects a native explicit task creation without a duplicate suggestion and respects later task access changes", async () => {
    const f = await seed();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      nativeIssueId: f.conversationId, contextSnapshot: { issueId: f.conversationId, conversationSessionGeneration: 0 } });
    const task = await issueService(db).create(f.companyId, {
      title: "Explicitly requested task", createdByAgentId: f.agentId, actorRunId: runId, initialPlan: "Use the authorized scope.",
    });
    const list = () => conversationDecisionReceiptsService(db).listCreatedTasks(f.companyId, f.conversationId, {
      actor: { type: "board", userId: f.userId, source: "session", ignoreInstanceAdmin: true }, userId: f.userId,
    });
    expect(await list()).toMatchObject({ items: [{ id: `chat_handoff:${task.id}`, issueId: task.id, sourceRunId: runId, suggestionInteractionId: null }] });
    const confirmation = await f.service.create(task, { kind: "request_confirmation", payload: { version: 1, prompt: "Approve quality?" } }, { userId: f.userId });
    await f.service.acceptInteraction(task, confirmation.id, {}, { userId: f.userId });
    expect((await f.receipts()).items).toHaveLength(1);
    await db.update(issues).set({ visibility: "private", privacyParentIssueId: null, privacyRootIssueId: task.id,
      responsibleUserId: "another-person", createdByUserId: "another-person" }).where(eq(issues.id, task.id));
    expect((await list()).items).toEqual([]);
    expect((await f.receipts()).items).toEqual([]);
  });

  it("keeps the proposing run as the source when a person accepts a task suggestion", async () => {
    const f = await seed();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      nativeIssueId: f.conversationId, contextSnapshot: { issueId: f.conversationId, conversationSessionGeneration: 0 } });
    const suggestion = await f.service.create(f.scope, { kind: "suggest_tasks", sourceRunId: runId,
      payload: { version: 1, tasks: [{ clientKey: "post", title: "Write the launch post" }] } }, { agentId: f.agentId });
    const accepted = await f.service.acceptSuggestedTasks(f.scope, suggestion.id, {}, { userId: f.userId });
    const page = await conversationDecisionReceiptsService(db).listCreatedTasks(f.companyId, f.conversationId, {
      actor: { type: "board", userId: f.userId, source: "session", ignoreInstanceAdmin: true }, userId: f.userId,
    });
    expect(page.items).toMatchObject([{ issueId: accepted.createdIssues[0]!.id, sourceRunId: runId, suggestionInteractionId: suggestion.id }]);
  });

  it("rolls back acceptance and all task effects if a later creation fails, and rejects another chat participant", async () => {
    const f = await seed();
    const suggestion = await f.service.create(f.scope, { kind: "suggest_tasks", payload: { version: 1, tasks: [
      { clientKey: "one", title: "Valid draft", initialPlan: "Keep the plan atomic." },
      { clientKey: "two", title: "Invalid assignee", assigneeAgentId: randomUUID() },
    ] } }, { userId: f.userId });
    await expect(f.service.acceptSuggestedTasks(f.scope, suggestion.id, {}, { userId: f.userId })).rejects.toThrow();
    expect((await f.service.getById(suggestion.id))?.status).toBe("pending");
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(chatTaskHandoffs).where(eq(chatTaskHandoffs.companyId, f.companyId))).toHaveLength(0);
    await expect(f.service.acceptSuggestedTasks(f.scope, suggestion.id, {}, { userId: "another-person" })).rejects.toThrow();
    await expect(issueService(db).create(f.companyId, { title: "Stale handoff", createdByUserId: f.userId,
      conversationHandoff: { conversationId: f.conversationId, sessionGeneration: 2 } })).rejects.toThrow("reset");
  });

  it("paginates long-lived chat handoffs without duplicating or losing older tasks", async () => {
    const f = await seed();
    const first = await f.handoff(), second = await f.handoff();
    const service = conversationDecisionReceiptsService(db);
    const options = { actor: { type: "board" as const, userId: f.userId, source: "session" as const, ignoreInstanceAdmin: true }, userId: f.userId, limit: 1 };
    const page = await service.listCreatedTasks(f.companyId, f.conversationId, options);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const older = await service.listCreatedTasks(f.companyId, f.conversationId, { ...options, cursor: page.nextCursor! });
    expect(older.nextCursor).toBeNull();
    expect(new Set([...page.items, ...older.items].map(item => item.issueId))).toEqual(new Set([first.task.id, second.task.id]));
    await expect(service.listCreatedTasks(f.companyId, f.conversationId, { ...options, cursor: "invalid" })).rejects.toThrow("Invalid chat handoff cursor");
    // These valid opaque JSON cursors passed the former 36-character regex,
    // but are not UUIDs. Reject as a client error before PostgreSQL's UUID cast.
    for (const id of ["a".repeat(36), "-".repeat(36), "00000000-0000-0000-0000-00000000000-"]) {
      const malformed = Buffer.from(JSON.stringify({ at: page.items[0]!.createdAt, id })).toString("base64url");
      await expect(service.listCreatedTasks(f.companyId, f.conversationId, { ...options, cursor: malformed }))
        .rejects.toMatchObject({ status: 400, message: "Invalid chat handoff cursor" });
    }
  });

  async function attach(f: Awaited<ReturnType<typeof seed>>, taskId: string) {
    const assetId = randomUUID(), attachmentId = randomUUID(), sha256 = "a".repeat(64);
    await db.insert(assets).values({ id: assetId, companyId: f.companyId, provider: "local_disk", objectKey: assetId,
      contentType: "image/png", byteSize: 100, sha256, originalFilename: "visual.png", createdByUserId: f.userId });
    await db.insert(issueAttachments).values({ id: attachmentId, companyId: f.companyId, issueId: taskId, assetId });
    return { type: "issue_attachment" as const, attachmentId, assetId, sha256, label: "Launch visual" };
  }

  it("approves exact uploaded visual bytes without completing the task, and projects the receipt once to its original chat", async () => {
    const f = await seed();
    const { task } = await f.handoff();
    const target = await attach(f, task.id);
    const confirmation = await f.service.create(task, { kind: "request_confirmation", payload: {
      version: 1, prompt: "Approve this visual's quality?", target,
    } }, { userId: f.userId });
    await f.service.acceptInteraction(task, confirmation.id, {}, { userId: f.userId });
    const [currentTask] = await db.select().from(issues).where(eq(issues.id, task.id));
    expect(currentTask.status).toBe("todo");
    expect((await f.service.getById(confirmation.id))?.payload).toMatchObject({ target });
    const first = await f.receipts();
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ id: `issue_thread_interaction:${confirmation.id}`, outcome: "accepted",
      target: { kind: "issue_attachment", attachmentId: target.attachmentId } });
    expect(first.items[0]!.href).toContain(`interaction-${confirmation.id}&attachment=${target.attachmentId}`);
    expect((await f.receipts()).items.map(item => item.id)).toEqual(first.items.map(item => item.id));
    await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.conversationId));
    expect((await f.receipts()).items).toEqual([]);
  });

  it("rejects changed, removed, cross-task, or mislabeled visual bindings and keeps question replies in canonical chat receipts", async () => {
    const f = await seed();
    const { task } = await f.handoff();
    const target = await attach(f, task.id);
    await expect(f.service.create(task, { kind: "request_confirmation", payload: { version: 1, prompt: "Approve?",
      target: { ...target, sha256: "b".repeat(64) } } }, { userId: f.userId })).rejects.toThrow("exact attachment bytes");
    await expect(f.service.create(task, { kind: "request_confirmation", payload: { version: 1, prompt: "Approve?",
      target: { ...target, issueId: f.conversationId } } }, { userId: f.userId })).rejects.toThrow("exact attachment bytes");
    const confirmation = await f.service.create(task, { kind: "request_confirmation", payload: { version: 1, prompt: "Approve?", target } }, { userId: f.userId });
    await db.delete(issueAttachments).where(eq(issueAttachments.id, target.attachmentId));
    await expect(f.service.acceptInteraction(task, confirmation.id, {}, { userId: f.userId })).rejects.toThrow();
    expect((await f.service.getById(confirmation.id))?.status).toBe("expired");
    const question = await f.service.create(task, { kind: "ask_user_questions", payload: { version: 1, questions: [
      { id: "channel", prompt: "Which channel?", selectionMode: "single", options: [{ id: "blog", label: "Blog" }] },
    ] } }, { userId: f.userId });
    await f.service.answerQuestions(task, question.id, { answers: [{ questionId: "channel", optionIds: ["blog"] }] }, { userId: f.userId });
    expect((await f.receipts()).items).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: question.id, outcome: "answered" })]));
    await expect(conversationDecisionReceiptsService(db).list(f.companyId, f.conversationId, {
      actor: { type: "board", userId: "another-person", source: "local_implicit" }, userId: "another-person",
    })).rejects.toThrow("Conversation not found");
  });
});
