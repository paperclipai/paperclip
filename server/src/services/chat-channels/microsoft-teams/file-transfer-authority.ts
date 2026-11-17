import type { EndpointRow, DbTransaction, DbOrTransaction, RuntimeContext, LifecycleRuntimeFence } from "../../chat-channels/runtime-types.js";
import { createChatFailedRunRetry, type ChatFailedRetrySource as FailedChatRetrySource } from "../../chat-channels/failed-run-retry.js";

import { type ChatRuntime } from "../../chat-runtime.js";

import {
  createHash,
} from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

import {
  canonicalTeamsThreadId,
} from "../../chat-control-chronology.js";

import type { Db } from "@paperclipai/db";
import {
  createDurableChatWakeupRequest,
} from "../../durable-chat-wakeup.js";
import {
  agentWakeupRequests,
  assets,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  companyMemberships,
  heartbeatRuns,
  issueComments,
  issueAttachments,
  issues,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatEndpointSetupState,
  ToolCredentialSecretRef,
} from "@paperclipai/shared";
import {
  isUuidLike,
} from "@paperclipai/shared";
import {
  isAllowedContentType,
  MAX_ATTACHMENT_BYTES,
} from "../../../attachment-types.js";

import {
  bindTeamsPersonalRecipient,
  parseTeamsPersonalRecipient,
} from "../../chat-teams-personal-recipient.js";
import {
  type TeamsFileTransferAuthority,
} from "../../chat-teams-file-transfers.js";

import {
  HttpError,
  conflict,
} from "../../../errors.js";

import {
  type ChatSdkRuntime,
} from "../../chat-sdk-runtime.js";

import {
  authorizeNativeChatReviewPresentation,
  NativeChatReviewPresentationContentionError,
} from "../../native-runtime/native-chat-review-presentation.js";

type ConversationRow = typeof chatConversations.$inferSelect;
type TeamsFileAuthorityOptions = {
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  credentialFingerprint: (refs: ToolCredentialSecretRef[]) => string;
  runtime: Pick<ChatSdkRuntime | ChatRuntime, "get">;
  runtimeContexts: Pick<WeakMap<object, RuntimeContext>, "get">;
  localRuntimeEpoch: (endpointId: string) => number;
  runtimeVersions: ReadonlyMap<string, string>;
  lockCurrentPrincipalAuthorization: (tx: DbOrTransaction, endpoint: EndpointRow, principalId: string) => Promise<{ allowed: boolean; userId: string | null }>;
  lifecycleRuntimeFence: (delivery: typeof chatDeliveries.$inferSelect) => LifecycleRuntimeFence | null;
  assertFailedRetryReceipt: ReturnType<typeof createChatFailedRunRetry>["assertFailedRetryReceipt"];
  inboundWakeScope: (action: typeof chatActions.$inferSelect) => string;
  failedChatRetrySource: ReturnType<typeof createChatFailedRunRetry>["failedChatRetrySource"];
  isExplicitOperatorPublication: (publication: typeof chatPublications.$inferSelect) => boolean;
  retryCommentIds: ReturnType<typeof createChatFailedRunRetry>["retryCommentIds"];
};

