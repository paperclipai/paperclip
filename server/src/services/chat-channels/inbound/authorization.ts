import type { EndpointRow, DbTransaction, DbOrTransaction, LifecycleRuntimeFence } from "../runtime-types.js";

import {
  stableExternalPrincipalId,
} from "../message-lifecycle.js";

import { voiceSessionStore } from "../../voice/voice-session-store.js";

import { githubChatPrincipalAccess } from "../../chat-github-access.js";

import {
  and,
  eq,
  inArray,
  ne,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatConversations,
  chatEndpointResources,
  chatExternalPrincipals,
  chatIdentityLinks,
  companyMemberships,
} from "@paperclipai/db";

import {
  HttpError,
  forbidden,
} from "../../../errors.js";

import type {
  Author,
  Thread,
} from "chat";
import { canonicalProviderResourceId, chatSurfaceKind, providerResourceLabelFromThread, providerResourceType, nonDirectDestinationAllowed } from "./surfaces.js";
type ResourceRow = typeof chatEndpointResources.$inferSelect;
type InboundAuthorityOptions = {
  voiceStore: Pick<ReturnType<typeof voiceSessionStore>, "authorizePrincipal">;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
};
export function createChatInboundAuthority(db: Db, options: InboundAuthorityOptions) {
  const { voiceStore, runtimeCallbackEndpoint } = options;


  async function findAuthorizedIdentityLink(endpoint: EndpointRow, userId: string) {
    return db.select({ id: chatIdentityLinks.id }).from(chatIdentityLinks)
      .innerJoin(companyMemberships, and(
        eq(companyMemberships.companyId, chatIdentityLinks.companyId), eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"), ne(companyMemberships.membershipRole, "viewer"),
      ))
      .where(and(eq(chatIdentityLinks.companyId, endpoint.companyId), eq(chatIdentityLinks.endpointId, endpoint.id),
        eq(chatIdentityLinks.paperclipUserId, userId), eq(chatIdentityLinks.status, "linked")))
      .limit(1).then((rows) => rows[0] ?? null);
  }

  async function ensurePrincipal(
    endpoint: EndpointRow,
    author: Author,
    raw?: unknown,
  ) {
    const providerAccountId = endpoint.providerAccountId ?? "unknown";
    const externalId = stableExternalPrincipalId(
      endpoint.provider,
      author,
      raw,
    );
    const [principal] = await db
      .insert(chatExternalPrincipals)
      .values({
        companyId: endpoint.companyId,
        provider: endpoint.provider,
        providerAccountId,
        externalId,
        kind:
          author.isBot === true ? "bot" : author.isSystem ? "system" : "user",
        displayName: author.fullName,
        handle: author.userName,
        isBot: author.isBot === true || author.isMe,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          chatExternalPrincipals.companyId,
          chatExternalPrincipals.provider,
          chatExternalPrincipals.providerAccountId,
          chatExternalPrincipals.externalId,
        ],
        set: {
          displayName: author.fullName,
          handle: author.userName,
          isBot: author.isBot === true || author.isMe,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
    if (endpoint.provider === "speko") {
      try {
        const authorization = await db.transaction((tx) => voiceStore.authorizePrincipal(tx, endpoint.companyId, endpoint.id, externalId));
        return { principal, userId: authorization.userId, linkedDenied: false };
      } catch (error) {
        if (!(error instanceof HttpError && [403, 404].includes(error.status))) throw error;
        return { principal, userId: null, linkedDenied: true };
      }
    }
    const link = await db
      .select({
        userId: chatIdentityLinks.paperclipUserId,
        status: chatIdentityLinks.status,
      })
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.endpointId, endpoint.id),
          eq(chatIdentityLinks.principalId, principal.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (link?.status === "linked" && link.userId) {
      const membership = await db
        .select({
          status: companyMemberships.status,
          membershipRole: companyMemberships.membershipRole,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, endpoint.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, link.userId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      // External chat performs the same task mutations as the board. A linked
      // viewer therefore remains read-only instead of gaining write authority
      // merely by using a provider account.
      if (
        membership?.status !== "active" ||
        membership.membershipRole === "viewer"
      ) {
        return { principal, userId: null, linkedDenied: true };
      }
      return { principal, userId: link.userId, linkedDenied: false };
    }
    return { principal, userId: null, linkedDenied: false };
  }

  async function sponsorAllowsGuest(endpoint: EndpointRow): Promise<boolean> {
    // A null sponsor is the local board/operator context used by self-hosted
    // instances. Cloud endpoints retain the creating user and must revalidate
    // that user's current company authority on every sponsored guest turn.
    if (!endpoint.sponsorUserId) return true;
    const membership = await db
      .select({
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, endpoint.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, endpoint.sponsorUserId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return (
      membership?.status === "active" && membership.membershipRole !== "viewer"
    );
  }

  async function lockCurrentPrincipalAuthorization(
    tx: DbOrTransaction,
    endpoint: EndpointRow,
    principalId: string,
  ): Promise<{
    allowed: boolean;
    linkedDenied: boolean;
    userId: string | null;
    sponsorUserId?: string | null;
  }> {
    if (endpoint.provider === "speko") {
      const principal = await tx.select({ externalId: chatExternalPrincipals.externalId }).from(chatExternalPrincipals)
        .where(and(eq(chatExternalPrincipals.id, principalId), eq(chatExternalPrincipals.companyId, endpoint.companyId), eq(chatExternalPrincipals.provider, "speko"))).then((rows) => rows[0]);
      if (!principal) return { allowed: false, linkedDenied: true, userId: null };
      try { return await voiceStore.authorizePrincipal(tx as import("../../voice/voice-session-store.js").VoiceTransaction, endpoint.companyId, endpoint.id, principal.externalId); }
      catch (error) {
        if (!(error instanceof HttpError && [403, 404].includes(error.status))) throw error;
        return { allowed: false, linkedDenied: true, userId: null };
      }
    }
    const githubAccess = await githubChatPrincipalAccess(tx, endpoint, principalId);
    if (githubAccess) return githubAccess;
    // Link confirmation already uses this transaction-scoped identity key.
    // Taking it at the final task mutation boundary prevents a newly confirmed
    // identity from racing the authorization snapshot. Row locks below also
    // serialize revocation and membership changes that do not use this key.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${endpoint.companyId}:${principalId}`}, 0))`,
    );
    const link = await tx
      .select({
        status: chatIdentityLinks.status,
        userId: chatIdentityLinks.paperclipUserId,
      })
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.companyId, endpoint.companyId),
          eq(chatIdentityLinks.endpointId, endpoint.id),
          eq(chatIdentityLinks.principalId, principalId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (link?.status === "linked") {
      if (!link.userId) {
        return { allowed: false, linkedDenied: true, userId: null };
      }
      const membership = await tx
        .select({
          status: companyMemberships.status,
          membershipRole: companyMemberships.membershipRole,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, endpoint.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, link.userId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const allowed =
        membership?.status === "active" &&
        membership.membershipRole !== "viewer";
      return {
        allowed,
        linkedDenied: !allowed,
        userId: allowed ? link.userId : null,
      };
    }
    if (!endpoint.allowUnlinkedPeople) {
      return { allowed: false, linkedDenied: false, userId: null };
    }
    if (!endpoint.sponsorUserId) {
      return { allowed: true, linkedDenied: false, userId: null };
    }
    const sponsorMembership = await tx
      .select({
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, endpoint.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, endpoint.sponsorUserId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    return {
      allowed:
        sponsorMembership?.status === "active" &&
        sponsorMembership.membershipRole !== "viewer",
      linkedDenied: false,
      userId: null,
    };
  }

  async function requireCurrentExternalActionAuthorization(
    tx: DbTransaction,
    input: {
      conversationId: string;
      endpointId: string;
      expectedUserId: string;
      principalId: string;
      runtimeContext: LifecycleRuntimeFence;
    },
  ): Promise<void> {
    const endpoint = await runtimeCallbackEndpoint(
      tx,
      input.endpointId,
      input.runtimeContext,
      ["active", "verifying"],
    );
    // Photon setup already admits linked senders and publishes agent prompts.
    // Let those prompts resolve so a clarifying question cannot deadlock the
    // actual-reply qualification. Other providers retain their active-only gate.
    if (!endpoint || (endpoint.status !== "active" &&
      (endpoint.provider !== "imessage-photon" || endpoint.setup.step !== "test"))) {
      throw forbidden("This chat action is no longer authorized", {
        code: "chat_action_authorization_changed",
      });
    }
    const conversation = await tx
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, endpoint.companyId),
          eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.id, input.conversationId),
          inArray(chatConversations.state, ["active", "waiting"]),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!conversation) {
      throw forbidden("This chat action is no longer authorized", {
        code: "chat_action_authorization_changed",
      });
    }
    const resource = conversation.resourceId
      ? await tx
          .select()
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.companyId, endpoint.companyId),
              eq(chatEndpointResources.endpointId, endpoint.id),
              eq(chatEndpointResources.id, conversation.resourceId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null)
      : null;
    const destinationAllowed = conversation.isDirectMessage
      ? endpoint.allowDirectMessages
      : nonDirectDestinationAllowed(endpoint, resource);
    const authorization = await lockCurrentPrincipalAuthorization(
      tx,
      endpoint,
      input.principalId,
    );
    // Governed actions never fall back to sponsored-guest authority. If the
    // provider identity was relinked while this callback waited, reject this
    // stale actor snapshot and let a fresh callback use the new identity.
    if (
      !destinationAllowed ||
      !authorization.allowed ||
      authorization.userId !== input.expectedUserId
    ) {
      throw forbidden("This chat action is no longer authorized", {
        code: "chat_action_authorization_changed",
      });
    }
  }

  function isExternalActionAuthorizationChange(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const value = error as { details?: unknown };
    return (
      Boolean(value.details) &&
      typeof value.details === "object" &&
      (value.details as { code?: unknown }).code ===
        "chat_action_authorization_changed"
    );
  }

  async function ensureResource(
    endpoint: EndpointRow,
    thread: Thread,
    enabledBySetupActivation: boolean,
    database: DbOrTransaction = db,
  ) {
    const type = providerResourceType(
      endpoint.provider,
      chatSurfaceKind(endpoint.provider, thread),
    );
    const providerResourceId = canonicalProviderResourceId(
      endpoint.provider,
      thread,
    );
    const resourceLabel = providerResourceLabelFromThread(
      endpoint.provider,
      thread,
    );
    const [resource] = await database
      .insert(chatEndpointResources)
      .values({
        companyId: endpoint.companyId,
        endpointId: endpoint.id,
        type,
        providerResourceId,
        label: resourceLabel.label,
        availability: "available",
        // Slack can deliver the invitation's app_mention before the membership
        // callback. Give either arrival order the same new-channel default.
        enabled:
          thread.isDM ||
          enabledBySetupActivation ||
          (endpoint.provider === "slack" && type === "channel"),
      })
      .onConflictDoUpdate({
        target: [
          chatEndpointResources.endpointId,
          chatEndpointResources.type,
          chatEndpointResources.providerResourceId,
        ],
        set: {
          // Provider inventory and membership lifecycle own availability.
          // A delayed message must not resurrect a destination after the bot
          // was removed or an installation lost access.
          // Slack callbacks are not guaranteed to carry a channel name. Keep
          // an inventory- or conversations.info-derived label instead of
          // downgrading it to C… / slack:C… when a delayed message arrives.
          ...(resourceLabel.fallback
            ? {}
            : {
                label: sql<string>`case
                  when ${chatEndpointResources.availability} = 'available' then ${resourceLabel.label}
                  else ${chatEndpointResources.label}
                end`,
              }),
          updatedAt: new Date(),
        },
      })
      .returning();
    return resource;
  }
  return { findAuthorizedIdentityLink, ensurePrincipal, sponsorAllowsGuest, lockCurrentPrincipalAuthorization, requireCurrentExternalActionAuthorization, isExternalActionAuthorizationChange, ensureResource };
}
