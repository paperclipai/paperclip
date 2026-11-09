import { nonDirectDestinationAllowed } from "./surfaces.js";
import { lifecycleRuntimeFence } from "./delivery-ledger.js";
import type { DbTransaction, DbOrTransaction } from "../runtime-types.js";
import { telegramDeliveryHasZeroMessageId } from "../telegram/messages.js";
import { fastResponseTurnQueued } from "../../fast-responses.js";
import { fastResponseRequests } from "@paperclipai/db";
import { canActorReadIssuePrivacy } from "../../authorization.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, chatMessageLinks, issueComments, issues } from "@paperclipai/db";
import { forbidden } from "../../../errors.js";
import { resolveGitHubWakeAuthority, isGitHubAutomaticDelivery } from "../github/wake-authority.js";
import { assertSlackWakeMention } from "../slack/wake-authority.js";
import type { createChatInboundAuthority } from "./authorization.js";
import type { createChatMessageLifecycle } from "./lifecycle.js";
type WakeAuthorityOptions = {
  runtimeCallbackEndpoint: Parameters<typeof createChatMessageLifecycle>[1]["runtimeCallbackEndpoint"];
  lockCurrentPrincipalAuthorization: ReturnType<typeof createChatInboundAuthority>["lockCurrentPrincipalAuthorization"];
};
export function inboundWakeScope(action: typeof chatActions.$inferSelect) {
  return JSON.stringify([
    action.companyId,
    action.endpointId,
    action.conversationId,
    action.deliveryId,
    action.principalId,
    action.kind,
    ...[
      "version",
      "issueId",
      "agentId",
      "commentId",
      "sessionGeneration",
      "requestedByActorType",
      "requestedByActorId",
    ].map((key) => action.payload[key]),
  ]);
}
export function createInboundWakeAuthority(db: Db, options: WakeAuthorityOptions) {
  const { runtimeCallbackEndpoint, lockCurrentPrincipalAuthorization } = options;
  async function authorizeInboundWakeup(
    tx: DbOrTransaction,
    action: typeof chatActions.$inferSelect,
    notice?: { nonblocking: true; terminal: boolean },
  ) {
    const payload = action.payload;
    const deny = () =>
      forbidden(
        "This accepted chat message is no longer authorized to start work",
        { code: "chat_action_authorization_changed" },
      );
    if (
      payload.version !== 1 ||
      typeof payload.issueId !== "string" ||
      typeof payload.agentId !== "string" ||
      typeof payload.commentId !== "string" ||
      !action.conversationId ||
      !action.principalId ||
      !action.deliveryId ||
      !["user", "system"].includes(String(payload.requestedByActorType)) ||
      typeof payload.requestedByActorId !== "string"
    )
      throw deny();
    const issue = await tx
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, action.companyId),
          eq(issues.id, payload.issueId),
        ),
      )
      .for("update", notice ? { noWait: true } : undefined)
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !issue ||
      issue.assigneeAgentId !== payload.agentId ||
      (!notice?.terminal &&
        ["backlog", "done", "cancelled"].includes(issue.status))
    )
      throw deny();
    // The scheduler already owns the issue lock. Do not wait in the opposite
    // order behind an ingress transaction which owns the endpoint first.
    const endpoint = await tx
      .select()
      .from(chatEndpoints)
      .where(
        and(
          eq(chatEndpoints.companyId, action.companyId),
          eq(chatEndpoints.id, action.endpointId),
        ),
      )
      .for("no key update", { noWait: true })
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const delivery = await tx
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.companyId, action.companyId),
          eq(chatDeliveries.id, action.deliveryId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const fence = delivery ? lifecycleRuntimeFence(delivery) : null;
    if (
      !endpoint ||
      endpoint.assignedAgentId !== payload.agentId ||
      !delivery ||
      telegramDeliveryHasZeroMessageId(delivery, endpoint.provider) ||
      delivery.endpointId !== endpoint.id ||
      delivery.conversationId !== action.conversationId ||
      delivery.principalId !== action.principalId ||
      !fence ||
      !(await runtimeCallbackEndpoint(tx as unknown as DbTransaction, endpoint.id, fence, [
        "verifying",
        "active",
      ]))
    )
      throw deny();
    const conversation = await tx
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, action.companyId),
          eq(chatConversations.id, action.conversationId),
        ),
      )
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !conversation ||
      conversation.endpointId !== endpoint.id ||
      conversation.issueId !== issue.id ||
      conversation.sessionGeneration !== payload.sessionGeneration ||
      !["active", "waiting"].includes(conversation.state)
    )
      throw deny();
    const resource = conversation.resourceId
      ? await tx
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.endpointId, endpoint.id),
            eq(chatEndpointResources.id, conversation.resourceId),
          ),
        )
        .for("update")
        .limit(1)
        .then((rows) => rows[0] ?? null)
      : null;
    const authorization = await lockCurrentPrincipalAuthorization(
      tx,
      endpoint,
      action.principalId,
    );
    if (endpoint.provider === "github") {
      const automatic = await resolveGitHubWakeAuthority(tx, endpoint, delivery);
      if (automatic.kind === "denied") throw deny();
      if (automatic.kind === "allowed") authorization.userId = automatic.userId;
    }
    if (!(await canActorReadIssuePrivacy(tx, authorization.userId
      ? { type: "board", userId: authorization.userId }
      : { type: "none" }, issue))) throw deny();
    const expectedUserId =
      payload.requestedByActorType === "user"
        ? payload.requestedByActorId
        : null;
    if (
      !(conversation.isDirectMessage
        ? endpoint.allowDirectMessages
        : nonDirectDestinationAllowed(endpoint, resource)) ||
      !authorization.allowed ||
      authorization.userId !== expectedUserId ||
      (payload.requestedByActorType === "system" &&
        payload.requestedByActorId !== action.principalId)
    )
      throw deny();
    const source = await tx
      .select({
        authorUserId: issueComments.authorUserId,
        deletedAt: issueComments.deletedAt,
      })
      .from(chatMessageLinks)
      .innerJoin(
        issueComments,
        and(
          eq(issueComments.id, chatMessageLinks.commentId),
          eq(issueComments.companyId, action.companyId),
          eq(issueComments.issueId, issue.id),
        ),
      )
      .where(
        and(
          eq(chatMessageLinks.companyId, action.companyId),
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.deliveryId, delivery.id),
          eq(chatMessageLinks.commentId, payload.commentId),
          eq(chatMessageLinks.direction, "inbound"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !source ||
      (source.deletedAt && !notice?.terminal) ||
      source.authorUserId !== expectedUserId
    )
      throw deny();
    return { issue, delivery, endpoint, conversation };
  }

  async function authorizeInboundWorkStart(
    tx: DbOrTransaction,
    action: typeof chatActions.$inferSelect,
  ) {
    const current = await authorizeInboundWakeup(tx, action);
    if (current.endpoint.provider === "slack") assertSlackWakeMention(current.endpoint, current.conversation, current.delivery);
    return current;
  }

  async function authorizeFastResponse(tx: Db, request: typeof fastResponseRequests.$inferSelect) {
    const [action] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, request.companyId), eq(chatActions.deliveryId, request.deliveryId!), eq(chatActions.kind, "inbound_wakeup")));
    if (!action || action.endpointId !== request.endpointId || action.conversationId !== request.conversationId || action.payload.commentId !== request.sourceCommentId || action.payload.agentId !== request.agentId || action.payload.issueId !== request.issueId) throw forbidden();
    const current = await authorizeInboundWorkStart(tx, action);
    const normalized = current.delivery.normalizedEvent as { message?: { text?: string; attachments?: Array<{ name?: string; mimeType?: string }> }; principal?: { isBot?: boolean } };
    if (normalized.principal?.isBot || isGitHubAutomaticDelivery(current.delivery) || current.delivery.state !== "processed") throw forbidden();
    if ((action.payload.requestedByActorType === "user" ? action.payload.requestedByActorId : null) !== request.responsibleUserId) throw forbidden();
    const [agent] = await tx.select({ name: agents.name }).from(agents).where(and(eq(agents.id, request.agentId!), eq(agents.companyId, request.companyId)));
    const [receipt] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, action.id));
    if (receipt && ["skipped", "cancelled", "failed"].includes(receipt.status)) throw forbidden();
    return {
      agentName: agent?.name ?? "Assistant", message: normalized.message?.text ?? "Shared an attachment.", queued: !receipt?.runId || await fastResponseTurnQueued(tx, request),
      attachments: normalized.message?.attachments?.map(a => `${a.name ?? "Attachment"} (${a.mimeType ?? "unknown type"})`)
    };
  }
  return { authorizeInboundWakeup, authorizeInboundWorkStart, authorizeFastResponse };
}
