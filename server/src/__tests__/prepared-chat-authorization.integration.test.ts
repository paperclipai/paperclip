import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, issueComments, chatEndpoints, chatDeliveries, chatMessageLinks, type Db } from "@paperclipai/db";
import { seedBoundChatAuthorization } from "./helpers/bound-chat-authorization.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { authorizeChatConversationForBoundRun, isExternalChatWaitAuthorizationContention }
  from "../services/native-runtime/chat-attachment-reuse.js";

describe("prepared bound-chat authorization", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let fixture: Awaited<ReturnType<typeof seedBoundChatAuthorization>>;
  let binding: typeof fixture.binding, context: typeof fixture.context;
  let companyId: string, issueId: string, otherIssueId: string, endpointId: string,
    conversationId: string, principalId: string, commentId: string, deliveryId: string, userId: string;
  const authorize = (handle: Db = db, ids = [commentId]) =>
    authorizeChatConversationForBoundRun(handle, binding, { ...context, wakeCommentIds: ids }, "read");
  const denied = "paperclip_runner_chat_attachment_binding_denied";
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("prepared-chat-");
    db = createDb(temporary.connectionString);
    fixture = await seedBoundChatAuthorization(db);
    ({ binding, context, companyId, issueId, otherIssueId, endpointId, conversationId,
      principalId, commentId, deliveryId, userId } = fixture);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it("binds changed values and array arities while reading current authorization", async () => {
    await expect(authorize()).resolves.toEqual({ endpointId, conversationId });
    await expect(authorize(db, [commentId, commentId])).resolves.toEqual({ endpointId, conversationId });
    const secondCommentId = randomUUID(), secondDeliveryId = randomUUID();
    await db.insert(issueComments).values({ id: secondCommentId, companyId, issueId,
      authorType: "user", authorUserId: userId, body: "Another message" });
    await db.insert(chatDeliveries).values({ id: secondDeliveryId, companyId, endpointId,
      conversationId, principalId, providerEventId: secondDeliveryId, deduplicationKey: secondDeliveryId,
      eventKind: "message", normalizedEvent: {}, state: "processed", processedAt: new Date() });
    await db.insert(chatMessageLinks).values({ companyId, endpointId, conversationId,
      deliveryId: secondDeliveryId, commentId: secondCommentId, providerMessageId: secondCommentId, direction: "inbound" });
    await expect(authorize(db, [secondCommentId])).resolves.toEqual({ endpointId, conversationId });
    await expect(authorize(db, [secondCommentId, commentId])).resolves.toEqual({ endpointId, conversationId });
    await expect(authorize(db, [commentId, randomUUID()])).rejects.toThrow(denied);
    await expect(authorize(db, [])).rejects.toThrow(denied);
    for (const changed of [{ companyId: randomUUID() }, { issueId: otherIssueId },
      { agentId: randomUUID() }]) {
      await expect(authorizeChatConversationForBoundRun(db, { ...binding, ...changed }, context, "read"))
        .rejects.toThrow(denied);
    }
    await expect(authorizeChatConversationForBoundRun(db, binding, { ...context, source: "chat:discord" }, "read"))
      .rejects.toThrow(denied);
    await expect(authorize(db, ["invalid-uuid"])).rejects.toThrow();
    await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, endpointId));
    await expect(authorize()).rejects.toThrow(denied);
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, endpointId));
    await expect(authorize()).resolves.toEqual({ endpointId, conversationId });
  });

  it("rechecks setup generation and credential fences on a reused template", async () => {
    const startedAt = new Date(Date.now() - 10_000);
    await db.update(chatEndpoints).set({ status: "verifying", setup: {
      step: "test", testStartedAt: startedAt.toISOString(), runtimeGeneration: 7,
    } }).where(eq(chatEndpoints.id, endpointId));
    try {
      await expect(authorize()).rejects.toThrow(denied);
      await db.update(chatDeliveries).set({ normalizedEvent: { runtimeContext: {
        generation: 7, credentialFingerprint: "a".repeat(64),
      } } }).where(eq(chatDeliveries.id, deliveryId));
      await expect(authorize()).resolves.toEqual({ endpointId, conversationId });
      await db.update(chatDeliveries).set({ normalizedEvent: { runtimeContext: {
        generation: 8, credentialFingerprint: "a".repeat(64),
      } } }).where(eq(chatDeliveries.id, deliveryId));
      await expect(authorize()).rejects.toThrow(denied);
      await db.update(chatDeliveries).set({ normalizedEvent: { runtimeContext: {
        generation: 7, credentialFingerprint: "malformed",
      } } }).where(eq(chatDeliveries.id, deliveryId));
      await expect(authorize()).rejects.toThrow(denied);
    } finally {
      await db.update(chatEndpoints).set({ status: "active", setup: {} }).where(eq(chatEndpoints.id, endpointId));
    }
  });

  it("keeps transaction and savepoint sessions separate from a warmed root template", async () => {
    await authorize();
    await expect(db.transaction(async (tx) => {
      await tx.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, endpointId));
      await expect(authorize(tx)).rejects.toThrow(denied);
      await expect(authorize()).resolves.toEqual({ endpointId, conversationId });
      await expect(tx.transaction(async (savepoint) => {
        await savepoint.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, endpointId));
        await expect(authorize(savepoint)).resolves.toEqual({ endpointId, conversationId });
        throw new Error("rollback-savepoint");
      })).rejects.toThrow("rollback-savepoint");
      await expect(authorize(tx)).rejects.toThrow(denied);
      throw new Error("rollback-outer");
    })).rejects.toThrow("rollback-outer");
    await expect(authorize()).resolves.toEqual({ endpointId, conversationId });
    await db.transaction(async (tx) => {
      await expect(authorize(tx)).resolves.toEqual({ endpointId, conversationId });
    });
  });

  it("preserves blocking row locks and NOWAIT contention after read templates are warm", async () => {
    await authorize();
    let release!: () => void;
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const locker = db.transaction(async (tx) => {
      await authorizeChatConversationForBoundRun(tx, binding, context, "blocking");
      acquired();
      await held;
    });
    try {
      await acquiredPromise;
      await expect(authorize()).resolves.toEqual({ endpointId, conversationId });
      let contention: unknown;
      try { await db.transaction((tx) => authorizeChatConversationForBoundRun(tx, binding, context, "nonblocking")); }
      catch (error) { contention = error; }
      expect(isExternalChatWaitAuthorizationContention(contention)).toBe(true);
      await expect(db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '100ms'`);
        await authorizeChatConversationForBoundRun(tx, binding, context, "blocking");
      })).rejects.toThrow();
    } finally { release(); await locker; }
    await db.transaction(async (tx) => {
      await expect(authorizeChatConversationForBoundRun(tx, binding, context, "nonblocking"))
        .resolves.toEqual({ endpointId, conversationId });
    });
  });
});
