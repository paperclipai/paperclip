import { notifyChatCompanyAuthorityChange } from "../../chat-run-milestone-notifications.js";
import { chatIdentityLinks, chatExternalPrincipals, companyMemberships, toolConnections, type Db } from "@paperclipai/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { conflict, forbidden, notFound } from "../../../errors.js";
import { slackChatRegistrationService } from "../../chat-slack-registration.js";
import { slackTestMessageService } from "../../connectors/slack/test-message.js";
import type { SlackSetupOptions } from "../../connectors/slack/setup/registration.js";
import { createSlackCallbackVerification } from "./callback-verification.js";
import type { createChatInboundAuthority } from "../inbound/authorization.js";
import type { createChatIdentityLinks } from "../identity-links.js";
import type { createChatCredentials } from "../credentials.js";
import type { createChatConfiguration } from "../configuration.js";
import type { EndpointRecord } from "../runtime-types.js";

type SetupServicesOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  ensurePrincipal: ReturnType<typeof createChatInboundAuthority>["ensurePrincipal"];
  withCredentialMutationLease: Parameters<typeof createChatConfiguration>[1]["withCredentialMutationLease"];
  resolveCredentials: ReturnType<typeof createChatCredentials>["resolveCredentials"];
  resolveCredentialRefs: ReturnType<typeof createChatCredentials>["resolveCredentialRefs"];
  configureWithCredentialLease: ReturnType<typeof createChatConfiguration>["configureWithCredentialLease"];
  createLinkIntent: ReturnType<typeof createChatIdentityLinks>["createLinkIntent"];
  getPublicBaseUrl: () => string | null;
  getWebhookPublicBaseUrl: () => string | null;
  fetchImpl: typeof globalThis.fetch;
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  renderSlackAvatar: Parameters<typeof slackChatRegistrationService>[1]["renderAvatar"];
  slackManaged: Parameters<typeof slackChatRegistrationService>[1]["managed"];
};

