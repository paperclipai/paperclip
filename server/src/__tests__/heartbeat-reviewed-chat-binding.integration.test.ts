import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
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
import { resolveCurrentWakeCommentsBinding } from "../services/native-runtime/current-wake-comments.js";

describe("reviewed external-chat execution binding", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(),
    agentId = randomUUID(),
    issueId = randomUUID(),
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
    source: "chat:discord",
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
        applicationKey: `chat:discord:${endpointId}`,
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
        uid: `chat-discord-${endpointId}`,
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
        provider: "discord",
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
        provider: "discord",
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
      externalChatProvider: "discord",
    });
    const prompt = renderPaperclipWakePrompt(wake);
    expect(prompt).toContain("not a checkout, approval");
    expect(prompt).toContain("task remains in review");
    expect(prompt).not.toContain("checked out the issue for this run");
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
        .set({ provider: "discord" })
        .where(eq(chatEndpoints.id, endpointId));
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
        provider: "discord",
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
