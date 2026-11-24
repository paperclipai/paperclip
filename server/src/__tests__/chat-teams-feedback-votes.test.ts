import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  feedbackVotes,
  instanceSettings,
  issueComments,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { createChatInboundAuthority } from "../services/chat-channels/inbound/authorization.ts";
import { createTeamsFeedbackVotes } from "../services/chat-channels/microsoft-teams/feedback.ts";
import type { TeamsFeedbackEvent } from "../services/chat-channels/microsoft-teams/feedback-loop.ts";
import type {
  DbOrTransaction,
  EndpointRow,
  RuntimeContext,
} from "../services/chat-channels/runtime-types.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Teams feedback tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const conversationId = "a:synthetic-personal";
const canonicalThreadId = `teams:${Buffer.from(conversationId).toString("base64url")}`;
const routedThreadId = `${canonicalThreadId}:${Buffer.from("https://smba.trafficmanager.net/amer/").toString("base64url")}:personal`;
const linkedAad = "55555555-5555-4555-8555-555555555555";
const guestAad = "66666666-6666-4666-8666-666666666666";
const runtimeContext: RuntimeContext = {
  credentialFingerprint: "fixture",
  generation: 1,
  localEpoch: 1,
  version: "fixture",
};

describeEmbeddedPostgres("Teams native feedback votes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let seed!: Awaited<ReturnType<typeof seedTeamsConversation>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-teams-feedback-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    seed = await seedTeamsConversation();
  });

  async function seedTeamsConversation() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const agentCommentId = randomUUID();
    const userCommentId = randomUUID();
    const endpointId = randomUUID();
    const linkedUserId = `user-${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Helper",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Answer a Teams question",
      status: "todo",
      priority: "medium",
      createdByUserId: linkedUserId,
    });
    await db.insert(issueComments).values([
      { id: agentCommentId, companyId, issueId, authorAgentId: agentId, body: "Agent reply" },
      { id: userCommentId, companyId, issueId, authorUserId: linkedUserId, body: "Board reply" },
    ]);
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Teams", type: "chat" });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "Teams",
      uid: endpointId,
      transport: "chat_sdk",
      connectionPurpose: "channel",
      enabled: true,
      status: "active",
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId,
      provider: "microsoft-teams",
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
      providerAccountId: "fixture-tenant",
      allowDirectMessages: true,
      allowUnlinkedPeople: true,
    });
    const [conversation] = await db
      .insert(chatConversations)
      .values({
        companyId,
        endpointId,
        issueId,
        externalConversationId: conversationId,
        externalThreadId: canonicalThreadId,
        externalLabel: "Direct message",
        isDirectMessage: true,
      })
      .returning();
    await db.insert(chatMessageLinks).values([
      { companyId, endpointId, conversationId: conversation!.id, commentId: agentCommentId, providerMessageId: "agent-reply", direction: "outbound" },
      { companyId, endpointId, conversationId: conversation!.id, commentId: userCommentId, providerMessageId: "board-reply", direction: "outbound" },
      { companyId, endpointId, conversationId: conversation!.id, commentId: null, providerMessageId: "progress-notice", direction: "outbound" },
    ]);
    const [linkedPrincipal, guestPrincipal] = await db
      .insert(chatExternalPrincipals)
      .values([
        { companyId, provider: "microsoft-teams", providerAccountId: "fixture-tenant", externalId: linkedAad, displayName: "Linked" },
        { companyId, provider: "microsoft-teams", providerAccountId: "fixture-tenant", externalId: guestAad, displayName: "Guest" },
      ])
      .returning();
    await db.insert(chatIdentityLinks).values({
      companyId,
      endpointId,
      principalId: linkedPrincipal!.id,
      paperclipUserId: linkedUserId,
      status: "linked",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: linkedUserId,
      status: "active",
      membershipRole: "member",
    });
    return {
      companyId,
      issueId,
      endpointId,
      conversationId: conversation!.id,
      agentCommentId,
      linkedUserId,
      guestPrincipalId: guestPrincipal!.id,
    };
  }

  type PrincipalAuthorization = (
    tx: DbOrTransaction,
    endpoint: EndpointRow,
    principalId: string,
  ) => Promise<{ allowed: boolean; userId: string | null }>;

  function votes(
    wrapAuthorization: (authorize: PrincipalAuthorization) => PrincipalAuthorization = (authorize) => authorize,
  ) {
    const { lockCurrentPrincipalAuthorization } = createChatInboundAuthority(db, {
      voiceStore: {
        authorizePrincipal: async () => {
          throw new Error("Voice authorization is not used by Teams");
        },
      },
      runtimeCallbackEndpoint: async () => null,
    });
    return createTeamsFeedbackVotes(db, {
      lockCurrentPrincipalAuthorization: wrapAuthorization(lockCurrentPrincipalAuthorization),
      runtimeCallbackEndpoint: async (tx, endpointId, _context, statuses) => {
        const [endpoint] = await tx
          .select()
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpointId))
          .for("no key update");
        return endpoint && statuses.includes(endpoint.status) ? endpoint : null;
      },
      runtimeCallbackRecord: async (endpointId) => {
        const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId));
        return endpoint
          ? { endpoint, assignedAgentName: "Helper", connectionName: "Teams", applicationId: "fixture", credentialSecretRefs: [] }
          : null;
      },
    });
  }

  async function submit(
    event: Partial<TeamsFeedbackEvent>,
    wrapAuthorization?: (authorize: PrincipalAuthorization) => PrincipalAuthorization,
  ) {
    return votes(wrapAuthorization).handleTeamsFeedback(
      {
        endpointId: seed.endpointId,
        provider: "microsoft-teams",
        event: {
          activityId: randomUUID(),
          threadId: routedThreadId,
          replyToId: "agent-reply",
          userId: "29:linked",
          aadObjectId: linkedAad.toUpperCase(),
          vote: "up",
          reason: null,
          ...event,
        },
      },
      runtimeContext,
    );
  }

  function savedVotes() {
    return db.select().from(feedbackVotes).where(eq(feedbackVotes.companyId, seed.companyId));
  }

  it("records a linked person's vote on the rated agent comment and updates it in place", async () => {
    await submit({ vote: "up", reason: "Clear answer." });
    await submit({ vote: "down", reason: "Missed the deadline." });

    const rows = await savedVotes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      issueId: seed.issueId,
      targetType: "issue_comment",
      targetId: seed.agentCommentId,
      authorUserId: seed.linkedUserId,
      vote: "down",
      reason: "Missed the deadline.",
      sharedWithLabs: false,
    });
    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, seed.companyId), eq(activityLog.action, "issue.feedback_vote_saved")));
    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({ actorType: "user", actorId: seed.linkedUserId, entityId: seed.issueId });
    expect(activity[0]!.details).toMatchObject({ source: "chat:microsoft-teams", sharingEnabled: false });
    const settings = await db.select().from(instanceSettings);
    expect(settings.map((row) => (row.general as Record<string, unknown>).feedbackDataSharingPreference)).not.toContain(
      "not_allowed",
    );
    const [company] = await db.select().from(companies).where(eq(companies.id, seed.companyId));
    expect(company?.feedbackDataSharingEnabled).toBe(false);
  });

  it("keeps the voter's access locked until the vote and its activity commit", async () => {
    let authorizedTransactionId: string | null = null;
    let downgrade: Promise<unknown> | null = null;
    await submit({ vote: "up", reason: "Clear answer." }, (authorize) => async (tx, endpoint, principalId) => {
      const authorization = await authorize(tx, endpoint, principalId);
      const [current] = await tx.execute<{ id: string }>(
        sql`select (txid_current() % 4294967296)::text as id`,
      );
      authorizedTransactionId = current!.id;
      downgrade = db
        .update(companyMemberships)
        .set({ membershipRole: "viewer" })
        .where(and(eq(companyMemberships.companyId, seed.companyId), eq(companyMemberships.principalId, seed.linkedUserId)))
        .execute();
      downgrade.catch(() => undefined);
      await expect
        .poll(async () => {
          const [row] = await db.execute<{ waiting: boolean }>(sql`select exists (
            select 1 from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and query ilike '%company_memberships%'
          ) as waiting`);
          return row!.waiting;
        }, { timeout: 5_000, interval: 10 })
        .toBe(true);
      return authorization;
    });
    await downgrade;

    expect(authorizedTransactionId).not.toBeNull();
    const [vote] = await db
      .select({ vote: feedbackVotes.vote, writer: sql<string>`${feedbackVotes}.xmin::text` })
      .from(feedbackVotes)
      .where(eq(feedbackVotes.companyId, seed.companyId));
    expect(vote).toEqual({ vote: "up", writer: authorizedTransactionId });
    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, seed.companyId), eq(activityLog.action, "issue.feedback_vote_saved")));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ actorType: "user", actorId: seed.linkedUserId });

    await submit({ vote: "down", reason: "Missed the deadline." });
    const rows = await savedVotes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vote: "up", reason: "Clear answer." });
  });

  it("attributes an admitted unlinked person to their chat principal", async () => {
    await submit({ userId: "29:guest", aadObjectId: guestAad, vote: "down", reason: "Wrong team." });

    const rows = await savedVotes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ authorUserId: `chat:${seed.guestPrincipalId}`, vote: "down", reason: "Wrong team." });
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.companyId, seed.companyId));
    expect(activity).toMatchObject({ actorType: "system", actorId: `chat:${seed.guestPrincipalId}` });
  });

  it("ignores an unlinked person when the endpoint does not admit unlinked people", async () => {
    await db.update(chatEndpoints).set({ allowUnlinkedPeople: false }).where(eq(chatEndpoints.id, seed.endpointId));
    await submit({ userId: "29:guest", aadObjectId: guestAad });
    expect(await savedVotes()).toHaveLength(0);
  });

  it.each([
    ["an unknown person", { userId: "29:stranger", aadObjectId: "77777777-7777-4777-8777-777777777777" }],
    ["a board-authored comment", { replyToId: "board-reply" }],
    ["a progress notice", { replyToId: "progress-notice" }],
    ["an unknown message", { replyToId: "missing" }],
    ["another conversation", { threadId: `teams:${Buffer.from("a:other").toString("base64url")}` }],
  ] as const)("records nothing for %s", async (_name, event) => {
    expect(await submit(event)).toBeUndefined();
    expect(await savedVotes()).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, seed.companyId))).toHaveLength(0);
  });

  async function streamingReply(updatedAt = new Date()) {
    const [publication] = await db
      .insert(chatPublications)
      .values({
        companyId: seed.companyId,
        endpointId: seed.endpointId,
        conversationId: seed.conversationId,
        issueId: seed.issueId,
        commentId: seed.agentCommentId,
        idempotencyKey: `comment:${randomUUID()}`,
        payload: { text: "Agent reply" },
        state: "streaming",
        updatedAt,
      })
      .returning();
    return publication!;
  }

  it("asks Teams to retry a vote on a reply whose message link is still settling", async () => {
    const publication = await streamingReply();
    const event = { activityId: "activity-fresh", replyToId: "fresh-reply", vote: "down" as const };

    expect(await submit(event)).toBe("retry");
    expect(await savedVotes()).toHaveLength(0);
    expect(await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, seed.endpointId))).toHaveLength(0);

    await db.transaction(async (tx) => {
      await tx.update(chatPublications).set({ state: "published", providerMessageId: "fresh-reply" }).where(eq(chatPublications.id, publication.id));
      await tx.insert(chatMessageLinks).values({
        companyId: seed.companyId,
        endpointId: seed.endpointId,
        conversationId: seed.conversationId,
        publicationId: publication.id,
        commentId: seed.agentCommentId,
        providerMessageId: "fresh-reply",
        direction: "outbound",
      });
    });
    expect(await submit(event)).toBeUndefined();
    const rows = await savedVotes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetId: seed.agentCommentId, vote: "down" });
  });

  it("acknowledges an unlinked reply when no recent publication is settling", async () => {
    await streamingReply(new Date(Date.now() - 10 * 60_000));
    expect(await submit({ replyToId: "fresh-reply" })).toBeUndefined();
    expect(await savedVotes()).toHaveLength(0);
  });

  it("ignores a replayed invoke so it cannot overwrite a newer vote", async () => {
    await submit({ activityId: "activity-a", vote: "up", reason: "Clear answer." });
    await submit({ activityId: "activity-b", vote: "down", reason: "Missed the deadline." });
    await submit({ activityId: "activity-a", vote: "up", reason: "Clear answer." });

    const rows = await savedVotes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vote: "down", reason: "Missed the deadline." });
    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, seed.companyId), eq(activityLog.action, "issue.feedback_vote_saved")));
    expect(activity).toHaveLength(2);
    const receipts = await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, seed.endpointId));
    expect(receipts.map((row) => row.providerEventId).sort()).toEqual([
      "teams-feedback:activity-a",
      "teams-feedback:activity-b",
    ]);
    expect(receipts.every((row) => row.state === "processed" && row.eventKind === "action")).toBe(true);
  });
});
