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

import { authorizationService } from "../../authorization.js";

import {
  authUsers,
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

import { logActivity } from "../../activity-log.js";

import { resolveSlackEmail } from "../slack/directory.js";

import type {
  Author,
  Thread,
} from "chat";
import { canonicalProviderResourceId, chatSurfaceKind, providerResourceLabelFromThread, providerResourceType, nonDirectDestinationAllowed } from "./surfaces.js";
type ResourceRow = typeof chatEndpointResources.$inferSelect;
type InboundAuthorityOptions = {
  voiceStore: Pick<ReturnType<typeof voiceSessionStore>, "authorizePrincipal">;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  fetchImpl?: typeof fetch;
};
/**
 * Whether the acting user (or endpoint sponsor) holds permission to direct/assign
 * the endpoint's assigned agent. Unsponsored self-hosted endpoints without an
 * acting user stay open by design.
 */
export async function principalMayDirectAssignedAgent(
  executor: DbOrTransaction,
  endpoint: { companyId: string; assignedAgentId: string; sponsorUserId?: string | null },
  userId?: string | null,
): Promise<boolean> {
  const actingUserId = userId ?? endpoint.sponsorUserId;
  // Unsponsored endpoints (e.g. self-hosted local boards without user binding) stay open.
  if (!actingUserId) return true;
  const decision = await authorizationService(executor).decide({
    // Evaluate company-scoped membership grants without instance-admin bypass.
    actor: { type: "board", userId: actingUserId, source: "session", ignoreInstanceAdmin: true },
    action: "tasks:assign",
    resource: {
      type: "issue",
      companyId: endpoint.companyId,
      issueId: null,
      projectId: null,
      parentIssueId: null,
      assigneeAgentId: endpoint.assignedAgentId,
      assigneeUserId: null,
    },
    scope: { assigneeAgentId: endpoint.assignedAgentId },
  });
  return decision.allowed;
}

export function createChatInboundAuthority(db: Db, options: InboundAuthorityOptions) {
  const { voiceStore, runtimeCallbackEndpoint, fetchImpl } = options;


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
    options: { linkByEmail?: boolean } = {},
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
    const readLink = () => db
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
    let link = await readLink();
    // A never-linked Slack person may be linked by their verified email. Any
    // existing row (pending, linked, or revoked) keeps its current meaning.
    // Only inbound messages opt in; setup, reactions, callbacks, and commands do not.
    if (options.linkByEmail && !link && endpoint.provider === "slack" && principal.kind === "user" && !principal.isBot) {
      if (await linkSlackPrincipalByEmail(endpoint, principal.id, externalId)) link = await readLink();
    }
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
    // A manager disconnected this identity. Revocation is an explicit deny and
    // must not fall back to guest access.
    if (link?.status === "revoked") {
      return { principal, userId: null, linkedDenied: true };
    }
    return { principal, userId: null, linkedDenied: false };
  }

  /** Returns whether a link row may now exist for this principal. */
  async function linkSlackPrincipalByEmail(endpoint: EndpointRow, principalId: string, slackUserId: string): Promise<boolean> {
    if (!endpoint.providerAccountId) return false;
    // Resolve over the network before taking any lock.
    const email = await resolveSlackEmail({ workspaceId: endpoint.providerAccountId, slackUserId, fetchImpl });
    if (!email) return false;
    // user.email is not unique; an ambiguous address must never pick an account.
    const users = await db.select({ id: authUsers.id, emailVerified: authUsers.emailVerified }).from(authUsers)
      .where(sql`lower(${authUsers.email}) = ${email}`).limit(2);
    if (users.length !== 1 || !users[0].emailVerified) return false;
    const userId = users[0].id;
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${endpoint.companyId}:${principalId}`}, 0))`);
      const membership = await tx.select({ status: companyMemberships.status, membershipRole: companyMemberships.membershipRole })
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, endpoint.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId)))
        .for("update").then((rows) => rows[0] ?? null);
      if (membership?.status !== "active" || membership.membershipRole === "viewer") return false;
      const conflictingLink = await tx.select({ id: chatIdentityLinks.id }).from(chatIdentityLinks)
        .where(and(eq(chatIdentityLinks.companyId, endpoint.companyId), eq(chatIdentityLinks.principalId, principalId),
          eq(chatIdentityLinks.status, "linked"), ne(chatIdentityLinks.paperclipUserId, userId)))
        .limit(1).then((rows) => rows[0] ?? null);
      if (conflictingLink) return false;
      // Never overwrite a row written since the unlocked read (revoked, pending, or linked).
      const inserted = await tx.insert(chatIdentityLinks).values({ companyId: endpoint.companyId, endpointId: endpoint.id, principalId,
        paperclipUserId: userId, status: "linked", confirmedAt: new Date() })
        .onConflictDoNothing({ target: [chatIdentityLinks.endpointId, chatIdentityLinks.principalId] })
        .returning({ id: chatIdentityLinks.id });
      // A concurrently written row exists; the caller re-reads it as-is.
      if (!inserted.length) return true;
      await logActivity(tx as unknown as Db, {
        companyId: endpoint.companyId, actorType: "system", actorId: `chat:${principalId}`,
        action: "chat.slack_identity_email_linked", entityType: "chat_endpoint", entityId: endpoint.id,
        details: { principalId, paperclipUserId: userId },
      });
      return true;
    });
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
    async function gateProviderAuthority(
      result: {
        allowed: boolean;
        linkedDenied: boolean;
        userId: string | null;
        sponsorUserId?: string | null;
      },
    ): Promise<{
      allowed: boolean;
      linkedDenied: boolean;
      userId: string | null;
      sponsorUserId?: string | null;
    }> {
      if (!result.allowed) return result;
      const actor = result.userId ?? result.sponsorUserId ?? endpoint.sponsorUserId;
      const allowed = await principalMayDirectAssignedAgent(tx, endpoint, actor);
      if (!allowed) {
        return { ...result, allowed: false, linkedDenied: true, userId: null, sponsorUserId: null };
      }
      return result;
    }

    if (endpoint.provider === "speko") {
      const principal = await tx.select({ externalId: chatExternalPrincipals.externalId }).from(chatExternalPrincipals)
        .where(and(eq(chatExternalPrincipals.id, principalId), eq(chatExternalPrincipals.companyId, endpoint.companyId), eq(chatExternalPrincipals.provider, "speko"))).then((rows) => rows[0]);
      if (!principal) return { allowed: false, linkedDenied: true, userId: null };
      try {
        const voiceAccess = await voiceStore.authorizePrincipal(
          tx as import("../../voice/voice-session-store.js").VoiceTransaction,
          endpoint.companyId,
          endpoint.id,
          principal.externalId,
        );
        return await gateProviderAuthority(voiceAccess);
      } catch (error) {
        if (!(error instanceof HttpError && [403, 404].includes(error.status))) throw error;
        return { allowed: false, linkedDenied: true, userId: null };
      }
    }
    const githubAccess = await githubChatPrincipalAccess(tx, endpoint, principalId);
    if (githubAccess) return await gateProviderAuthority(githubAccess);
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
      // Concurrent permission grant mutations are not serialized (pre-existing product-wide pattern);
      // membership and link locks serialize link confirmation, revocation, and company departure.
      const allowed =
        membership?.status === "active" &&
        membership.membershipRole !== "viewer";
      if (allowed && !(await principalMayDirectAssignedAgent(tx, endpoint, link.userId))) {
        return { allowed: false, linkedDenied: true, userId: null };
      }
      return {
        allowed,
        linkedDenied: !allowed,
        userId: allowed ? link.userId : null,
      };
    }
    if (link?.status === "revoked") {
      return { allowed: false, linkedDenied: true, userId: null };
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
    const allowed =
      sponsorMembership?.status === "active" &&
      sponsorMembership.membershipRole !== "viewer";
    if (allowed && !(await principalMayDirectAssignedAgent(tx, endpoint, null))) {
      return { allowed: false, linkedDenied: true, userId: null, sponsorUserId: null };
    }
    return {
      allowed,
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
