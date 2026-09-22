import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, approvals, chatConversations, chatEndpoints,
  chatMessageLinks, chatPublications, companies, createDb, heartbeatRuns, issueApprovals,
  issueComments, issueRelations, issueThreadInteractions, issues, nativeRunFinalizations,
  toolApplications, toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { settleSlackConversation } from "../services/slack-conversation-lifecycle.js";
import { externalConversationStateSql } from "../services/slack-conversation-state.js";
import { executionIssueCondition } from "../services/issue-visibility.js";
import { dashboardService } from "../services/dashboard.js";
import { attentionService } from "../services/attention.js";
import { companySearchQuerySchema } from "@paperclipai/shared";
import { companySearchService } from "../services/company-search.js";
import { recoveryService } from "../services/recovery/service.js";
import { issueService } from "../services/issues.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Slack conversation idle lifecycle", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-slack-idle-");
    db = createDb(database.connectionString);
  }, 90000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function fixture(native = false) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const endpointId = randomUUID();
    const conversationId = randomUUID();
    const runId = randomUUID();
    const wakeId = randomUUID();
    const responseId = randomUUID();
    const publicationId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const start = new Date(Date.now() - 10000);
    await db.insert(companies).values({ id: companyId, name: "Slack", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Carl", role: "general", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "you there?", status: "in_progress", assigneeAgentId: agentId, originKind: "chat_channel" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "native" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId, assignedAgentId: agentId, status: "active" });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: "channel", externalThreadId: runId, externalLabel: "#test" });
    await db.insert(issueComments).values({ id: wakeId, companyId, issueId, authorType: "user", authorUserId: "local-board", body: "you there?", createdAt: start });
    await db.insert(chatMessageLinks).values({ companyId, endpointId, conversationId, commentId: wakeId, providerMessageId: wakeId, direction: "inbound" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", runtimeMode: native ? "native" : "legacy", nativeIssueId: native ? issueId : null,
      resultJson: native ? { finalizationReasonCode: "external_chat_response_waiting" } : null,
      createdAt: new Date(start.getTime() + 1), startedAt: start, finishedAt: new Date(),
      contextSnapshot: { issueId, source: "chat:slack", wakeCommentId: wakeId, wakeCommentIds: [wakeId] } });
    if (native) await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "committed" });
    await db.insert(issueComments).values({ id: responseId, companyId, issueId, authorType: "agent", authorAgentId: agentId, createdByRunId: runId, body: "Yes, I’m here.",
      metadata: { version: 1, authorizationReason: "allow_chat_run_presentation", sections: [] } });
    await db.insert(chatPublications).values({ id: publicationId, companyId, endpointId, conversationId, issueId, commentId: responseId,
      idempotencyKey: `comment:${responseId}:${endpointId}`, payload: { text: "Yes, I’m here." }, state: "published", providerMessageId: responseId, publishedAt: new Date() });
    return { companyId, agentId, issueId, endpointId, conversationId, runId, wakeId, responseId, publicationId, start };
  }
  async function state(f: Awaited<ReturnType<typeof fixture>>) {
    return (await db.select({ status: issues.status, externalConversationState: externalConversationStateSql() })
      .from(issues).where(eq(issues.id, f.issueId)))[0];
  }
  const settle = (f: Awaited<ReturnType<typeof fixture>>) => settleSlackConversation(db, f.companyId, f.issueId);

  it.each([false, true])("settles a published answered turn once (native=%s)", async (native) => {
    const f = await fixture(native);
    expect(await settle(f)).toBe(true);
    expect(await state(f)).toEqual({ status: "in_review", externalConversationState: "waiting" });
    expect(await settle(f)).toBe(false);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, "issue.updated")))).toHaveLength(1);
    expect(await db.select().from(issues).where(and(eq(issues.id, f.issueId), executionIssueCondition()))).toHaveLength(0);
    expect((await issueService(db).getById(f.issueId))?.externalConversationState).toBe("waiting");
    expect(await issueService(db).list(f.companyId)).toHaveLength(0);
    expect((await dashboardService(db).summary(f.companyId)).tasks.open).toBe(0);
    expect((await attentionService(db).list(f.companyId)).items.filter((item) => item.issueId === f.issueId)).toHaveLength(0);
    const results = await companySearchService(db).search(f.companyId, companySearchQuerySchema.parse({ q: "you there" }));
    expect(results.results.find((result) => result.issue?.id === f.issueId)?.issue?.externalConversationState).toBe("waiting");
    expect((await issueService(db).list(f.companyId, { q: "you there" }))[0]?.externalConversationState).toBe("waiting");
    expect((await issueService(db).listReviewAttention(f.companyId, [{ id: f.issueId, companyId: f.companyId, status: "in_review" }])).get(f.issueId)?.state).toBe("none");
  });

  it("preserves waiting state in compact list responses used by the Inbox", async () => {
    const f = await fixture();
    await settle(f);
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    const response = await request(app).get(`/api/companies/${f.companyId}/issues`)
      .query({ view: "compact", q: "you there" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({ id: f.issueId, status: "in_review", externalConversationState: "waiting" })]);
  });

  it("reconciles an already-answered conversation without another model run", async () => {
    const f = await fixture();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    // Restrict to this newly created fixture, like the rollout reconciler's candidate scan.
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await recovery.reconcileStrandedAssignedIssues({ issueCreatedAtGte: issue.createdAt });
    expect((await state(f))?.externalConversationState).toBe("waiting");
    await recovery.reconcileStrandedAssignedIssues({ issueCreatedAtGte: issue.createdAt });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("waits for both finalization and delivery, regardless of their order", async () => {
    for (const first of ["run", "publication"]) {
      const f = await fixture();
      if (first === "run") await db.update(chatPublications).set({ state: "pending" }).where(eq(chatPublications.id, f.publicationId));
      else await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
      expect(await settle(f)).toBe(false);
      await db.update(chatPublications).set({ state: "published" }).where(eq(chatPublications.id, f.publicationId));
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
      expect(await settle(f)).toBe(true);
    }
  });

  it("a new board message reactivates the same conversation and prevents stale settlement", async () => {
    const f = await fixture();
    await settle(f);
    const followup = await issueService(db).addComment(f.issueId, "what's your name?", { userId: "local-board" });
    expect((await state(f))?.externalConversationState).toBe("active");
    expect(await settle(f)).toBe(false);
    expect((await state(f))?.status).toBe("todo");
    await issueService(db).checkout(f.issueId, f.agentId, ["todo", "backlog", "blocked"], null);
    expect((await state(f))?.status).toBe("in_progress");
    const nextRun = randomUUID();
    await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId, commentId: followup.id, providerMessageId: followup.id, direction: "inbound" });
    await db.insert(heartbeatRuns).values({ id: nextRun, companyId: f.companyId, agentId: f.agentId, runtimeMode: "legacy", status: "succeeded", finishedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, source: "chat:slack", wakeCommentId: followup.id } });
    const [response] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId, createdByRunId: nextRun, body: "Carl", metadata: { version: 1, authorizationReason: "allow_chat_run_presentation", sections: [] } }).returning();
    await db.insert(chatPublications).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId, issueId: f.issueId, commentId: response.id,
      idempotencyKey: nextRun, payload: { text: "Carl" }, state: "published", providerMessageId: nextRun });
    expect(await settle(f)).toBe(true);
    expect((await state(f))?.externalConversationState).toBe("waiting");
  });

  it("serializes simultaneous finalizers and a new message without losing the message", async () => {
    const f = await fixture();
    await Promise.all([settle(f), settle(f), issueService(db).addComment(f.issueId, "another request", { userId: "local-board" })]);
    expect((await state(f))?.externalConversationState).toBe("active");
    expect(await settle(f)).toBe(false);
  });

  it("lets an operator explicitly request review instead of keeping Idle", async () => {
    const f = await fixture();
    await settle(f);
    await issueService(db).update(f.issueId, { status: "in_review", actorUserId: "local-board" });
    expect(await state(f)).toEqual({ status: "in_review", externalConversationState: "active" });
    expect(await settle(f)).toBe(false);
  });

  it("duplicate board delivery does not reactivate an answered turn", async () => {
    const f = await fixture();
    const clientRequestId = randomUUID();
    await db.update(issueComments).set({ clientRequestId }).where(eq(issueComments.id, f.wakeId));
    await settle(f);
    const duplicate = await issueService(db).addComment(f.issueId, "you there?", { userId: "local-board" }, { clientRequestId });
    expect(duplicate.id).toBe(f.wakeId);
    expect((await state(f))?.externalConversationState).toBe("waiting");
  });

  it("keeps delivery errors visible after a conversation has settled", async () => {
    const f = await fixture();
    await settle(f);
    await db.update(chatPublications).set({ state: "failed" }).where(eq(chatPublications.id, f.publicationId));
    expect((await state(f))?.externalConversationState).toBe("active");
    expect(await db.select().from(issues).where(and(eq(issues.id, f.issueId), executionIssueCondition()))).toHaveLength(1);
  });

  it("does not settle past an unlinked Slack guest's newer message", async () => {
    const f = await fixture();
    const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "system", body: "one more thing" }).returning();
    await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId, commentId: message.id, providerMessageId: message.id, direction: "inbound" });
    expect(await settle(f)).toBe(false);
  });

  it("requires committed native response-wait evidence", async () => {
    const f = await fixture(true);
    await db.update(nativeRunFinalizations).set({ phase: "arbitrating" }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await settle(f)).toBe(false);
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(heartbeatRuns).set({ resultJson: { finalizationReasonCode: "governed_response_waiting" } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await settle(f)).toBe(false);
  });

  it("settles an authorized published reply after an interaction continuation", async () => {
    const f = await fixture(true);
    const [answer] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "local-board", body: "Here is the requested answer", createdAt: new Date(f.start.getTime() + 2) }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: {
      issueId: f.issueId, source: "issue.interaction.respond", externalChatContinuation: true, wakeCommentId: answer.id,
    } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await settle(f)).toBe(true);
  });

  it("waits for execution release before moving the issue to review", async () => {
    const f = await fixture();
    await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    expect(await settle(f)).toBe(false);
    expect((await state(f))?.status).toBe("in_progress");
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    expect(await settle(f)).toBe(true);
  });

  it.each([
    { status: "pending" },
    { status: "changes_requested" },
    { status: "idle", monitor: { status: "scheduled" } },
    { status: "idle", monitor: { status: "triggered" } },
  ])("preserves governed or monitored unfinished work: %j", async (executionState) => {
    const f = await fixture();
    await db.update(issues).set({ executionState }).where(eq(issues.id, f.issueId));
    expect(await settle(f)).toBe(false);
  });

  it("preserves pending interactions and removes Idle if a real review is requested later", async () => {
    const f = await fixture();
    await settle(f);
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", payload: { version: 1, prompt: "Approve?" } });
    expect((await state(f))?.externalConversationState).toBe("active");
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    await db.update(chatConversations).set({ state: "active" }).where(eq(chatConversations.id, f.conversationId));
    expect(await settle(f)).toBe(false);
  });

  it.each(["failed", "cancelled", "timed_out", "queued", "running", "scheduled_retry"])("does not park a %s run", async (status) => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.runId));
    expect(await settle(f)).toBe(false);
  });
  it.each(["pending", "failed", "delivery_unknown", "retry", "streaming", "awaiting_consent"] as const)("does not park %s delivery", async (state) => {
    const f = await fixture();
    await db.update(chatPublications).set({ state }).where(eq(chatPublications.id, f.publicationId));
    expect(await settle(f)).toBe(false);
  });
  it.each(["done", "blocked", "cancelled", "in_review"])("preserves explicit %s disposition", async (status) => {
    const f = await fixture();
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    expect(await settle(f)).toBe(false);
  });
  it.each(["completed", "unavailable", "endpoint_removed"])("does not reactivate a %s conversation", async (state) => {
    const f = await fixture();
    await db.update(chatConversations).set({ state }).where(eq(chatConversations.id, f.conversationId));
    expect(await settle(f)).toBe(false);
  });
  it("respects company, provider, and connection boundaries", async () => {
    const f = await fixture();
    expect(await settleSlackConversation(db, randomUUID(), f.issueId)).toBe(false);
    await db.update(chatEndpoints).set({ status: "revoked" }).where(eq(chatEndpoints.id, f.endpointId));
    expect(await settle(f)).toBe(false);
    await db.update(chatEndpoints).set({ status: "active", provider: "telegram" }).where(eq(chatEndpoints.id, f.endpointId));
    expect(await settle(f)).toBe(false);
  });
  it("preserves scheduled work, newer runs, queued wakes, monitors, blockers, and approvals", async () => {
    const monitor = await fixture();
    await db.update(issues).set({ monitorNextCheckAt: new Date(Date.now() + 60000) }).where(eq(issues.id, monitor.issueId));
    expect(await settle(monitor)).toBe(false);
    const queued = await fixture();
    await db.insert(agentWakeupRequests).values({ companyId: queued.companyId, agentId: queued.agentId, source: "automation", status: "deferred_issue_execution", payload: { issueId: queued.issueId } });
    expect(await settle(queued)).toBe(false);
    const newer = await fixture();
    await db.insert(heartbeatRuns).values({ companyId: newer.companyId, agentId: newer.agentId, status: "scheduled_retry", contextSnapshot: { issueId: newer.issueId } });
    expect(await settle(newer)).toBe(false);
    const blocked = await fixture();
    const [blocker] = await db.insert(issues).values({ companyId: blocked.companyId, title: "dependency", status: "todo" }).returning();
    await db.insert(issueRelations).values({ companyId: blocked.companyId, issueId: blocker.id, relatedIssueId: blocked.issueId, type: "blocks" });
    expect(await settle(blocked)).toBe(false);
    const review = await fixture();
    const [approval] = await db.insert(approvals).values({ companyId: review.companyId, type: "hire_agent", status: "pending", payload: {} }).returning();
    await db.insert(issueApprovals).values({ companyId: review.companyId, issueId: review.issueId, approvalId: approval.id });
    expect(await settle(review)).toBe(false);
  });
});
