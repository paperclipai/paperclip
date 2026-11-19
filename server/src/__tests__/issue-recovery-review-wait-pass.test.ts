import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { chatConversations, chatDeliveries, chatEndpoints, chatMessageLinks, heartbeatRuns, issueComments, issues,
  statusDecisions, type Db } from "@paperclipai/db";
import { listExternalReviewWaits } from "../services/native-runtime/external-review-wait.js";
import { createRecoveryPassReads } from "../services/recovery/pass-reads.js";
import { seedBoundChatAuthorization } from "./helpers/bound-chat-authorization.js";
import { seedGitHubReviewWait } from "./helpers/github-review-wait.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

const boundRunLinkRead = /from "chat_message_links" inner join "chat_deliveries"/i;

async function waitOnReply(db: Db, input: { companyId: string; issueId: string; runId: string }) {
  const decisionId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.insert(statusDecisions).values({ id: decisionId, companyId: input.companyId, issueId: input.issueId, runId: input.runId,
      assessmentId: randomUUID(), decisionVersion: 1, policyVersion: "test", fromStatus: "in_progress", toStatus: "in_review",
      reasonCode: "external_chat_response_waiting", decisionJson: {}, decisionDigest: decisionId, applicationState: "applied",
      appliedAt: new Date() });
  });
  await db.update(issues).set({ status: "in_review", lastStatusDecisionId: decisionId }).where(eq(issues.id, input.issueId));
}

describeIssueRecovery("stranded-task external review waits within one pass", () => {
  const state = issueRecoveryFixture({ meter: true });

  async function seed() {
    const db = state.db;
    const f = await seedBoundChatAuthorization(db);
    const otherConversationId = randomUUID(), otherCommentId = randomUUID(), deliveryId = randomUUID(), otherRunId = randomUUID();
    await db.insert(chatConversations).values({ id: otherConversationId, companyId: f.companyId, endpointId: f.endpointId,
      resourceId: f.resourceId, issueId: f.otherIssueId, externalConversationId: "channel-1", externalThreadId: "thread-2",
      externalLabel: "Other thread", state: "active" });
    await db.insert(issueComments).values({ id: otherCommentId, companyId: f.companyId, issueId: f.otherIssueId,
      authorType: "user", authorUserId: f.userId, body: "Another request" });
    await db.insert(chatDeliveries).values({ id: deliveryId, companyId: f.companyId, endpointId: f.endpointId,
      conversationId: otherConversationId, principalId: f.principalId, providerEventId: deliveryId, deduplicationKey: deliveryId,
      eventKind: "message", normalizedEvent: {}, state: "processed", processedAt: new Date() });
    await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: otherConversationId,
      deliveryId, commentId: otherCommentId, providerMessageId: otherCommentId, direction: "inbound" });
    await db.insert(heartbeatRuns).values([
      { id: f.runId, companyId: f.companyId, agentId: f.agentId, status: "succeeded", runtimeMode: "native", nativeIssueId: f.issueId,
        finishedAt: new Date(), contextSnapshot: { ...f.context, issueId: f.issueId } },
      { id: otherRunId, companyId: f.companyId, agentId: f.agentId, status: "succeeded", runtimeMode: "native",
        nativeIssueId: f.otherIssueId, finishedAt: new Date(),
        contextSnapshot: { ...f.context, issueId: f.otherIssueId, wakeCommentIds: [otherCommentId] } },
    ]);
    await waitOnReply(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId });
    await waitOnReply(db, { companyId: f.companyId, issueId: f.otherIssueId, runId: otherRunId });

    const inherited = await seedGitHubReviewWait(db, { companyId: f.companyId, agentId: f.agentId });
    await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native", finishedAt: new Date(),
      contextSnapshot: { issueId: inherited.issueId } }).where(eq(heartbeatRuns.id, inherited.runId));
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, inherited.endpointId));
    await waitOnReply(db, { companyId: f.companyId, issueId: inherited.issueId, runId: inherited.runId });

    const [none] = await db.insert(issues).values({ companyId: f.companyId, title: "No wait", status: "in_review",
      assigneeAgentId: f.agentId }).returning({ id: issues.id });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded", runtimeMode: "native",
      nativeIssueId: none!.id, finishedAt: new Date(), contextSnapshot: { issueId: none!.id } });

    const foreign = await seedGitHubReviewWait(db);
    await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native", finishedAt: new Date(),
      contextSnapshot: { issueId: foreign.issueId } }).where(eq(heartbeatRuns.id, foreign.runId));
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, foreign.endpointId));
    await waitOnReply(db, { companyId: foreign.companyId, issueId: foreign.issueId, runId: foreign.runId });

    return { companyId: f.companyId, direct: [f.issueId, f.otherIssueId], inherited: inherited.issueId, none: none!.id,
      foreign: { companyId: foreign.companyId, issueId: foreign.issueId } };
  }

  it("answers each task's review wait the same from one read for the pass as from one read per task", async () => {
    const f = await seed();
    const ids = [...f.direct, f.inherited, f.none, f.foreign.issueId];
    const single = new Set<string>();
    for (const issueId of ids) {
      if ((await listExternalReviewWaits(state.db, f.companyId, [issueId])).length) single.add(issueId);
    }
    const batched = new Set((await listExternalReviewWaits(state.db, f.companyId, ids)).map(wait => wait.issueId));
    expect(batched).toEqual(single);
    for (const issueId of f.direct) expect(single).toContain(issueId);
    expect(single).not.toContain(f.none);
    expect(single).not.toContain(f.foreign.issueId);
    const foreignSingle = (await listExternalReviewWaits(state.db, f.foreign.companyId, [f.foreign.issueId])).length > 0;
    const foreignBatched = (await listExternalReviewWaits(state.db, f.foreign.companyId, ids)).some(wait => wait.issueId === f.foreign.issueId);
    expect(foreignBatched).toBe(foreignSingle);
  });

  it("reads the review waits of a pass once and skips the same tasks as per-task reads", async () => {
    const f = await seed();
    const ids = [...f.direct, f.inherited, f.none];
    const check = (issueId: string, pass?: ReturnType<typeof createRecoveryPassReads>) =>
      state.heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId, skipExternalConversationSettlement: true,
        skipRelatedRecovery: true, ...(pass ? { pass } : {}) });
    const run = async (pass?: ReturnType<typeof createRecoveryPassReads>) => {
      state.meter.startLog();
      const results = [];
      for (const issueId of ids) {
        const { issueIds: _ids, ...counts } = await check(issueId, pass);
        results.push(counts);
      }
      const log = state.meter.stopLog();
      return { results, linkReads: log.filter(entry => boundRunLinkRead.test(entry.sql)).length, statements: log.length };
    };
    const perTask = await run();
    const perPass = await run(createRecoveryPassReads(ids));
    console.info(JSON.stringify({ perTask: { linkReads: perTask.linkReads, statements: perTask.statements },
      perPass: { linkReads: perPass.linkReads, statements: perPass.statements } }));
    expect(perPass.results).toEqual(perTask.results);
    expect(perTask.linkReads).toBeGreaterThanOrEqual(f.direct.length);
    expect(perPass.linkReads).toBeLessThan(perTask.linkReads);
    expect(perPass.statements).toBeLessThan(perTask.statements);
  });
});
