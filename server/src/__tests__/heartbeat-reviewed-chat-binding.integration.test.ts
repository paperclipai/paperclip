import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  issueComments,
  issueThreadInteractions,
  toolApplications,
  toolConnections,
  chatEndpoints,
  chatEndpointResources,
  chatConversations,
  chatExternalPrincipals,
  chatIdentityLinks,
  companyMemberships,
  chatDeliveries,
  chatMessageLinks,
  completionContracts,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  workAssessments,
} from "@paperclipai/db";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  attestReviewedExternalChatRun,
  buildPaperclipWakePayload,
} from "../services/heartbeat.js";
import {
  listAuthorizedChatAttachments,
  resolveExternalChatResponseWaitAuthorization,
} from "../services/native-runtime/chat-attachment-reuse.js";
import * as chatAttachmentReuse from "../services/native-runtime/chat-attachment-reuse.js";
import { decideIssueReviewPathRecovery } from "../services/recovery/review-path-recovery.js";
import { resolveCurrentWakeCommentsBinding } from "../services/native-runtime/current-wake-comments.js";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "../services/native-runtime/status-arbiter.js";
import { recoveryService } from "../services/recovery/service.js";

import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";

describe.each(["slack", "discord"] as const)("reviewed %s execution binding", (provider) => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(),
    agentId = randomUUID(),
    issueId = randomUUID(),
    otherIssueId = randomUUID(),
    runId = randomUUID();
  const endpointId = randomUUID(),
    resourceId = randomUUID(),
    conversationId = randomUUID();
  const principalId = randomUUID(),
    commentId = randomUUID(),
    deliveryId = randomUUID();
  const interactionId = randomUUID(),
    userId = "reviewed-chat-user";
  const context = {
    issueId,
    source: `chat:${provider}`,
    wakeReason: "External chat message received",
    wakeCommentIds: [commentId],
    commentId,
  };
  const binding = { companyId, agentId, issueId, runId };
  const attest = (contextSnapshot: Record<string, unknown> = context) =>
    attestReviewedExternalChatRun({ db, ...binding, contextSnapshot });

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase(
      "reviewed-chat-binding-",
    );
    db = createDb(temporary.connectionString);
    await db
      .insert(companies)
      .values({
        id: companyId,
        name: "Reviewed chat",
        issuePrefix: "RCB",
        issueCounter: 1,
      });
    await db
      .insert(agents)
      .values({
        id: agentId,
        companyId,
        name: "Chat runner",
        adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex" },
        status: "active",
      });
    await db
      .insert(issues)
      .values({
        id: issueId,
        companyId,
        title: "Reviewed conversation",
        issueNumber: 1,
        identifier: "RCB-1",
        status: "in_review",
        workMode: "standard",
        assigneeAgentId: agentId,
      });
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Unrelated conversation",
      issueNumber: 2,
      identifier: "RCB-2",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await db
      .insert(heartbeatRuns)
      .values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        nativeIssueId: issueId,
        invocationSource: "assignment",
        triggerDetail: "system",
        contextSnapshot: context,
      });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
    await db
      .insert(issueThreadInteractions)
      .values({
        id: interactionId,
        companyId,
        issueId,
        sourceRunId: runId,
        kind: "request_confirmation",
        status: "pending",
        title: "Real pending governance",
        payload: {
          version: 1,
          prompt: "Review completion before closing this task.",
        },
      });
    const applicationId = randomUUID(),
      connectionId = randomUUID();
    await db
      .insert(toolApplications)
      .values({
        id: applicationId,
        companyId,
        applicationKey: `chat:${provider}:${endpointId}`,
        name: "Discord",
        type: "chat",
        status: "active",
      });
    await db
      .insert(toolConnections)
      .values({
        id: connectionId,
        companyId,
        applicationId,
        name: "Discord",
        uid: `chat-${provider}-${endpointId}`,
        connectionPurpose: "channel",
        transport: "chat_sdk",
        status: "active",
        enabled: true,
      });
    await db
      .insert(chatEndpoints)
      .values({
        id: endpointId,
        companyId,
        connectionId,
        provider,
        publicId: randomUUID(),
        assignedAgentId: agentId,
        status: "active",
        providerAccountId: "guild-1",
        allowUnlinkedPeople: false,
      });
    await db
      .insert(chatEndpointResources)
      .values({
        id: resourceId,
        companyId,
        endpointId,
        type: "channel",
        providerResourceId: "channel-1",
        label: "#review",
        availability: "available",
        enabled: true,
      });
    await db
      .insert(chatConversations)
      .values({
        id: conversationId,
        companyId,
        endpointId,
        resourceId,
        issueId,
        externalConversationId: "channel-1",
        externalThreadId: "thread-1",
        externalLabel: "Review thread",
        state: "active",
      });
    await db
      .insert(chatExternalPrincipals)
      .values({
        id: principalId,
        companyId,
        provider,
        providerAccountId: "guild-1",
        externalId: "user-1",
        kind: "user",
      });
    await db
      .insert(chatIdentityLinks)
      .values({
        companyId,
        endpointId,
        principalId,
        paperclipUserId: userId,
        status: "linked",
      });
    await db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "member",
      });
    await db
      .insert(issueComments)
      .values({
        id: commentId,
        companyId,
        issueId,
        authorType: "user",
        authorUserId: userId,
        body: "Please inspect the earlier photo, without approving completion.",
      });
    await db
      .insert(chatDeliveries)
      .values({
        id: deliveryId,
        companyId,
        endpointId,
        conversationId,
        principalId,
        providerEventId: "review-followup",
        deduplicationKey: "review-followup",
        eventKind: "message",
        normalizedEvent: {},
        state: "processed",
        attempts: 1,
        processedAt: new Date(),
      });
    await db
      .insert(chatMessageLinks)
      .values({
        companyId,
        endpointId,
        conversationId,
        deliveryId,
        commentId,
        providerMessageId: "review-message",
        direction: "inbound",
      });
  }, 30_000);
  afterAll(async () => {
    await temporary?.cleanup();
  });

  it("names exhausted lock contention without accepting authority, then rechecks access after release", async () => {
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { acquired = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lock = db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
      acquired();
      await gate;
    });
    await held;
    const onDenied = vi.fn();
    try {
      await expect(attestReviewedExternalChatRun({
        db, ...binding, contextSnapshot: context, onDenied,
      })).rejects.toMatchObject({
        message: "reviewed_chat_execution_binding_not_ready",
        code: "reviewed_chat_execution_binding_not_ready",
      });
      expect(onDenied).not.toHaveBeenCalled();
    } finally {
      release();
      await lock;
    }
    await expect(attest()).resolves.toBe(true);
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, userId));
    try {
      await expect(attest()).resolves.toBe(false);
    } finally {
      await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.principalId, userId));
    }
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
      .toMatchObject({ status: "in_review", executionRunId: runId, checkoutRunId: null });
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId)))[0]?.status)
      .toBe("pending");
  }, 30_000);

  it("attests a resolved card after queue promotion even when its chat message was already delivered", async () => {
    const [previousIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    const finishingRunId = randomUUID(), wakeId = randomUUID();
    const continuation = { ...context, interactionId, interactionKind: "request_confirmation", interactionStatus: "accepted" };
    await db.insert(heartbeatRuns).values({ id: finishingRunId, companyId, agentId,
      status: "succeeded", invocationSource: "assignment", triggerDetail: "system",
      startedAt: new Date(Date.now() + 1_000), finishedAt: new Date(Date.now() + 2_000),
      contextSnapshot: context });
    await db.update(issues).set({ executionRunId: finishingRunId }).where(eq(issues.id, issueId));
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedByUserId: userId, resolvedAt: new Date() })
      .where(eq(issueThreadInteractions.id, interactionId));
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId,
      source: "automation", triggerDetail: "system", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId, mutation: "interaction", interactionId, interactionKind: "request_confirmation",
        interactionStatus: "accepted", wakeCommentId: commentId, _paperclipWakeContext: continuation } });
    try {
      const release = createReleaseIssueExecution({
        issueLock: createPostgresWakeQueueAdapter(db, {
          resolveResponsibleUserId: async () => userId,
          getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
          resolveSessionBeforeForWakeup: async () => null,
        }), recovery: {} as never,
      });
      const released = await release({ companyId, runId: finishingRunId, now: new Date() });
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
      expect(released.outcome.kind, JSON.stringify(wake)).toBe("promoted");
      const [promoted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, promoted.id));
      const authorize = () => attestReviewedExternalChatRun({ db, companyId, agentId, issueId,
        runId: promoted.id, contextSnapshot: promoted.contextSnapshot! });
      await expect(authorize()).resolves.toBe(true);
      await db.update(chatEndpointResources).set({ enabled: false }).where(eq(chatEndpointResources.id, resourceId));
      await expect(authorize()).resolves.toBe(false);
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, promoted.id));
    } finally {
      await db.update(chatEndpointResources).set({ enabled: true }).where(eq(chatEndpointResources.id, resourceId));
      await db.update(issueThreadInteractions).set({ status: "pending", resolvedByUserId: null, resolvedAt: null })
        .where(eq(issueThreadInteractions.id, interactionId));
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
      await restoreSuccessorLock(previousIssue);
    }
  });

  it("attests existing execution ownership while preserving real pending governance and checkout state", async () => {
    const [before] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    const [gateBefore] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));
    await expect(attest()).resolves.toBe(true);
    expect(
      (await db.select().from(issues).where(eq(issues.id, issueId)))[0],
    ).toEqual(before);
    expect(
      (
        await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, interactionId))
      )[0],
    ).toEqual(gateBefore);
    expect(before).toMatchObject({
      status: "in_review",
      checkoutRunId: null,
      executionRunId: runId,
    });
    const wake = await buildPaperclipWakePayload({
      db,
      companyId,
      agentId,
      contextSnapshot: {
        ...context,
        paperclipExternalChatExecutionBound: true,
      },
    });
    expect(wake).toMatchObject({
      checkedOutByHarness: false,
      externalChatExecutionBound: true,
      externalChatProvider: provider,
    });
    const prompt = renderPaperclipWakePrompt(wake);
    expect(prompt).toContain("not a checkout, approval");
    expect(prompt).toContain("task remains in review");
    expect(prompt).not.toContain("checked out the issue for this run");
  });

  async function withReviewRecovery(
    check: (recovery: Record<string, unknown>) => Promise<void>,
  ) {
    const decision = decideIssueReviewPathRecovery({
      issueId,
      sourceRunId: randomUUID(),
      assigneeAgentId: agentId,
      contextSnapshot: {
        ...context,
        paperclipHarnessCheckedOut: true,
        paperclipExternalChatExecutionBound: true,
      },
      reviewAttention: { state: "stalled", paths: [], reason: "Review path consumed" },
      existingWake: false,
    });
    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: decision.contextSnapshot })
      .where(eq(heartbeatRuns.id, runId));
    try {
      await check(decision.contextSnapshot);
    } finally {
      await db.update(heartbeatRuns)
        .set({ contextSnapshot: context })
        .where(eq(heartbeatRuns.id, runId));
    }
  }

  it("reauthorizes a review recovery from its retained message batch without approving the task", async () => {
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    await withReviewRecovery(async (recovery) => {
      expect(recovery).not.toHaveProperty("paperclipHarnessCheckedOut");
      expect(recovery).not.toHaveProperty("paperclipExternalChatExecutionBound");
      await expect(attest(recovery)).resolves.toBe(true);
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toEqual(before);
      expect((await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId)))[0].status).toBe("pending");
    });
  });

  it("denies recovery after access revocation or a changed company, task, or message binding", async () => {
    await withReviewRecovery(async (recovery) => {
      await expect(attest(recovery)).resolves.toBe(true);
      await expect(attestReviewedExternalChatRun({
        db, ...binding, companyId: randomUUID(), contextSnapshot: recovery,
      })).resolves.toBe(false);
      await expect(attestReviewedExternalChatRun({
        db, ...binding, issueId: otherIssueId, contextSnapshot: recovery,
      })).resolves.toBe(false);
      await expect(attest({ ...recovery, wakeCommentIds: [randomUUID()] })).resolves.toBe(false);
      await db.update(companyMemberships).set({ status: "suspended" })
        .where(eq(companyMemberships.principalId, userId));
      try {
        await expect(attest(recovery)).resolves.toBe(false);
      } finally {
        await db.update(companyMemberships).set({ status: "active" })
          .where(eq(companyMemberships.principalId, userId));
      }
      await db.update(chatEndpointResources).set({ enabled: false })
        .where(eq(chatEndpointResources.id, resourceId));
      try {
        await expect(attest(recovery)).resolves.toBe(false);
      } finally {
        await db.update(chatEndpointResources).set({ enabled: true })
          .where(eq(chatEndpointResources.id, resourceId));
      }
      await db.update(chatConversations).set({ issueId: otherIssueId })
        .where(eq(chatConversations.id, conversationId));
      try {
        await expect(attest(recovery)).resolves.toBe(false);
      } finally {
        await db.update(chatConversations).set({ issueId })
          .where(eq(chatConversations.id, conversationId));
      }
    });
  });

  it("does not trust a supplied marker, owner mismatch, different wake batch, or wrong provider", async () => {
    await db
      .update(issues)
      .set({ executionRunId: null })
      .where(eq(issues.id, issueId));
    try {
      await expect(
        attest({ ...context, paperclipExternalChatExecutionBound: true }),
      ).resolves.toBe(false);
    } finally {
      await db
        .update(issues)
        .set({ executionRunId: runId })
        .where(eq(issues.id, issueId));
    }
    await expect(
      attest({ ...context, wakeCommentIds: [randomUUID()] }),
    ).resolves.toBe(false);
    await expect(
      attest({
        ...context,
        source: "chat:telegram",
        paperclipExternalChatExecutionBound: true,
      }),
    ).resolves.toBe(false);
    await db
      .update(chatEndpoints)
      .set({ provider: "telegram" })
      .where(eq(chatEndpoints.id, endpointId));
    try {
      await expect(attest()).resolves.toBe(false);
    } finally {
      await db
        .update(chatEndpoints)
        .set({ provider })
        .where(eq(chatEndpoints.id, endpointId));
    }
  });

  it("names the first failed check with a closed label", async () => {
    const denial = async (overrides: Partial<Parameters<typeof attestReviewedExternalChatRun>[0]> = {}) => {
      const reasons: string[] = [];
      const attested = await attestReviewedExternalChatRun({
        db, ...binding, contextSnapshot: context, ...overrides, onDenied: (reason) => reasons.push(reason),
      });
      return { attested, reasons };
    };
    await expect(denial()).resolves.toEqual({ attested: true, reasons: [] });
    await expect(denial({ issueId: otherIssueId })).resolves.toEqual({ attested: false, reasons: ["owner_mismatch"] });
    await expect(denial({ runId: randomUUID() })).resolves.toEqual({ attested: false, reasons: ["binding_missing"] });
    await expect(denial({ contextSnapshot: { ...context, wakeCommentIds: [randomUUID()] } }))
      .resolves.toEqual({ attested: false, reasons: ["context_mismatch"] });
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, userId));
    try {
      await expect(denial()).resolves.toEqual({ attested: false, reasons: ["principal_denied"] });
    } finally {
      await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.principalId, userId));
    }
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    try {
      await expect(denial()).resolves.toEqual({ attested: false, reasons: ["run_not_running"] });
    } finally {
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
    }
  });

  it("rejects wrong or revoked principals and disabled provider reach", async () => {
    await db
      .update(chatExternalPrincipals)
      .set({ providerAccountId: "another-guild" })
      .where(eq(chatExternalPrincipals.id, principalId));
    try {
      await expect(attest()).resolves.toBe(false);
    } finally {
      await db
        .update(chatExternalPrincipals)
        .set({ providerAccountId: "guild-1" })
        .where(eq(chatExternalPrincipals.id, principalId));
    }
    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(eq(companyMemberships.principalId, userId));
    try {
      await expect(attest()).resolves.toBe(false);
    } finally {
      await db
        .update(companyMemberships)
        .set({ status: "active" })
        .where(eq(companyMemberships.principalId, userId));
    }
    await db
      .update(chatEndpointResources)
      .set({ enabled: false })
      .where(eq(chatEndpointResources.id, resourceId));
    try {
      await expect(attest()).resolves.toBe(false);
    } finally {
      await db
        .update(chatEndpointResources)
        .set({ enabled: true })
        .where(eq(chatEndpointResources.id, resourceId));
    }
  });

  it("retries contended ownership outside the transaction and rechecks policy after lock release", async () => {
    for (const revoke of [false, true]) {
      let release!: () => void;
      let locked!: () => void;
      const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = db.transaction(async (tx) => {
        await tx
          .select()
          .from(issues)
          .where(eq(issues.id, issueId))
          .for("update");
        locked();
        await gate;
        if (revoke)
          await tx
            .update(companyMemberships)
            .set({ status: "suspended" })
            .where(eq(companyMemberships.principalId, userId));
      });
      await lockReady;
      let finished = false;
      const pending = attest().then((value) => {
        finished = true;
        return value;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(finished).toBe(false);
        release();
        await blocker;
        expect(await pending).toBe(!revoke);
      } finally {
        release();
        await blocker;
        await pending;
        await db
          .update(companyMemberships)
          .set({ status: "active" })
          .where(eq(companyMemberships.principalId, userId));
      }
    }
  });

  // The prior native run commits its status decision before its run row is
  // terminal. A preserve decision does not bump statusVersion, and neither does
  // the successor's claim, so its version check passes after the claim.
  let predecessorContractRevision = 0;
  async function finalizingPredecessor() {
    const predecessorRunId = randomUUID(), contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: ++predecessorContractRevision,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {}, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: predecessorRunId, companyId, agentId, status: "running",
      runtimeMode: "native", nativeIssueId: issueId, invocationSource: "automation", triggerDetail: "system",
      completionContractId: contractId, contextSnapshot: { issueId, source: "github.pull_request_review" } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: predecessorRunId,
      completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", resultJson: {}, canonicalSha256: resultId });
    const [snapshot] = await db.select().from(issues).where(eq(issues.id, issueId));
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId: predecessorRunId,
      contractId, resultId, triggerKind: "native_result", triggerActorCompanyId: companyId,
      priorIssueStatus: snapshot.status, priorStatusVersion: snapshot.statusVersion,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, assessmentJson: {}, inputDigest: assessmentId });
    await db.insert(nativeRunFinalizations).values({ runId: predecessorRunId, companyId, issueId, phase: "arbitrating", resultId, assessmentId });
    const commit = () => commitNativeStatusDecision({
      db, companyId, issueId, runId: predecessorRunId, assessmentId,
      priorStatus: snapshot.status, priorStatusVersion: Number(snapshot.statusVersion), priorDecisionId: snapshot.lastStatusDecisionId,
      decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "preserve", toStatus: "in_review",
        reasonCode: "native_review_action_finished", unblockDescriptor: null, effects: [{ kind: "release_checkout" }] },
    });
    return { predecessorRunId, commit };
  }

  async function restoreSuccessorLock(previous: typeof issues.$inferSelect) {
    await db.update(issues).set({
      checkoutRunId: previous.checkoutRunId, executionRunId: previous.executionRunId,
      executionAgentNameKey: previous.executionAgentNameKey, executionLockedAt: previous.executionLockedAt,
      lastStatusDecisionId: previous.lastStatusDecisionId,
    }).where(eq(issues.id, issueId));
  }

  it("keeps the successor's claim when the finalizing predecessor releases its checkout", async () => {
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const { predecessorRunId, commit } = await finalizingPredecessor();
    const lockedAt = new Date();
    // The successor holds execution; the predecessor still holds its own checkout.
    await db.update(issues).set({ checkoutRunId: predecessorRunId, executionRunId: runId,
      executionAgentNameKey: "chat runner", executionLockedAt: lockedAt }).where(eq(issues.id, issueId));
    try {
      const committed = await commit();
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after).toMatchObject({ status: "in_review", statusVersion: before.statusVersion,
        checkoutRunId: null, executionRunId: runId, executionAgentNameKey: "chat runner" });
      expect(after.executionLockedAt?.getTime()).toBe(lockedAt.getTime());
      const [effect] = await db.select().from(statusDecisionEffects)
        .where(eq(statusDecisionEffects.decisionId, committed.decision.id));
      expect(effect).toMatchObject({ effectKind: "release_checkout", targetType: "issue_checkout",
        payload: { checkoutRunId: null, executionRunId: runId } });
      await expect(attest()).resolves.toBe(true);
    } finally {
      await restoreSuccessorLock(before);
    }
  });

  it("still releases the predecessor's own execution lock and checkout", async () => {
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const { predecessorRunId, commit } = await finalizingPredecessor();
    await db.update(issues).set({ checkoutRunId: predecessorRunId, executionRunId: predecessorRunId,
      executionAgentNameKey: "chat runner", executionLockedAt: new Date() }).where(eq(issues.id, issueId));
    try {
      await commit();
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after).toMatchObject({ status: "in_review", checkoutRunId: null, executionRunId: null,
        executionAgentNameKey: null, executionLockedAt: null });
    } finally {
      await restoreSuccessorLock(before);
    }
  });

  it("leaves a cancelled successor's lock to the stale-lock sweep", async () => {
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const { predecessorRunId, commit } = await finalizingPredecessor();
    const cancelledRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: cancelledRunId, companyId, agentId, status: "cancelled",
      finishedAt: new Date(), invocationSource: "automation", triggerDetail: "system", contextSnapshot: context });
    await db.update(issues).set({ checkoutRunId: predecessorRunId, executionRunId: cancelledRunId,
      executionAgentNameKey: "chat runner", executionLockedAt: new Date() }).where(eq(issues.id, issueId));
    try {
      await commit();
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
        .toMatchObject({ checkoutRunId: null, executionRunId: cancelledRunId });
      const swept = await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks();
      expect(swept.issueIds).toEqual([issueId]);
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
        .toMatchObject({ checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null });
    } finally {
      await restoreSuccessorLock(before);
    }
  });

  it.each(["authorized", "principal_denied", "binding_denied"] as const)(
    "rechecks full authorization when inbound processing commits between reads: %s",
    async (outcome) => {
      await db.update(chatDeliveries)
        .set({ state: "processing", processedAt: null })
        .where(eq(chatDeliveries.id, deliveryId));
      const authorize = chatAttachmentReuse.authorizeChatConversationForBoundRun;
      const observed = vi.spyOn(chatAttachmentReuse, "authorizeChatConversationForBoundRun")
        .mockImplementationOnce(async (...args) => {
          try {
            return await authorize(...args);
          } catch (error) {
            expect(error).toMatchObject({ message: "paperclip_runner_chat_attachment_binding_denied" });
            await db.update(chatDeliveries)
              .set({ state: "processed", processedAt: new Date() })
              .where(eq(chatDeliveries.id, deliveryId));
            throw error;
          }
        });
      try {
        if (outcome === "principal_denied") {
          await db.update(companyMemberships).set({ status: "suspended" })
            .where(eq(companyMemberships.principalId, userId));
        }
        if (outcome === "binding_denied") {
          await db.update(chatConversations).set({ issueId: otherIssueId })
            .where(eq(chatConversations.id, conversationId));
        }
        await expect(attest()).resolves.toBe(outcome === "authorized");
        if (outcome === "authorized") expect(observed).toHaveBeenCalledTimes(2);
      } finally {
        observed.mockRestore();
        await db.update(companyMemberships).set({ status: "active" })
          .where(eq(companyMemberships.principalId, userId));
        await db.update(chatConversations).set({ issueId })
          .where(eq(chatConversations.id, conversationId));
        await db.update(chatDeliveries)
          .set({ state: "processed", processedAt: new Date() })
          .where(eq(chatDeliveries.id, deliveryId));
      }
    },
  );

  it("waits for exact inbound delivery processing to commit before attesting", async () => {
    await db
      .update(chatDeliveries)
      .set({ state: "processing", processedAt: null })
      .where(eq(chatDeliveries.id, deliveryId));
    let finished = false;
    const pending = attest().then((value) => {
      finished = true;
      return value;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(finished).toBe(false);
      await db
        .update(chatDeliveries)
        .set({ state: "processed", processedAt: new Date() })
        .where(eq(chatDeliveries.id, deliveryId));
      expect(await pending).toBe(true);
      await db
        .update(chatDeliveries)
        .set({ state: "retry" })
        .where(eq(chatDeliveries.id, deliveryId));
      expect(await attest()).toBe(false);
    } finally {
      await db
        .update(chatDeliveries)
        .set({ state: "processed", processedAt: new Date() })
        .where(eq(chatDeliveries.id, deliveryId));
      await pending;
    }
  });

  it("binds closed historical/current readers without pretending checkout occurred", async () => {
    expect(await attest()).toBe(true);
    const wake = await buildPaperclipWakePayload({
      db,
      companyId,
      agentId,
      contextSnapshot: {
        ...context,
        paperclipExternalChatExecutionBound: true,
      },
    });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          ...context,
          paperclipExternalChatExecutionBound: true,
          paperclipWake: { ...wake, fallbackFetchNeeded: true },
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    try {
      await expect(
        listAuthorizedChatAttachments({ db, binding, limit: 20 }),
      ).resolves.toMatchObject({ attachments: [], complete: true });
      await expect(
        resolveExternalChatResponseWaitAuthorization({ db, binding }),
      ).resolves.toBe("authorized");
      await expect(
        resolveCurrentWakeCommentsBinding(db, binding),
      ).resolves.toMatchObject({
        provider,
        commentIds: [commentId],
      });
      await db
        .update(companyMemberships)
        .set({ status: "suspended" })
        .where(eq(companyMemberships.principalId, userId));
      await expect(
        listAuthorizedChatAttachments({ db, binding, limit: 20 }),
      ).rejects.toThrow("principal_denied");
    } finally {
      await db
        .update(companyMemberships)
        .set({ status: "active" })
        .where(eq(companyMemberships.principalId, userId));
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: context })
        .where(eq(heartbeatRuns.id, runId));
    }
  });
});
