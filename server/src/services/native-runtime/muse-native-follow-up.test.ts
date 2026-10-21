import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  heartbeatRuns, issueComments, issues, museAgentBindings, museMailboxItems,
  museRunnerAssignments, museRunnerOperations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";
import { instanceSettingsService } from "../instance-settings.js";
import { consumeMuseHistoryReceipt } from "../muse-assignment-follow-up.js";
import { queuedCommentIdsFromWakePayload } from "../issue-queued-comment-queue.js";

describe("Muse native comment follow-up", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("muse-native-follow-up-");
    db = createDb(temporary.connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableMuse: true });
  }, 30000);
  afterAll(async () => { await temporary?.cleanup(); vi.unstubAllEnvs(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), runId = randomUUID(), bindingId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Muse operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Muse follow-up", issuePrefix: `MF${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Muse", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "muse", museBindingId: bindingId, allowUnmeteredProvider: true, lifecycleMode: "per_turn" } });
    await db.insert(museAgentBindings).values({ id: bindingId, companyId, agentId, operatorId: userId,
      status: "ready", pairedAt: new Date(), receiverContactAt: new Date(), verifiedReplyAt: new Date() });
    const [task] = await db.insert(issues).values({ companyId, title: "Active Muse task", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId }).returning();
    const sessionId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "assignment",
      runtimeMode: "native", nativeIssueId: task!.id, issueId: task!.id, nativeSessionId: sessionId,
      responsibleUserId: userId, contextSnapshot: { issueId: task!.id } }).returning();
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, task!.id));
    const [assignment] = await db.insert(museRunnerAssignments).values({ companyId, bindingId, bindingGeneration: 1, runId, agentId,
      normalizedSessionId: sessionId, turnId: randomUUID(), controllerGeneration: 1, catalogDigest: "sha256:fixture",
      status: "accepted", projection: {}, acceptBy: new Date(Date.now() + 60000), expiresAt: new Date(Date.now() + 60000),
      claimedAt: new Date(), nativeAcceptedAt: new Date() }).returning();
    const comments = await db.insert(issueComments).values([1, 2].map(index => ({ companyId, issueId: task!.id,
      authorUserId: userId, body: `Follow-up ${index}` }))).returning();
    const wake = (commentId: string) => heartbeatService(db).wakeup(agentId, { source: "assignment", triggerDetail: "system",
      reason: "issue_commented", payload: { issueId: task!.id, commentId }, requestedByActorType: "user", requestedByActorId: userId,
      contextSnapshot: { issueId: task!.id, wakeCommentId: commentId, wakeReason: "issue_commented" } });
    async function history(commentIds: string[], failed = false) {
      const [receipt] = await db.insert(museRunnerOperations).values({ companyId, assignmentId: assignment!.id,
        requestId: randomUUID(), digest: "sha256:history", status: "settled",
        command: { action: "tool", input: { name: "get_task_history", arguments: {} } },
        outcome: { status: "completed", isError: failed, result: { comments: commentIds.map(id => ({ id })) } } }).returning();
      return receipt!;
    }
    return { companyId, agentId, run: run!, assignment: assignment!, comments, wake, history };
  }
  it("queues unread comments on the accepted turn, and consumes only an exact successful history receipt", async () => {
    const f = await fixture();
    for (const comment of [f.comments[0]!, f.comments[0]!, f.comments[1]!]) expect((await f.wake(comment.id))?.id).toBe(f.run.id);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
    let wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "deferred_issue_execution", runId: null, finishedAt: null });
    expect(queuedCommentIdsFromWakePayload(wakes[0]!.payload)).toEqual(f.comments.map(comment => comment.id));
    expect(await db.select().from(museMailboxItems).where(and(eq(museMailboxItems.assignmentId, f.assignment.id), eq(museMailboxItems.kind, "follow_up")))).toHaveLength(2);
    // Reading references is not consumption; the deferred wake remains durable.
    wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
    expect(wakes[0]?.status).toBe("deferred_issue_execution");
    const receipt = await f.history(f.comments.map(comment => comment.id));
    await consumeMuseHistoryReceipt(db, receipt);
    await consumeMuseHistoryReceipt(db, receipt);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakes[0]!.id)))[0]).toMatchObject({ status: "coalesced", runId: f.run.id });
  });
  it.each(["partial", "failed", "read before admission", "terminal"] as const)("preserves unread input at the %s boundary", async scenario => {
    const f = await fixture(), receipt = await f.history([f.comments[0]!.id], scenario === "failed");
    if (scenario === "read before admission") await consumeMuseHistoryReceipt(db, receipt);
    for (const comment of f.comments) await f.wake(comment.id);
    if (scenario === "terminal") await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    await consumeMuseHistoryReceipt(db, receipt);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
    const pending = wakes.find(wake => wake.status === "deferred_issue_execution");
    expect(pending).toBeDefined();
    expect(queuedCommentIdsFromWakePayload(pending!.payload)).toEqual(["failed", "terminal"].includes(scenario)
      ? f.comments.map(comment => comment.id) : [f.comments[1]!.id]);
    if (scenario === "read before admission") expect(wakes.find(wake => wake.payload?.commentId === f.comments[0]!.id)?.status).toBe("coalesced");
  });
});