export function createSlackSetupServices(db: Db, options: SetupServicesOptions) {
  const { endpointRecord, ensurePrincipal, withCredentialMutationLease, resolveCredentials, resolveCredentialRefs,
    configureWithCredentialLease, createLinkIntent, getPublicBaseUrl, getWebhookPublicBaseUrl, fetchImpl,
    scheduleMessageProcessing, renderSlackAvatar, slackManaged } = options;
  const linkSlackAccount: SlackSetupOptions["linkInstaller"] = async (endpointId, user, actor, lease) => {
    const record = await endpointRecord(endpointId);
    if (!record || record.endpoint.provider !== "slack" || record.endpoint.providerAccountId !== user.team_id) throw conflict("Slack setup changed");
    const { principal } = await ensurePrincipal(record.endpoint, {
      userId: String(user.id), userName: typeof user.name === "string" ? user.name : String(user.id),
      fullName: typeof user.real_name === "string" ? user.real_name : String(user.id), isBot: false, isMe: false,
    });
    await db.transaction(async tx => {
      await lease.assertOwned(tx);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${record.endpoint.companyId}:${principal.id}`}, 0))`);
      const membership = (await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, record.endpoint.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, actor.userId))).for("update"))[0];
      if (membership?.status !== "active" || membership.membershipRole === "viewer") throw forbidden("The signed-in Paperclip account cannot use this connection");
      const links = await tx.select().from(chatIdentityLinks).where(and(eq(chatIdentityLinks.companyId, record.endpoint.companyId), eq(chatIdentityLinks.principalId, principal.id))).for("update");
      if (links.some(link => link.status === "linked" && link.paperclipUserId !== actor.userId) || links.some(link => link.endpointId === endpointId && link.status === "revoked")) throw conflict("This Slack account has an existing link", { code: "chat_identity_link_conflict" });
      if (links.some(link => link.endpointId === endpointId && link.status === "linked")) return;
      await notifyChatCompanyAuthorityChange(tx, { companyId: record.endpoint.companyId });
      await tx.insert(chatIdentityLinks).values({ companyId: record.endpoint.companyId, endpointId, principalId: principal.id,
        paperclipUserId: actor.userId, status: "linked", confirmedAt: new Date() })
        .onConflictDoUpdate({ target: [chatIdentityLinks.endpointId, chatIdentityLinks.principalId], set: {
          paperclipUserId: actor.userId, status: "linked", confirmationTokenHash: null, expiresAt: null, confirmedAt: new Date(), revokedAt: null, updatedAt: new Date(),
        } });
      await lease.assertOwned(tx);
    });
  };

  const slackRegistration = slackChatRegistrationService(db, {
    publicOrigin: getPublicBaseUrl, webhookOrigin: getWebhookPublicBaseUrl, fetch: fetchImpl, renderAvatar: renderSlackAvatar, managed: slackManaged,
    withLock: async (endpointId, work) => {
      const record = await endpointRecord(endpointId);
      if (!record) throw notFound("Chat endpoint not found");
      return withCredentialMutationLease(record.endpoint, work);
    },
    runtimeSigningSecret: async endpointId => {
      const record = await endpointRecord(endpointId);
      if (!record) throw notFound("Chat endpoint not found");
      return (await resolveCredentials(record.endpoint)).signingSecret;
    },
    runtimeBotToken: async endpointId => {
      const record = await endpointRecord(endpointId);
      if (!record) throw notFound("Chat endpoint not found");
      return (await resolveCredentials(record.endpoint)).botToken;
    },
    canWelcome: async (endpointId, account) => {
      const record = await endpointRecord(endpointId);
      if (!record || !["verifying", "active"].includes(record.endpoint.status) || !record.endpoint.allowDirectMessages) return false;
      const [connection] = await db.select({ status: toolConnections.status, enabled: toolConnections.enabled }).from(toolConnections)
        .where(and(eq(toolConnections.id, record.endpoint.connectionId), eq(toolConnections.companyId, record.endpoint.companyId)));
      if (!connection || connection.status !== "active" || !connection.enabled) return false;
      const [link] = await db.select({ id: chatIdentityLinks.id }).from(chatIdentityLinks)
        .innerJoin(chatExternalPrincipals, and(eq(chatExternalPrincipals.id, chatIdentityLinks.principalId), eq(chatExternalPrincipals.companyId, chatIdentityLinks.companyId)))
        .innerJoin(companyMemberships, and(eq(companyMemberships.companyId, chatIdentityLinks.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, account.paperclipUserId), eq(companyMemberships.status, "active"), ne(companyMemberships.membershipRole, "viewer")))
        .where(and(eq(chatIdentityLinks.companyId, record.endpoint.companyId), eq(chatIdentityLinks.endpointId, endpointId), eq(chatIdentityLinks.status, "linked"), eq(chatIdentityLinks.paperclipUserId, account.paperclipUserId), eq(chatExternalPrincipals.externalId, account.externalUserId), eq(chatExternalPrincipals.providerAccountId, record.endpoint.providerAccountId!)));
      return Boolean(link);
    },
    linkInstaller: linkSlackAccount,
    configure: async (endpointId, credentials, actor, lease) => {
      const record = await endpointRecord(endpointId);
      if (!record) throw notFound("Chat endpoint not found");
      return configureWithCredentialLease(endpointId, {
        action: record.endpoint.botExternalId ? "reconnect" : "configure", credentials,
      }, lease, actor.userId);
    },
  });
  const { verifySlackRequestUrl } = createSlackCallbackVerification(db, { resolveCredentialRefs, getWebhookPublicBaseUrl, scheduleMessageProcessing, slackRegistration });

  const sendSlackTestMessage = slackTestMessageService(db, {
    fetch: fetchImpl,
    withLock: async (endpointId, work) => {
      const record = await endpointRecord(endpointId);
      if (!record) throw notFound("Chat endpoint not found");
      return withCredentialMutationLease(record.endpoint, work);
    },
    runtimeBotToken: async endpointId => {
      const record = await endpointRecord(endpointId);
      if (!record) throw notFound("Chat endpoint not found");
      return (await resolveCredentials(record.endpoint)).botToken;
    },
    linkInstaller: linkSlackAccount,
    ensureAccount: async (endpointId, user) => {
      const record = await endpointRecord(endpointId);
      if (!record) throw notFound("Chat endpoint not found");
      const { principal } = await ensurePrincipal(record.endpoint, { userId: String(user.id), userName: String(user.name ?? user.id), fullName: String(user.real_name ?? user.id), isBot: false, isMe: false });
      return principal.id;
    },
    createLinkIntent,
  });
  return { slackRegistration, verifySlackRequestUrl, sendSlackTestMessage };
}
