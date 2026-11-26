import { notifyRetentionWork } from "../../retention-work-notifications.js";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, or, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import { authUsers, chatActions, chatEndpoints, chatIdentityLinks, invites, joinRequests } from "@paperclipai/db";

import { conflict, forbidden, unprocessable } from "../../../errors.js";

import { logActivity } from "../../activity-log.js";

type EndpointRow = typeof chatEndpoints.$inferSelect;
type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type ConfirmationRuntime = { credentialFingerprint: string; generation: number };
export type SlackIdentityEffectStager = (database: DbOrTransaction, input: {
  endpoint: EndpointRow; principalId: string; providerActionId: string;
  payload: { version: 1; effect: "ephemeral_message"; authorizationMode: "safe_notice"; threadId: string; userId: string; text: string; settleDelivery: false };
  runtimeContext: ConfirmationRuntime;
}) => Promise<{ id: string } | null>;

type SlackIdentityLinkOptions = {
  previewIdentityLink: (token: string, userId: string) => Promise<{ selfService: boolean; canConfirm: boolean; companyId: string; endpointId: string }>;
  stageProviderEffect: SlackIdentityEffectStager;
};

export function createSlackIdentityLinks(db: Db, { previewIdentityLink, stageProviderEffect }: SlackIdentityLinkOptions) {
  function listConnects(endpoint: EndpointRow) {
    const endpointId = endpoint.id;
    return db
      .select({ principalId: chatActions.principalId, lastConnectAt: sql<string>`max(${chatActions.createdAt})::text` })
      .from(chatActions)
      .where(and(
        eq(chatActions.companyId, endpoint.companyId),
        eq(chatActions.endpointId, endpointId),
        eq(chatActions.kind, "slack_connect"),
        eq(chatActions.status, "processed"),
      ))
      .groupBy(chatActions.principalId);
  }

  async function isSelfService(link: typeof chatIdentityLinks.$inferSelect, tokenHash: string) {
    const selfService = Boolean(await db.select({ id: chatActions.id }).from(chatActions).where(and(
      eq(chatActions.companyId, link.companyId), eq(chatActions.endpointId, link.endpointId),
      eq(chatActions.principalId, link.principalId), eq(chatActions.kind, "slack_connect"),
      sql`${chatActions.payload}->>'identityLinkHash' = ${tokenHash}`,
    )).limit(1).then((rows) => rows[0]));
    return selfService;
  }

  function latestConnect(link: typeof chatIdentityLinks.$inferSelect) {
    return db.select({ payload: chatActions.payload }).from(chatActions).where(and(
      eq(chatActions.endpointId, link.endpointId), eq(chatActions.principalId, link.principalId), eq(chatActions.kind, "slack_connect"),
    )).orderBy(desc(chatActions.createdAt)).limit(1).then((rows) => rows[0]);
  }

  async function stageConfirmation(tx: DbOrTransaction, input: {
    endpoint: EndpointRow; link: typeof chatIdentityLinks.$inferSelect; tokenHash: string;
    channelId: string; userId: string; confirmationRuntime: ConfirmationRuntime;
  }) {
    const { endpoint, link, tokenHash, channelId, userId, confirmationRuntime } = input;
    const effect = await stageProviderEffect(tx, {
      endpoint: endpoint, principalId: link.principalId,
      providerActionId: `provider_effect:identity_linked:${link.id}:${tokenHash}`,
      payload: {
        version: 1, effect: "ephemeral_message", authorizationMode: "safe_notice",
        threadId: channelId, userId: userId,
        text: "Your Slack account is connected to Paperclip. Future messages use your Paperclip permissions.", settleDelivery: false
      },
      runtimeContext: confirmationRuntime,
    });
    if (!effect) throw conflict("The Slack connection changed; try confirming again");
    return effect.id;
  }

  async function requestIdentityAccess(token: string, userId: string, requestIp: string) {
    const preview = await previewIdentityLink(token, userId);
    if (!preview.selfService) throw forbidden("This identity link cannot request access");
    if (preview.canConfirm) return { status: "member" as const };
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chat-join:${preview.companyId}:${userId}`}, 0))`);
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const validLink = await tx.select({ id: chatIdentityLinks.id }).from(chatIdentityLinks).where(and(
        eq(chatIdentityLinks.companyId, preview.companyId), eq(chatIdentityLinks.endpointId, preview.endpointId),
        eq(chatIdentityLinks.confirmationTokenHash, tokenHash), eq(chatIdentityLinks.status, "pending"), gt(chatIdentityLinks.expiresAt, new Date()),
      )).for("update").then((rows) => rows[0]);
      if (!validLink) throw unprocessable("This identity-link request is invalid or expired");
      const user = await tx.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, userId)).then((rows) => rows[0]);
      if (!user) throw forbidden("Sign in to request company access");
      const existing = await tx.select({ id: joinRequests.id }).from(joinRequests).where(and(
        eq(joinRequests.companyId, preview.companyId), eq(joinRequests.requestType, "human"), eq(joinRequests.status, "pending_approval"),
        or(eq(joinRequests.requestingUserId, userId), sql`lower(${joinRequests.requestEmailSnapshot}) = ${user.email.toLowerCase()}`),
      )).then((rows) => rows[0]);
      if (existing) return { status: "pending_approval" as const };
      const now = new Date();
      const [invite] = await tx.insert(invites).values({
        companyId: preview.companyId, tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        inviteType: "company_join", allowedJoinTypes: "human", acceptedAt: now, expiresAt: now,
        defaultsPayload: { human: { role: "operator" }, source: "slack_identity_link" },
      }).returning({ id: invites.id });
      await notifyRetentionWork(tx, "join_request");
      const [request] = await tx.insert(joinRequests).values({
        inviteId: invite.id, companyId: preview.companyId, requestType: "human", status: "pending_approval",
        requestIp, requestingUserId: userId, requestEmailSnapshot: user.email,
      }).returning({ id: joinRequests.id });
      await logActivity(tx as unknown as Db, {
        companyId: preview.companyId, actorType: "user", actorId: userId, action: "join.requested",
        entityType: "join_request", entityId: request.id, details: { requestType: "human", source: "slack_identity_link", endpointId: preview.endpointId },
      });
      return { status: "pending_approval" as const };
    });
  }

  return { listConnects, isSelfService, latestConnect, stageConfirmation, requestIdentityAccess };
}