export function createTeamsFileAuthority(options: TeamsFileAuthorityOptions) {
  const { runtimeGeneration, credentialFingerprint, runtime, runtimeContexts, localRuntimeEpoch, runtimeVersions, lockCurrentPrincipalAuthorization, lifecycleRuntimeFence, assertFailedRetryReceipt, inboundWakeScope, failedChatRetrySource, isExplicitOperatorPublication, retryCommentIds } = options;


  // Native Teams file consent is authority for one personal recipient and one
  // immutable file, not authority inferred from the SDK's latest route cache.
  const teamsBoardFileIntentKind = "teams_board_file_intent";
  const teamsFileProofHash = (value: unknown) =>
    createHash("sha256")
      .update(
        JSON.stringify(value, (_key, entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? Object.fromEntries(
                Object.keys(entry)
                  .sort()
                  .map((key) => [key, entry[key]]),
              )
            : entry,
        ),
      )
      .digest("hex");

  async function teamsFileCurrentScope(
    tx: DbTransaction,
    supplied: typeof chatPublications.$inferSelect,
    fence?: LifecycleRuntimeFence,
  ) {
    const [endpoint] = await tx
      .select()
      .from(chatEndpoints)
      .where(
        and(
          eq(chatEndpoints.companyId, supplied.companyId),
          eq(chatEndpoints.id, supplied.endpointId),
        ),
      )
      .for("no key update", { noWait: true });
    if (
      !endpoint ||
      endpoint.provider !== "microsoft-teams" ||
      endpoint.status !== "active" ||
      !endpoint.allowDirectMessages ||
      !isUuidLike(endpoint.providerAccountId) ||
      !isUuidLike(endpoint.botExternalId)
    )
      return null;
    const [connection] = await tx
      .select()
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, endpoint.companyId),
          eq(toolConnections.id, endpoint.connectionId),
        ),
      )
      .for("share", { noWait: true });
    if (!connection?.enabled || connection.status !== "active") return null;
    const currentFence = {
      generation: runtimeGeneration(endpoint.setup),
      credentialFingerprint: credentialFingerprint(
        connection.credentialSecretRefs,
      ),
    };
    const instance = runtime.get(endpoint.id);
    const registration = instance
      ? runtimeContexts.get(instance as object)
      : null;
    if (
      !instance ||
      !registration ||
      registration.generation !== currentFence.generation ||
      registration.credentialFingerprint !==
        currentFence.credentialFingerprint ||
      registration.localEpoch !== localRuntimeEpoch(endpoint.id) ||
      runtimeVersions.get(endpoint.id) !== registration.version ||
      (fence &&
        (fence.generation !== currentFence.generation ||
          fence.credentialFingerprint !== currentFence.credentialFingerprint))
    )
      return null;
    const [conversation] = await tx
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, endpoint.companyId),
          eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.id, supplied.conversationId),
          eq(chatConversations.issueId, supplied.issueId),
        ),
      )
      .for("update", { noWait: true });
    if (
      !conversation?.isDirectMessage ||
      !["active", "waiting"].includes(conversation.state)
    )
      return null;
    const [superseded] = await tx
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, endpoint.companyId),
          eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.externalThreadId, conversation.externalThreadId),
          gt(
            chatConversations.sessionGeneration,
            conversation.sessionGeneration,
          ),
        ),
      )
      .limit(1);
    if (superseded) return null;
    const [issue] = await tx
      .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, endpoint.companyId),
          eq(issues.id, conversation.issueId),
        ),
      )
      .for("share", { noWait: true });
    if (!issue || issue.assigneeAgentId !== endpoint.assignedAgentId)
      return null;
    // The conversation lock serializes rollover. The endpoint lock serializes
    // reach/credential changes; no lock here waits behind inverse Board order.
    if (conversation.resourceId)
      await tx
        .select({ id: chatEndpointResources.id })
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.companyId, endpoint.companyId),
            eq(chatEndpointResources.endpointId, endpoint.id),
            eq(chatEndpointResources.id, conversation.resourceId),
          ),
        )
        .for("update", { noWait: true });
    const [publication] = await tx
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, endpoint.companyId),
          eq(chatPublications.endpointId, endpoint.id),
          eq(chatPublications.conversationId, conversation.id),
          eq(chatPublications.issueId, conversation.issueId),
          eq(chatPublications.id, supplied.id),
        ),
      )
      .for("update", { noWait: true });
    const ids = publication?.payload.attachmentIds;
    if (
      !publication?.commentId ||
      !Array.isArray(ids) ||
      ids.length !== 1 ||
      !isUuidLike(ids[0]) ||
      publication.payload.progressState !== undefined ||
      publication.payload.interactionId ||
      publication.payload.card ||
      publication.idempotencyKey.startsWith("control:") ||
      publication.idempotencyKey.startsWith("wake:")
    )
      return null;
    const [comment] = await tx
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, endpoint.companyId),
          eq(issueComments.issueId, conversation.issueId),
          eq(issueComments.id, publication.commentId),
          isNull(issueComments.deletedAt),
        ),
      )
      .for("share", { noWait: true });
    const [file] = await tx
      .select({ attachment: issueAttachments, asset: assets })
      .from(issueAttachments)
      .innerJoin(
        assets,
        and(
          eq(assets.id, issueAttachments.assetId),
          eq(assets.companyId, endpoint.companyId),
        ),
      )
      .where(
        and(
          eq(issueAttachments.companyId, endpoint.companyId),
          eq(issueAttachments.issueId, conversation.issueId),
          eq(issueAttachments.issueCommentId, publication.commentId),
          eq(issueAttachments.id, ids[0]),
        ),
      )
      .for("share", { noWait: true });
    const filename =
      file?.asset.originalFilename ??
      (file ? `attachment-${file.attachment.id}` : "");
    if (
      !comment ||
      comment.updatedAt.getTime() !== comment.createdAt.getTime() ||
      !file ||
      !Number.isSafeInteger(file.asset.byteSize) ||
      file.asset.byteSize <= 0 ||
      file.asset.byteSize > MAX_ATTACHMENT_BYTES ||
      file.asset.byteSize >= 60 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.asset.sha256) ||
      !file.asset.objectKey.trim() ||
      !isAllowedContentType(file.asset.contentType) ||
      !filename ||
      filename.length > 255 ||
      filename !== filename.trim() ||
      filename.endsWith(".") ||
      /[<>:"/\\|?*\x00-\x1f\x7f]/.test(filename)
    )
      return null;
    const byteIdentity = {
      attachmentId: file.attachment.id,
      assetId: file.asset.id,
      sha256: file.asset.sha256,
      byteSize: file.asset.byteSize,
      filename,
      contentType: file.asset.contentType,
      originatingRunId: file.attachment.originatingRunId,
    };
    return {
      endpoint,
      conversation,
      publication,
      comment,
      file,
      filename,
      currentFence,
      byteIdentity,
      instance,
    };
  }

  async function teamsFilePrincipalAuthorization(
    tx: DbTransaction,
    endpoint: EndpointRow,
    principalId: string,
  ) {
    const identity = await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`chat-identity:${endpoint.companyId}:${principalId}`}, 0)) as locked`,
    );
    if (!identity[0]?.locked)
      throw new NativeChatReviewPresentationContentionError();
    const [link] = await tx
      .select()
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.companyId, endpoint.companyId),
          eq(chatIdentityLinks.endpointId, endpoint.id),
          eq(chatIdentityLinks.principalId, principalId),
        ),
      )
      .for("update", { noWait: true });
    const userId =
      link?.status === "linked" ? link.paperclipUserId : endpoint.sponsorUserId;
    if (userId)
      await tx
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, endpoint.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
          ),
        )
        .for("update", { noWait: true });
    // All rows and the identity advisory key used by the common authorization
    // helper are already held; the helper cannot introduce an inverse wait.
    return lockCurrentPrincipalAuthorization(tx, endpoint, principalId);
  }

  async function teamsFileSourceBinding(
    tx: DbTransaction,
    scope: NonNullable<Awaited<ReturnType<typeof teamsFileCurrentScope>>>,
    actionId: string,
  ) {
    const { endpoint, conversation } = scope;
    const [action] = await tx
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, endpoint.companyId),
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.conversationId, conversation.id),
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "inbound_wakeup"),
          eq(chatActions.status, "processed"),
        ),
      )
      .for("update", { noWait: true });
    if (
      !action?.deliveryId ||
      !action.principalId ||
      action.payload.version !== 1 ||
      action.payload.issueId !== conversation.issueId ||
      action.payload.agentId !== endpoint.assignedAgentId ||
      action.payload.sessionGeneration !== conversation.sessionGeneration ||
      typeof action.payload.commentId !== "string" ||
      !isUuidLike(action.payload.commentId)
    )
      return null;
    const [delivery] = await tx
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.companyId, endpoint.companyId),
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.conversationId, conversation.id),
          eq(chatDeliveries.id, action.deliveryId),
          eq(chatDeliveries.principalId, action.principalId),
          eq(chatDeliveries.state, "processed"),
          inArray(chatDeliveries.eventKind, [
            "direct_message",
            "mention",
            "message",
          ]),
        ),
      )
      .for("update", { noWait: true });
    const originalFence = delivery ? lifecycleRuntimeFence(delivery) : null;
    const [principal] = await tx
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, endpoint.companyId),
          eq(chatExternalPrincipals.id, action.principalId),
          eq(chatExternalPrincipals.provider, "microsoft-teams"),
          eq(
            chatExternalPrincipals.providerAccountId,
            endpoint.providerAccountId!,
          ),
          eq(chatExternalPrincipals.kind, "user"),
          eq(chatExternalPrincipals.isBot, false),
        ),
      )
      .for("share", { noWait: true });
    if (!delivery || !originalFence || !principal) return null;
    const admission = {
      companyId: endpoint.companyId,
      endpointId: endpoint.id,
      runtimeGeneration: originalFence.generation,
      credentialFingerprint: originalFence.credentialFingerprint,
      tenantId: endpoint.providerAccountId!,
      botAppId: endpoint.botExternalId!,
      providerEventId: delivery.providerEventId,
      threadId: conversation.externalThreadId,
      isDirectMessage: true,
    };
    const parsed = parseTeamsPersonalRecipient(
      delivery.normalizedEvent.teamsPersonalRecipient,
      admission,
    );
    const binding = parsed
      ? bindTeamsPersonalRecipient(parsed, {
          admission,
          deliveryId: delivery.id,
          principalId: principal.id,
          conversationId: conversation.id,
          conversationGeneration: conversation.sessionGeneration,
          externalPrincipalId: principal.externalId,
        })
      : null;
    const originalConversation = delivery.normalizedEvent.conversation as
      | Record<string, unknown>
      | undefined;
    const originalMessage = delivery.normalizedEvent.message as
      | Record<string, unknown>
      | undefined;
    const originalPrincipal = delivery.normalizedEvent.principal as
      | Record<string, unknown>
      | undefined;
    if (
      !binding ||
      originalConversation?.isDirectMessage !== true ||
      typeof originalConversation.externalThreadId !== "string" ||
      canonicalTeamsThreadId(originalConversation.externalThreadId) !==
        canonicalTeamsThreadId(conversation.externalThreadId) ||
      originalMessage?.providerMessageId !==
        binding.recipient.providerActivityId ||
      originalPrincipal?.externalId !== principal.externalId
    )
      return null;
    const [source] = await tx
      .select({ comment: issueComments, link: chatMessageLinks })
      .from(chatMessageLinks)
      .innerJoin(
        issueComments,
        and(
          eq(issueComments.id, chatMessageLinks.commentId),
          eq(issueComments.companyId, endpoint.companyId),
          eq(issueComments.issueId, conversation.issueId),
        ),
      )
      .where(
        and(
          eq(chatMessageLinks.companyId, endpoint.companyId),
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.deliveryId, delivery.id),
          eq(chatMessageLinks.commentId, action.payload.commentId),
          eq(chatMessageLinks.direction, "inbound"),
        ),
      )
      .for("share", { noWait: true });
    const expectedUserId =
      action.payload.requestedByActorType === "user"
        ? action.payload.requestedByActorId
        : null;
    if (
      !source ||
      source.link.providerMessageId !== binding.recipient.providerActivityId ||
      source.comment.deletedAt ||
      source.comment.createdAt > scope.comment.createdAt ||
      source.comment.updatedAt.getTime() !==
        source.comment.createdAt.getTime() ||
      source.comment.authorUserId !== expectedUserId ||
      !["user", "system"].includes(
        String(action.payload.requestedByActorType),
      ) ||
      (expectedUserId === null &&
        action.payload.requestedByActorId !== principal.id)
    )
      return null;
    const [lifecycle] = await tx
      .select({ id: chatDeliveries.id })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.companyId, endpoint.companyId),
          eq(chatDeliveries.endpointId, endpoint.id),
          or(
            isNull(chatDeliveries.conversationId),
            eq(chatDeliveries.conversationId, conversation.id),
          ),
          ne(chatDeliveries.state, "filtered"),
          inArray(chatDeliveries.eventKind, [
            "message_updated",
            "message_deleted",
            "message_restored",
          ]),
          sql`${chatDeliveries.normalizedEvent}->'runtimeContext' = ${JSON.stringify(originalFence)}::jsonb`,
          sql`${chatDeliveries.normalizedEvent}->'message'->>'targetProviderEventId' = ${delivery.providerEventId}`,
        ),
      )
      .limit(1);
    if (lifecycle) return null;
    const authorization = await teamsFilePrincipalAuthorization(
      tx,
      endpoint,
      principal.id,
    );
    if (!authorization.allowed || authorization.userId !== expectedUserId)
      return null;
    const [receipt] = await tx
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, endpoint.companyId),
          eq(agentWakeupRequests.id, action.id),
          eq(agentWakeupRequests.agentId, endpoint.assignedAgentId),
        ),
      )
      .for("share", { noWait: true });
    if (!receipt || ["skipped", "cancelled"].includes(receipt.status))
      return null;
    try {
      assertFailedRetryReceipt(
        createDurableChatWakeupRequest({
          id: action.id,
          companyId: endpoint.companyId,
          agentId: endpoint.assignedAgentId,
          issueId: conversation.issueId,
          commentId: source.comment.id,
          requestedByActorType: action.payload.requestedByActorType as
            | "user"
            | "system",
          requestedByActorId: String(action.payload.requestedByActorId),
          requestedAt: action.createdAt,
          authorize: async () => {},
        }),
        receipt,
      );
    } catch (error) {
      if (
        error instanceof HttpError &&
        (error.details as { code?: string } | undefined)?.code ===
          "chat_failed_run_retry_not_authorized"
      )
        return null;
      throw error;
    }
    return {
      binding,
      authorization,
      action,
      sourceFacts: {
        actionId: action.id,
        deliveryId: delivery.id,
        commentId: source.comment.id,
        principalId: principal.id,
        scope: inboundWakeScope(action),
        originalFence,
        bodySha256: createHash("sha256")
          .update(source.comment.body)
          .digest("hex"),
        receiptId: receipt.id,
        recipientBindingSha256: teamsFileProofHash(binding),
      },
    };
  }

  async function teamsBoardOriginBinding(
    tx: DbTransaction,
    scope: NonNullable<Awaited<ReturnType<typeof teamsFileCurrentScope>>>,
  ) {
    // Pick the task's first admitted source, never the latest DM actor. If the
    // durable task contains different recipient principals, consent is ambiguous.
    const principals = await tx
      .selectDistinct({ id: chatActions.principalId })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, scope.endpoint.companyId),
          eq(chatActions.endpointId, scope.endpoint.id),
          eq(chatActions.conversationId, scope.conversation.id),
          eq(chatActions.kind, "inbound_wakeup"),
          eq(chatActions.status, "processed"),
          sql`${chatActions.payload}->>'sessionGeneration' = ${String(scope.conversation.sessionGeneration)}`,
        ),
      )
      .limit(2);
    if (principals.length !== 1 || !principals[0]?.id) return null;
    const [origin] = await tx
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, scope.endpoint.companyId),
          eq(chatActions.endpointId, scope.endpoint.id),
          eq(chatActions.conversationId, scope.conversation.id),
          eq(chatActions.kind, "inbound_wakeup"),
          eq(chatActions.status, "processed"),
          sql`${chatActions.payload}->>'sessionGeneration' = ${String(scope.conversation.sessionGeneration)}`,
        ),
      )
      .orderBy(asc(chatActions.createdAt), asc(chatActions.id))
      .limit(1);
    return origin ? teamsFileSourceBinding(tx, scope, origin.id) : null;
  }

  async function teamsBoardAuthorIsCurrent(
    tx: DbTransaction,
    companyId: string,
    userId: string,
  ) {
    const [membership] = await tx
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      )
      .for("share", { noWait: true });
    return (
      membership?.status === "active" && membership.membershipRole !== "viewer"
    );
  }

  function teamsBoardFileIntentPayload(
    scope: NonNullable<Awaited<ReturnType<typeof teamsFileCurrentScope>>>,
    source: NonNullable<Awaited<ReturnType<typeof teamsFileSourceBinding>>>,
    userId: string,
  ) {
    return {
      schema: "paperclip.teams.board-file-intent.v1",
      publicationId: scope.publication.id,
      issueId: scope.conversation.issueId,
      commentId: scope.comment.id,
      attachmentId: scope.file.attachment.id,
      userId,
      conversationGeneration: scope.conversation.sessionGeneration,
      sourceActionId: source.action.id,
      sourceScopeSha256: teamsFileProofHash(source.sourceFacts),
      recipientBindingSha256: teamsFileProofHash(source.binding),
      byteIdentitySha256: teamsFileProofHash(scope.byteIdentity),
      commentBodySha256: createHash("sha256")
        .update(scope.comment.body)
        .digest("hex"),
    };
  }

  function teamsFileRuntimeStillCurrent(
    scope: NonNullable<Awaited<ReturnType<typeof teamsFileCurrentScope>>>,
  ) {
    const registration = runtimeContexts.get(scope.instance as object);
    return (
      runtime.get(scope.endpoint.id) === scope.instance &&
      registration?.generation === scope.currentFence.generation &&
      registration.credentialFingerprint ===
        scope.currentFence.credentialFingerprint &&
      registration.localEpoch === localRuntimeEpoch(scope.endpoint.id) &&
      runtimeVersions.get(scope.endpoint.id) === registration.version
    );
  }

  async function stageTeamsBoardFileIntent(
    tx: DbTransaction,
    publication: typeof chatPublications.$inferSelect,
    userId: string,
    conversation: ConversationRow,
  ): Promise<void> {
    if (
      !publication.idempotencyKey.startsWith("explicit-board:") ||
      !conversation.isDirectMessage
    )
      return;
    const scope = await teamsFileCurrentScope(tx, publication);
    if (
      !scope ||
      scope.conversation.id !== conversation.id ||
      scope.conversation.sessionGeneration !== conversation.sessionGeneration ||
      scope.comment.authorUserId !== userId ||
      scope.comment.authorAgentId ||
      scope.comment.createdByRunId ||
      !(await teamsBoardAuthorIsCurrent(tx, scope.endpoint.companyId, userId))
    )
      return;
    const source = await teamsBoardOriginBinding(tx, scope);
    if (!source || !teamsFileRuntimeStillCurrent(scope)) return;
    const key = `${teamsBoardFileIntentKind}:${publication.id}`;
    const payload = teamsBoardFileIntentPayload(scope, source, userId);
    const [existing] = await tx
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, scope.endpoint.companyId),
          eq(chatActions.endpointId, scope.endpoint.id),
          eq(chatActions.providerActionId, key),
        ),
      )
      .for("update", { noWait: true });
    if (existing) {
      if (
        existing.kind !== teamsBoardFileIntentKind ||
        existing.status !== "processed" ||
        existing.deliveryId !== source.binding.deliveryId ||
        existing.principalId !== source.binding.principalId ||
        existing.conversationId !== scope.conversation.id ||
        teamsFileProofHash(existing.payload) !== teamsFileProofHash(payload)
      )
        throw conflict("The Teams file recipient intent has changed", {
          code: "chat_file_transfer_authority_changed",
        });
      return;
    }
    await tx.insert(chatActions).values({
      companyId: scope.endpoint.companyId,
      endpointId: scope.endpoint.id,
      conversationId: scope.conversation.id,
      deliveryId: source.binding.deliveryId,
      principalId: source.binding.principalId,
      kind: teamsBoardFileIntentKind,
      providerActionId: key,
      status: "processed",
      payload,
    });
  }

  async function deriveTeamsFileTransferAuthority(
    tx: DbTransaction,
    publication: typeof chatPublications.$inferSelect,
    fence: LifecycleRuntimeFence,
    continuingTeamsFileTransfer?: NonNullable<
      NonNullable<
        Parameters<typeof failedChatRetrySource>[1]["committedResponse"]
      >["continuingTeamsFileTransfer"]
    >,
  ): Promise<TeamsFileTransferAuthority | null> {
    const scope = await teamsFileCurrentScope(tx, publication, fence);
    if (!scope) return null;
    let source: NonNullable<Awaited<ReturnType<typeof teamsFileSourceBinding>>>;
    let causal: Record<string, unknown>;
    if (isExplicitOperatorPublication(scope.publication)) {
      if (
        !scope.publication.idempotencyKey.startsWith("explicit-board:") ||
        !scope.comment.authorUserId ||
        scope.comment.authorAgentId ||
        scope.comment.createdByRunId ||
        !(await teamsBoardAuthorIsCurrent(
          tx,
          scope.endpoint.companyId,
          scope.comment.authorUserId,
        ))
      )
        return null;
      const [intent] = await tx
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.companyId, scope.endpoint.companyId),
            eq(chatActions.endpointId, scope.endpoint.id),
            eq(chatActions.conversationId, scope.conversation.id),
            eq(chatActions.kind, teamsBoardFileIntentKind),
            eq(
              chatActions.providerActionId,
              `${teamsBoardFileIntentKind}:${scope.publication.id}`,
            ),
            eq(chatActions.status, "processed"),
          ),
        )
        .for("share", { noWait: true });
      if (
        !intent ||
        typeof intent.payload.sourceActionId !== "string" ||
        !isUuidLike(intent.payload.sourceActionId)
      )
        return null;
      const bound = await teamsBoardOriginBinding(tx, scope);
      if (
        !bound ||
        bound.action.id !== intent.payload.sourceActionId ||
        intent.deliveryId !== bound.binding.deliveryId ||
        intent.principalId !== bound.binding.principalId
      )
        return null;
      const currentPayload = teamsBoardFileIntentPayload(
        scope,
        bound,
        scope.comment.authorUserId,
      );
      if (
        teamsFileProofHash(intent.payload) !==
        teamsFileProofHash(currentPayload)
      )
        return null;
      source = bound;
      causal = {
        kind: "explicit_board_send",
        intentId: intent.id,
        ...currentPayload,
      };
    } else {
      const runId = scope.comment.createdByRunId;
      if (
        !runId ||
        scope.comment.authorAgentId !== scope.endpoint.assignedAgentId ||
        scope.file.attachment.originatingRunId !== runId
      )
        return null;
      const [run] = await tx
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, scope.endpoint.companyId),
            eq(heartbeatRuns.id, runId),
            eq(heartbeatRuns.agentId, scope.endpoint.assignedAgentId),
            eq(heartbeatRuns.nativeIssueId, scope.conversation.issueId),
            eq(heartbeatRuns.runtimeMode, "native"),
            eq(heartbeatRuns.status, "succeeded"),
            isNotNull(heartbeatRuns.finishedAt),
          ),
        )
        .for("share", { noWait: true });
      const marker = run?.resultJson?.nativeCommittedChatResponse as
        | Record<string, unknown>
        | undefined;
      if (
        !run ||
        !marker ||
        marker.schema !== "paperclip.native_committed_chat_response.v1" ||
        typeof marker.resultId !== "string" ||
        !isUuidLike(marker.resultId) ||
        typeof marker.decisionId !== "string" ||
        !isUuidLike(marker.decisionId) ||
        typeof marker.canonicalSha256 !== "string" ||
        !/^(?:sha256:)?[a-f0-9]{64}$/.test(marker.canonicalSha256)
      )
        return null;
      // Pre-lock the exact causal source and actor rows before the existing
      // complete native publication proof invokes its common authorization.
      const originActions = await tx
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.companyId, scope.endpoint.companyId),
            eq(chatActions.conversationId, scope.conversation.id),
            eq(chatActions.kind, "inbound_wakeup"),
            inArray(
              sql<string>`${chatActions.payload}->>'commentId'`,
              retryCommentIds(run.contextSnapshot ?? {}),
            ),
          ),
        );
      const bindings: Array<
        NonNullable<Awaited<ReturnType<typeof teamsFileSourceBinding>>>
      > = [];
      for (const action of originActions) {
        const binding = await teamsFileSourceBinding(tx, scope, action.id);
        if (!binding) return null;
        bindings.push(binding);
      }
      let proved: FailedChatRetrySource;
      try {
        proved = await failedChatRetrySource(tx, {
          companyId: scope.endpoint.companyId,
          issueId: scope.conversation.issueId,
          agentId: run.agentId,
          failedRunId: run.id,
          publication: true,
          committedResponse: {
            resultId: marker.resultId,
            canonicalSha256: marker.canonicalSha256,
            decisionId: marker.decisionId,
            continuingTeamsFileTransfer,
          },
        });
      } catch (error) {
        if (
          error instanceof HttpError &&
          (error.details as { code?: string } | undefined)?.code ===
            "chat_failed_run_retry_not_authorized"
        )
          return null;
        throw error;
      }
      if (
        proved.provider !== "microsoft-teams" ||
        proved.endpointId !== scope.endpoint.id ||
        proved.conversationId !== scope.conversation.id ||
        proved.sessionGeneration !== scope.conversation.sessionGeneration ||
        bindings.length !== proved.sources.length
      )
        return null;
      const ordered = proved.sources.map((entry) =>
        bindings.find((binding) => binding.action.id === entry.actionId),
      );
      const first = ordered[0];
      if (
        !first ||
        ordered.some(
          (entry) =>
            !entry ||
            entry.binding.principalId !== proved.principalId ||
            entry.binding.recipient.providerConversationId !==
              first.binding.recipient.providerConversationId ||
            entry.binding.recipient.providerUserId !==
              first.binding.recipient.providerUserId ||
            entry.binding.recipient.aadObjectId !==
              first.binding.recipient.aadObjectId,
        )
      )
        return null;
      if (
        run.resultJson?.finalizationReasonCode ===
          "governed_response_waiting" &&
        !(await authorizeNativeChatReviewPresentation(
          tx as unknown as Db,
          {
            companyId: scope.endpoint.companyId,
            issueId: scope.conversation.issueId,
            runId: run.id,
            resultJson: run.resultJson,
            destination: {
              endpointId: scope.endpoint.id,
              conversationId: scope.conversation.id,
            },
          },
          "nonblocking",
        ))
      )
        return null;
      source = first;
      causal = {
        kind: "native_committed_response",
        runId: run.id,
        resultId: marker.resultId,
        canonicalSha256: marker.canonicalSha256,
        decisionId: marker.decisionId,
        sourceScopeSha256: proved.sourceScopeSha256,
        sources: ordered.map((entry) => entry!.sourceFacts),
      };
    }
    // No mutable stage, attempt, receipt, route URL or provider token enters
    // this digest. The next authorization derives these facts afresh.
    const sourceDigest = teamsFileProofHash({
      schema: "paperclip.teams.file-source.v1",
      companyId: scope.endpoint.companyId,
      endpointId: scope.endpoint.id,
      conversationId: scope.conversation.id,
      conversationGeneration: scope.conversation.sessionGeneration,
      issueId: scope.conversation.issueId,
      publicationId: scope.publication.id,
      commentId: scope.comment.id,
      causal,
      byteIdentity: scope.byteIdentity,
    });
    if (!teamsFileRuntimeStillCurrent(scope)) return null;
    return {
      companyId: scope.endpoint.companyId,
      endpointId: scope.endpoint.id,
      conversationId: scope.conversation.id,
      issueId: scope.conversation.issueId,
      publicationId: scope.publication.id,
      commentId: scope.comment.id,
      attachmentId: scope.file.attachment.id,
      principalId: source.binding.principalId,
      authorizedUserId: source.authorization.userId,
      runtimeGeneration: scope.currentFence.generation,
      credentialFingerprint: scope.currentFence.credentialFingerprint,
      conversationGeneration: scope.conversation.sessionGeneration,
      sourceDigest,
      tenantId: source.binding.recipient.tenantId,
      botAppId: source.binding.recipient.botAppId,
      aadObjectId: source.binding.recipient.aadObjectId,
      providerConversationId: source.binding.recipient.providerConversationId,
      providerUserId: source.binding.recipient.providerUserId,
      sha256: scope.file.asset.sha256,
      byteSize: scope.file.asset.byteSize,
      filename: scope.filename,
    };
  }
  return { stageTeamsBoardFileIntent, deriveTeamsFileTransferAuthority };
}
