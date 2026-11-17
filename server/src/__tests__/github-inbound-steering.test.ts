import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, authUsers, chatActions, chatConversations, chatDeliveries,
  chatEndpoints, chatExternalPrincipals, chatGitHubReviews, chatMessageLinks, companies, companyMemberships, createDb,
  heartbeatRuns, heartbeatRunEvents, issueComments, issues, runIdentityContexts, toolApplications, toolConnections,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createInboundWakeups } from "../services/chat-channels/inbound/wakeups.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { NativeSessionSteeringError } from "../services/native-runtime/native-session-executor.js";
import { chatWakeAuthorityDenied } from "../services/chat-channels/inbound/wakeup-authorization-error.js";
import { defaultGitHubReviewPolicy, type GitHubReviewEventContext } from "@paperclipai/shared";

const steer = vi.hoisted(() => vi.fn());
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>(),
  steerNativeSession: steer,
}));

describe("GitHub inbound steering", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let unregister: (() => void) | undefined;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("github-steering-");
    db = createDb(temporary.connectionString);
    db.$client.options.onnotice = () => {};
  });
  afterEach(async () => {
    unregister?.();
    await heartbeat?.drainActiveRunExecutions();
    await db.execute(sql`truncate companies cascade`);
    vi.clearAllMocks();
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture(provider: "github" | "slack" = "github") {
    const companyId = randomUUID(), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Reviewer", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Review company", issuePrefix: "REV",
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Reviewer", adapterType: "paperclip_runner",
      status: "idle", runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } } }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId, name: "GitHub", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id,
      uid: randomUUID(), name: "GitHub", transport: "rest_api" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection.id, provider,
      publicId: randomUUID(), assignedAgentId: agent.id, status: "active" }).returning();
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider,
      providerAccountId: "installation", externalId: "123", kind: "user" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "PR review", status: "in_progress",
      assigneeAgentId: agent.id }).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId, endpointId: endpoint.id,
      issueId: issue.id, externalConversationId: "paperclipai/paperclip", externalThreadId: "github:paperclipai/paperclip:1",
      externalLabel: "PR #1", state: "active" }).returning();
    const [original, followup] = await db.insert(issueComments).values([
      { companyId, issueId: issue.id, authorUserId: userId, body: "Review this PR" },
      { companyId, issueId: issue.id, authorUserId: userId, body: "The PR has a new commit. Review the updated diff." },
    ]).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "running",
      runtimeMode: "native", nativeIssueId: issue.id, startedAt: new Date(),
      contextSnapshot: { issueId: issue.id, chatConversationId: conversation.id, wakeCommentId: original.id,
        wakeCommentIds: [original.id] } }).returning();
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issue.id));
    await initializeRunIdentity(db, { companyId, runId: run.id, issueId: issue.id,
      responsibleUserId: userId, messageIds: [original.id], cause: "instruction" });
    const [delivery] = await db.insert(chatDeliveries).values({ companyId, endpointId: endpoint.id,
      conversationId: conversation.id, principalId: principal.id, providerEventId: randomUUID(),
      deduplicationKey: randomUUID(), eventKind: "message", state: "processed", normalizedEvent: {} }).returning();
    const [action] = await db.insert(chatActions).values({ companyId, endpointId: endpoint.id,
      conversationId: conversation.id, deliveryId: delivery.id, principalId: principal.id,
      kind: "inbound_wakeup", providerActionId: `inbound_wakeup:${delivery.id}`, status: "issued", updatedAt: new Date(),
      payload: { version: 1, agentId: agent.id, issueId: issue.id, commentId: followup.id,
        sessionGeneration: conversation.sessionGeneration, requestedByActorType: "user", requestedByActorId: userId } }).returning();
    heartbeat = heartbeatService(db);
    const errors: string[] = [];
    let authorizationCount = 0;
    const authorization = { denyAfterAdmission: false };
    const owner = createInboundWakeups(db, {
      authorizeInboundWakeup: async () => { throw new Error("unused"); },
      authorizeInboundWorkStart: async (tx, source) => {
        authorizationCount += 1;
        if (authorization.denyAfterAdmission && authorizationCount > 2) throw chatWakeAuthorityDenied("runtime_fence");
        const [current] = await tx.select().from(issues).where(eq(issues.id, issue.id)).for("update");
        const [currentDelivery] = await tx.select().from(chatDeliveries).where(eq(chatDeliveries.id, source.deliveryId!));
        return { issue: current, endpoint, conversation, delivery: currentDelivery, resource: null };
      },
      attachmentOmissionDetail: () => null, isExternalActionAuthorizationChange: error =>
        (error as { details?: { code?: string } }).details?.code === "chat_action_authorization_changed",
      redactError: error => { errors.push(error instanceof Error ? error.stack! : String(error)); return String(error); },
      fetchImpl: async () => { throw new Error("unused"); }, heartbeat,
    });
    unregister = owner.unregisterDeferredWakeOwner;
    steer.mockResolvedValue({ turnId: "review-turn" });
    return { companyId, issue, run, action, followup, owner, errors, original, authorization, delivery, endpoint, conversation, userId };
  }

  it("steers a new GitHub message into the active review and consumes its saved wake", async () => {
    const f = await fixture();
    expect(await f.owner.processInboundWakeup(f.action.deliveryId!), f.errors.join("\n")).toBe(true);
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({ runId: f.run.id,
      correlationId: f.followup.id, message: expect.stringContaining(f.followup.body) }));
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.action.id));
    expect(receipt).toMatchObject({ status: "coalesced", runId: f.run.id });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run.contextSnapshot?.wakeCommentIds).toContain(f.followup.id);
    const [identity] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.id, run.activeIdentityContextId!));
    expect(identity).toMatchObject({ status: "accepted", messageId: f.followup.id });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    await f.owner.processInboundWakeup(f.action.deliveryId!);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")))).toEqual([]);
  });

  it.each(["steering_unsupported", "steering_temporarily_unavailable", "steering_stale_turn", "steering_rejected"] as const)(
    "keeps the durable wake for a separate turn when steering reports %s", async code => {
      const f = await fixture();
      steer.mockRejectedValueOnce(new NativeSessionSteeringError(code, code));
      expect(await f.owner.processInboundWakeup(f.action.deliveryId!)).toBe(true);
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.action.id));
      expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
      const [identity] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.id, run.activeIdentityContextId!));
      expect(identity.messageId).toBe(f.original.id);
      const [reservation] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.messageId, f.followup.id));
      expect(reservation.status).toBe("rejected");
    },
  );

  it.each(["slack", "legacy", "different_task", "different_conversation", "different_author", "different_trust"])(
    "retains separate delivery for %s", async boundary => {
      const f = await fixture(boundary === "slack" ? "slack" : "github");
      if (boundary === "legacy") await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, f.run.id));
      if (boundary === "different_task") await db.update(heartbeatRuns).set({ nativeIssueId: null, issueId: null,
        contextSnapshot: { ...f.run.contextSnapshot, issueId: randomUUID() } }).where(eq(heartbeatRuns.id, f.run.id));
      if (boundary === "different_conversation") await db.update(heartbeatRuns).set({
        contextSnapshot: { ...f.run.contextSnapshot, chatConversationId: randomUUID() } }).where(eq(heartbeatRuns.id, f.run.id));
      if (boundary === "different_author") await db.update(issueComments).set({ authorUserId: randomUUID() }).where(eq(issueComments.id, f.followup.id));
      if (boundary === "different_trust") await db.update(issueComments).set({
        sourceTrust: { preset: "low_trust_review", disposition: "quarantined", sourceIssueId: f.issue.id },
      }).where(eq(issueComments.id, f.followup.id));
      await f.owner.processInboundWakeup(f.action.deliveryId!);
      expect(steer).not.toHaveBeenCalled();
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.action.id));
      expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
    },
  );

  it("checks current source access again before steering an admitted message", async () => {
    const f = await fixture();
    f.authorization.denyAfterAdmission = true;
    await f.owner.processInboundWakeup(f.action.deliveryId!);
    expect(steer).not.toHaveBeenCalled();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.action.id));
    expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  async function acknowledge(f: Awaited<ReturnType<typeof fixture>>) {
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.run.agentId, runId: f.run.id,
      seq: 1, sourceEventId: randomUUID(), eventType: "item.completed", stream: "system", level: "info",
      payload: { prpEvent: { turnId: "review-turn", itemId: `review-turn:steer:${f.followup.id}`,
        payload: { kind: "steering_acknowledgement" } } } });
  }

  it("recovers a durable acknowledgement without sending the message again", async () => {
    const f = await fixture();
    await acknowledge(f);
    await f.owner.processInboundWakeup(f.action.deliveryId!);
    expect(steer).not.toHaveBeenCalled();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.action.id));
    expect(receipt).toMatchObject({ status: "coalesced", runId: f.run.id });
  });

  it("permits native event persistence while waiting for acknowledgement", async () => {
    const f = await fixture();
    steer.mockImplementationOnce(async () => {
      await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '1s'`);
        await tx.update(heartbeatRuns).set({ resultJson: { concurrentNativeReceipt: true } }).where(eq(heartbeatRuns.id, f.run.id));
        await acknowledge(f);
      });
      return { turnId: "review-turn" };
    });
    await f.owner.processInboundWakeup(f.action.deliveryId!);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.action.id));
    expect(receipt).toMatchObject({ status: "coalesced", runId: f.run.id });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run.resultJson?.concurrentNativeReceipt).toBe(true);
  });

  it("consumes a timed-out steer when its late acknowledgement arrives", async () => {
    const f = await fixture();
    let onAcknowledged: (() => Promise<void>) | undefined;
    steer.mockImplementationOnce(async input => {
      onAcknowledged = input.onAcknowledged;
      throw new NativeSessionSteeringError("steering_timeout", "Timed out");
    });
    await f.owner.processInboundWakeup(f.action.deliveryId!);
    const [pending] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.action.id));
    expect(pending).toMatchObject({ status: "deferred_issue_execution", runId: null });
    await acknowledge(f);
    expect(onAcknowledged).toBeTypeOf("function");
    await onAcknowledged!();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.action.id));
    expect(receipt).toMatchObject({ status: "coalesced", runId: f.run.id });
  });

  it("delivers a burst of GitHub updates to one active review without a wake backlog", async () => {
    const f = await fixture();
    const comments = [f.followup.id];
    await f.owner.processInboundWakeup(f.action.deliveryId!);
    for (let index = 0; index < 3; index++) {
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issue.id,
        authorUserId: f.userId, body: `Additional review comment ${index}` }).returning();
      const [delivery] = await db.insert(chatDeliveries).values({ ...f.delivery, id: randomUUID(),
        providerEventId: randomUUID(), deduplicationKey: randomUUID() }).returning();
      await db.insert(chatActions).values({ ...f.action, id: randomUUID(), deliveryId: delivery.id,
        providerActionId: `inbound_wakeup:${delivery.id}`, payload: { ...f.action.payload, commentId: comment.id } });
      comments.push(comment.id);
      expect(await f.owner.processInboundWakeup(delivery.id)).toBe(true);
    }
    expect(steer).toHaveBeenCalledTimes(4);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")))).toEqual([]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run.contextSnapshot?.wakeCommentIds).toEqual([f.original.id, ...comments]);
  });

  it("steers an automatic push with its review policy and binds its new head to the active run", async () => {
    const f = await fixture();
    const event: GitHubReviewEventContext = { event: "synchronize", deliveryId: randomUUID(), repositoryId: "123",
      repository: "paperclipai/paperclip", pullNumber: 1, title: "Review this PR", body: "Updated diff",
      baseSha: "a".repeat(40), headSha: "b".repeat(40), baseBranch: "master", author: { id: "123", login: "author", isBot: false },
      sender: { id: "123", login: "author" }, draft: false, labels: [] };
    const policy = { ...defaultGitHubReviewPolicy(), instructions: "Check the new commit for concurrency errors." };
    const sourceTrust = { preset: "low_trust_review", disposition: "quarantined", sourceIssueId: f.issue.id } as const;
    await db.update(issueComments).set({ sourceTrust }).where(eq(issueComments.issueId, f.issue.id));
    await db.update(chatDeliveries).set({ normalizedEvent: { githubAutomatic: { context: event, revision: 2, policy } } })
      .where(eq(chatDeliveries.id, f.delivery.id));
    await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: f.endpoint.id,
      conversationId: f.conversation.id, deliveryId: f.delivery.id, commentId: f.followup.id,
      providerMessageId: "github-event", direction: "inbound" });
    const [review] = await db.insert(chatGitHubReviews).values({ companyId: f.companyId, endpointId: f.endpoint.id,
      issueId: f.issue.id, repositoryId: event.repositoryId, repository: event.repository, pullNumber: event.pullNumber,
      headSha: event.headSha, deliveryId: f.delivery.id, configurationRevision: 2, policySnapshot: policy, event, state: "queued" }).returning();
    await f.owner.processInboundWakeup(f.delivery.id);
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(policy.instructions) }));
    const [updated] = await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, review.id));
    expect(updated).toMatchObject({ runId: f.run.id, state: "running", headSha: event.headSha });
  });
});
