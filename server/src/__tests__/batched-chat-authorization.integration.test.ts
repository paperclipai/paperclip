import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, chatExternalPrincipals,
  chatIdentityLinks, chatMessageLinks, companyMemberships, createDb, issueComments, type Db } from "@paperclipai/db";
import { seedBoundChatAuthorization } from "./helpers/bound-chat-authorization.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { authorizeChatConversationForBoundRun, authorizeChatConversationsForBoundRuns,
  isBoundChatAuthorizationDenial, type ChatReuseBinding } from "../services/native-runtime/chat-attachment-reuse.js";

type Run = { binding: ChatReuseBinding; contextSnapshot: unknown };

describe("batched bound-chat authorization", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let f: Awaited<ReturnType<typeof seedBoundChatAuthorization>>;
  // A second conversation of the same company and endpoint, on another issue,
  // from another person who has no identity link.
  let other: { conversationId: string; commentId: string; principalId: string };

  // The outcome of one separate read-mode call: the conversation, null for a
  // policy denial, or the thrown error.
  const single = (run: Run) => authorizeChatConversationForBoundRun(db, run.binding, run.contextSnapshot, "read")
    .catch((error: unknown) => {
      if (isBoundChatAuthorizationDenial(error)) return null;
      throw error;
    });
  const expectSameOutcomes = async (runs: Run[]) => {
    const separate = await Promise.all(runs.map(single));
    const batched = await authorizeChatConversationsForBoundRuns(db, f.companyId, runs);
    expect(batched).toEqual(separate);
    return batched;
  };
  const run = (overrides: { binding?: Partial<ChatReuseBinding>; context?: Record<string, unknown> } = {}): Run => ({
    binding: { ...f.binding, ...overrides.binding },
    contextSnapshot: { ...f.context, ...overrides.context },
  });
  const otherRun = (context: Record<string, unknown> = {}) =>
    run({ binding: { issueId: f.otherIssueId, runId: randomUUID() }, context: { wakeCommentIds: [other.commentId], ...context } });

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("batched-chat-");
    db = createDb(temporary.connectionString);
    f = await seedBoundChatAuthorization(db);
    other = { conversationId: randomUUID(), commentId: randomUUID(), principalId: randomUUID() };
    const deliveryId = randomUUID();
    await db.insert(chatConversations).values({ id: other.conversationId, companyId: f.companyId,
      endpointId: f.endpointId, resourceId: f.resourceId, issueId: f.otherIssueId,
      externalConversationId: "channel-1", externalThreadId: "thread-2", externalLabel: "Other thread", state: "waiting" });
    await db.insert(chatExternalPrincipals).values({ id: other.principalId, companyId: f.companyId,
      provider: "slack", providerAccountId: "guild-1", externalId: "user-2", kind: "user" });
    await db.insert(issueComments).values({ id: other.commentId, companyId: f.companyId, issueId: f.otherIssueId,
      authorType: "user", authorUserId: "other-user", body: "Another request" });
    await db.insert(chatDeliveries).values({ id: deliveryId, companyId: f.companyId, endpointId: f.endpointId,
      conversationId: other.conversationId, principalId: other.principalId, providerEventId: deliveryId,
      deduplicationKey: deliveryId, eventKind: "message", normalizedEvent: {}, state: "processed", processedAt: new Date() });
    await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: f.endpointId,
      conversationId: other.conversationId, deliveryId, commentId: other.commentId,
      providerMessageId: other.commentId, direction: "inbound" });
  });
  afterAll(async () => {
    try { await db?.$client.end({ timeout: 1 }); }
    finally { await temporary?.cleanup(); }
  });

  it("gives every run the outcome of a separate read, including each denial", async () => {
    const authorized = { conversationId: f.conversationId, endpointId: f.endpointId };
    const runs = [
      run(),
      run({ context: { wakeCommentIds: [f.commentId, f.commentId] } }),
      run({ context: { wakeCommentIds: [f.commentId, randomUUID()] } }),
      run({ context: { wakeCommentIds: [] } }),
      run({ context: { paperclipHarnessCheckedOut: false } }),
      run({ context: { paperclipHarnessCheckedOut: false, paperclipExternalChatExecutionBound: true } }),
      run({ context: { source: "chat:discord" } }),
      run({ context: { source: "not-a-chat" } }),
      run({ binding: { agentId: randomUUID() } }),
      run({ binding: { issueId: f.otherIssueId } }),
      // The comment of one run never authorizes another run's issue.
      run({ context: { wakeCommentIds: [other.commentId] } }),
      run({ context: { wakeCommentIds: [f.commentId, other.commentId] } }),
      // The other person has no identity link and the endpoint does not
      // allow unlinked people.
      otherRun(),
    ];
    const outcomes = await expectSameOutcomes(runs);
    expect(outcomes).toEqual([authorized, authorized, null, null, null, authorized,
      null, null, null, null, null, null, null]);
    expect(await expectSameOutcomes([])).toEqual([]);
  });

  it("does not share a principal decision between the people of different runs", async () => {
    await db.insert(chatIdentityLinks).values({ companyId: f.companyId, endpointId: f.endpointId,
      principalId: other.principalId, paperclipUserId: "other-user", status: "linked" });
    const otherAuthorized = { conversationId: other.conversationId, endpointId: f.endpointId };
    try {
      // No membership yet: the first person is authorized and the second is not.
      expect(await expectSameOutcomes([run(), otherRun(), run()]))
        .toEqual([{ conversationId: f.conversationId, endpointId: f.endpointId }, null,
          { conversationId: f.conversationId, endpointId: f.endpointId }]);
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user",
        principalId: "other-user", status: "active", membershipRole: "viewer" });
      expect((await expectSameOutcomes([otherRun(), run()]))[0]).toBeNull();
      await db.update(companyMemberships).set({ membershipRole: "member" })
        .where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, "other-user")));
      expect(await expectSameOutcomes([otherRun(), run()]))
        .toEqual([otherAuthorized, { conversationId: f.conversationId, endpointId: f.endpointId }]);
      await db.update(chatIdentityLinks).set({ status: "revoked" })
        .where(eq(chatIdentityLinks.principalId, f.principalId));
      expect(await expectSameOutcomes([run(), otherRun()])).toEqual([null, otherAuthorized]);
    } finally {
      await db.update(chatIdentityLinks).set({ status: "linked" }).where(eq(chatIdentityLinks.principalId, f.principalId));
      await db.delete(chatIdentityLinks).where(eq(chatIdentityLinks.principalId, other.principalId));
      await db.delete(companyMemberships).where(eq(companyMemberships.principalId, "other-user"));
    }
  });

  it("applies current destination, endpoint and delivery policy to every run", async () => {
    const both = () => [run(), otherRun()];
    const restore = async () => {
      await db.update(chatEndpointResources).set({ enabled: true, availability: "available" })
        .where(eq(chatEndpointResources.id, f.resourceId));
      await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, f.endpointId));
      await db.update(chatConversations).set({ state: "active" }).where(eq(chatConversations.id, f.conversationId));
      await db.update(chatDeliveries).set({ state: "processed" }).where(eq(chatDeliveries.id, f.deliveryId));
    };
    try {
      await db.update(chatEndpointResources).set({ enabled: false }).where(eq(chatEndpointResources.id, f.resourceId));
      expect(await expectSameOutcomes(both())).toEqual([null, null]);
      await restore();
      await db.update(chatEndpointResources).set({ availability: "unavailable" }).where(eq(chatEndpointResources.id, f.resourceId));
      expect(await expectSameOutcomes(both())).toEqual([null, null]);
      await restore();
      await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.endpointId));
      expect(await expectSameOutcomes(both())).toEqual([null, null]);
      await restore();
      await db.update(chatConversations).set({ state: "completed" }).where(eq(chatConversations.id, f.conversationId));
      expect((await expectSameOutcomes(both()))[0]).toBeNull();
      await restore();
      await db.update(chatDeliveries).set({ state: "failed" }).where(eq(chatDeliveries.id, f.deliveryId));
      expect((await expectSameOutcomes(both()))[0]).toBeNull();
      await restore();
      // A delivery without a person is never authorized.
      await db.update(chatDeliveries).set({ principalId: null }).where(eq(chatDeliveries.id, f.deliveryId));
      expect((await expectSameOutcomes(both()))[0]).toBeNull();
      await db.update(chatDeliveries).set({ principalId: f.principalId }).where(eq(chatDeliveries.id, f.deliveryId));
      // A verifying endpoint authorizes only deliveries from its current test.
      await db.update(chatEndpoints).set({ status: "verifying", setup: sql`${JSON.stringify({ step: "test",
        testStartedAt: new Date(Date.now() - 60_000).toISOString(), runtimeGeneration: 3 })}::jsonb` })
        .where(eq(chatEndpoints.id, f.endpointId));
      expect(await expectSameOutcomes(both())).toEqual([null, null]);
    } finally {
      await db.update(chatEndpoints).set({ setup: sql`'{}'::jsonb` }).where(eq(chatEndpoints.id, f.endpointId));
      await restore();
    }
  });

  it("throws the errors that a separate read throws", async () => {
    const invalid = run({ context: { wakeCommentIds: ["not-a-uuid"] } });
    await expect(single(invalid)).rejects.toThrow();
    await expect(authorizeChatConversationsForBoundRuns(db, f.companyId, [run(), invalid])).rejects.toThrow();
    await expect(authorizeChatConversationsForBoundRuns(db, randomUUID(), [run()]))
      .rejects.toThrow("paperclip_runner_chat_authorization_batch_company_mismatch");
  });

  it("reads the messages of all runs with one statement", async () => {
    const statements: string[] = [];
    const counting = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((table: Parameters<typeof from>[0]) => {
          statements.push((table as unknown as Record<symbol, string>)[Symbol.for("drizzle:Name")]);
          return from(table);
        }) as typeof builder.from;
        return builder;
      };
    } }) as Db;
    await db.insert(chatIdentityLinks).values({ companyId: f.companyId, endpointId: f.endpointId,
      principalId: other.principalId, paperclipUserId: f.userId, status: "linked" });
    try {
      const runs = [run(), otherRun(), run(), otherRun(), run()];
      const outcomes = await authorizeChatConversationsForBoundRuns(counting, f.companyId, runs);
      expect(outcomes.every(outcome => outcome !== null)).toBe(true);
      // One message read; one resource read; per person a principal, link
      // and membership read.
      expect(statements.filter(name => name === "chat_message_links")).toHaveLength(1);
      expect(statements.filter(name => name === "chat_endpoint_resources")).toHaveLength(1);
      expect(statements.filter(name => name === "chat_external_principals")).toHaveLength(2);
    } finally {
      await db.delete(chatIdentityLinks).where(eq(chatIdentityLinks.principalId, other.principalId));
    }
  });
});
