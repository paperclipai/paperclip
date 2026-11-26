import { publicationTransportOrderKey } from "./order.js";
import { publicationSummary } from "../activity.js";
import { fileTransferProjectionColumns } from "../microsoft-teams/file-transfer-projection.js";
import { notifyChatPublicationWork } from "../../chat-work-notifications.js";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, chatActions, chatConversations, chatPublications, chatTeamsFileTransfers, issueComments, issueAttachments } from "@paperclipai/db";
import type { ChatPublicationBatchStatus } from "@paperclipai/shared";
import { isUuidLike } from "@paperclipai/shared";
import { projectChatFileTransfer, projectChatPublicationBatch } from "../../chat-publication-batches.js";
import { badRequest, HttpError, conflict, notFound } from "../../../errors.js";
import { logActivity } from "../../activity-log.js";
import { issueService } from "../../issues.js";
import { projectSafeChatPublication } from "../../chat-publication-projection.js";
import type { EndpointRecord } from "../runtime-types.js";
import type { createTeamsFileAuthority } from "../microsoft-teams/file-transfer-authority.js";
import type { createChatPublicationQueue } from "./queue.js";
import type { createSlackBoardMessages } from "../slack/board-messages.js";
import type { createTeamsBoardSendPreparation } from "../microsoft-teams/board-send-preparation.js";
import { stageSlackBoardSend } from "../slack/board-send.js";
type RequestOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  stageTeamsBoardFileIntent: ReturnType<typeof createTeamsFileAuthority>["stageTeamsBoardFileIntent"];
  processPendingSlackBoardMessages: ReturnType<typeof createSlackBoardMessages>["processPendingSlackBoardMessages"];
  processPendingPublications: ReturnType<typeof createChatPublicationQueue>["processPendingPublications"];
  prepareTeamsBoardSend: ReturnType<typeof createTeamsBoardSendPreparation>["prepareTeamsBoardSend"];
};
export function createChatPublicationRequests(db: Db, options: RequestOptions) {
  const { endpointRecord, stageTeamsBoardFileIntent, processPendingSlackBoardMessages, processPendingPublications, prepareTeamsBoardSend } = options;
  async function getPublicationBatchStatus(
    endpointId: string,
    conversationId: string,
    publicationId: string,
  ): Promise<ChatPublicationBatchStatus> {
    if (![endpointId, conversationId, publicationId].every(isUuidLike)) {
      throw badRequest(
        "Valid endpoint, conversation, and publication IDs are required",
      );
    }
    const anchor = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.id, publicationId),
          eq(chatPublications.endpointId, endpointId),
          eq(chatPublications.conversationId, conversationId),
        ),
      )
      .then((rows) => rows[0]);
    if (!anchor) throw notFound("Chat publication not found");
    // An explicit Board send and every durable text/file transport part share
    // its comment. Read all parts without Activity's history limit; never
    // advance the worker or replay a provider side effect from this GET.
    // Join public receipts and private transfer facts in one database snapshot.
    // A concurrent consent or file receipt cannot produce a mixed-time batch.
    const batch = await db
      .select({
        publication: chatPublications,
        transfer: fileTransferProjectionColumns,
      })
      .from(chatPublications)
      .leftJoin(
        chatTeamsFileTransfers,
        and(
          eq(chatTeamsFileTransfers.companyId, chatPublications.companyId),
          eq(chatTeamsFileTransfers.endpointId, chatPublications.endpointId),
          eq(
            chatTeamsFileTransfers.conversationId,
            chatPublications.conversationId,
          ),
          eq(chatTeamsFileTransfers.publicationId, chatPublications.id),
        ),
      )
      .where(
        and(
          eq(chatPublications.companyId, anchor.companyId),
          eq(chatPublications.endpointId, endpointId),
          eq(chatPublications.conversationId, conversationId),
          anchor.commentId
            ? eq(chatPublications.commentId, anchor.commentId)
            : eq(chatPublications.id, anchor.id),
        ),
      )
      .orderBy(
        asc(chatPublications.createdAt),
        asc(publicationTransportOrderKey(chatPublications)),
      );
    if (!batch.length) throw notFound("Chat publication not found");
    return projectChatPublicationBatch(
      batch.map(({ publication, transfer }) =>
        projectChatFileTransfer(
          publicationSummary(publication),
          transfer?.publicationId ? transfer : undefined,
        ),
      ),
    );
  }

  async function publishComment(
    endpointId: string,
    conversationId: string,
    commentId: string,
  ) {
    const emailBoundary = await endpointRecord(endpointId);
    if (emailBoundary?.endpoint.publicationMode === "explicit")
      throw badRequest("Use an explicit email send action");
    const conversation = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.id, conversationId),
          eq(chatConversations.endpointId, endpointId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!conversation) throw notFound("Conversation not found");
    const comment = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.id, commentId),
          eq(issueComments.issueId, conversation.issueId),
          isNull(issueComments.deletedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!comment) throw notFound("Task comment not found");
    const [publication] = await db.transaction(async (tx) => {
      await notifyChatPublicationWork(tx);
      return tx
        .insert(chatPublications)
        .values({
          companyId: conversation.companyId,
          endpointId,
          conversationId,
          issueId: conversation.issueId,
          commentId,
          idempotencyKey: `explicit:${commentId}:${endpointId}`,
          payload: projectSafeChatPublication({
            classification: "external",
            source: "explicit_board_send",
            text: comment.body,
          }),
          state: "pending",
        })
        .onConflictDoNothing()
        .returning();
    });
    await processPendingPublications();
    const batch = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, conversation.companyId),
          eq(chatPublications.endpointId, endpointId),
          eq(chatPublications.conversationId, conversationId),
          eq(chatPublications.commentId, commentId),
        ),
      )
      .orderBy(
        asc(chatPublications.createdAt),
        asc(publicationTransportOrderKey(chatPublications)),
      );
    return (
      batch.find((candidate) => candidate.state !== "published") ??
      batch.at(-1) ??
      publication
    );
  }

  async function publishBoardMessage(
    endpointId: string,
    conversationId: string,
    body: string,
    clientIdempotencyKey: string,
    userId: string,
    attachmentIds: string[] = [],
  ) {
    const emailBoundary = await endpointRecord(endpointId);
    if (emailBoundary?.endpoint.publicationMode === "explicit")
      throw badRequest("Use an explicit email send action");
    // Browser request IDs are only unique within the conversation that issued
    // them. Include that durable task boundary so a retried key from another
    // conversation can neither suppress its send nor return the first task's
    // publication.
    const idempotencyKey = `explicit-board:${endpointId}:${conversationId}:${clientIdempotencyKey}`;
    const rejectionActionId = `board-send-rejected:${conversationId}:${clientIdempotencyKey}`;
    const rejectionCode = "chat_board_send_attachments_already_bound";
    const rejectionDetails = (ids: string[]) => ({
      code: rejectionCode,
      endpointId,
      conversationId,
      idempotencyKey: clientIdempotencyKey,
      attachmentIds: ids,
    });
    const validRejectedIds = (value: unknown): value is string[] =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 20 &&
      value.every((id) => typeof id === "string" && isUuidLike(id)) &&
      new Set(value).size === value.length;
    if (attachmentIds.length > 0) { await prepareTeamsBoardSend(endpointId, conversationId, idempotencyKey, rejectionActionId); }
    const publication = await db.transaction(async (tx) => {
      const conversation = await tx
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.id, conversationId),
            eq(chatConversations.endpointId, endpointId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!conversation) throw notFound("Conversation not found");

      const existing = await tx
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, conversation.companyId),
            eq(chatPublications.idempotencyKey, idempotencyKey),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existing) {
        const batch = await tx
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpointId),
              eq(chatPublications.conversationId, conversationId),
              eq(chatPublications.commentId, existing.commentId!),
            ),
          )
          .orderBy(
            asc(chatPublications.createdAt),
            asc(publicationTransportOrderKey(chatPublications)),
          );
        return (
          batch.find((candidate) => candidate.state !== "published") ??
          batch.at(-1) ??
          existing
        );
      }

      const [rejected] = await tx
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.companyId, conversation.companyId),
            eq(chatActions.endpointId, endpointId),
            eq(chatActions.providerActionId, rejectionActionId),
          ),
        )
        .limit(1);
      if (rejected) {
        const payload = rejected.payload;
        if (
          rejected.kind !== "board_send_rejected" ||
          rejected.status !== "processed" ||
          rejected.conversationId !== conversation.id ||
          payload.schemaVersion !== 1 ||
          payload.issueId !== conversation.issueId ||
          payload.idempotencyKey !== clientIdempotencyKey ||
          rejected.result?.code !== rejectionCode ||
          !validRejectedIds(payload.attachmentIds)
        ) {
          throw conflict("Board send rejection receipt is unavailable");
        }
        // The negative receipt is immutable, including when the caller retries
        // with different content or the previous owner comment was deleted.
        return { rejection: rejectionDetails(payload.attachmentIds) };
      }

      let comment: Awaited<
        ReturnType<ReturnType<typeof issueService>["addComment"]>
      >;
      try {
        // addComment inserts before binding attachments. Roll back that insert
        // in a savepoint, then commit only the exact terminal rejection below.
        comment = await tx.transaction((inner) =>
          issueService(inner as unknown as Db).addComment(
            conversation.issueId,
            body,
            { userId },
            { authorType: "user", attachmentIds },
            inner,
          ),
        );
      } catch (error) {
        const details =
          error instanceof HttpError &&
            error.status === 409 &&
            error.details &&
            typeof error.details === "object" &&
            !Array.isArray(error.details)
            ? (error.details as Record<string, unknown>)
            : null;
        if (
          details?.code !== "issue_comment_attachments_already_bound" ||
          details.companyId !== conversation.companyId ||
          details.issueId !== conversation.issueId ||
          !validRejectedIds(details.attachmentIds) ||
          !details.attachmentIds.every((id) => attachmentIds.includes(id))
        )
          throw error;
        const invalidIds = attachmentIds.filter((id) =>
          (details.attachmentIds as string[]).includes(id),
        );
        await tx.insert(chatActions).values({
          companyId: conversation.companyId,
          endpointId,
          conversationId,
          kind: "board_send_rejected",
          providerActionId: rejectionActionId,
          payload: {
            schemaVersion: 1,
            issueId: conversation.issueId,
            requestedByUserId: userId,
            idempotencyKey: clientIdempotencyKey,
            attachmentIds: invalidIds,
          },
          status: "processed",
          result: { code: rejectionCode },
        });
        return { rejection: rejectionDetails(invalidIds) };
      }
      if (emailBoundary?.endpoint.provider === "slack") { return stageSlackBoardSend(tx, { conversation, comment, idempotencyKey, endpointId, conversationId, attachmentIds }); }
      const attachedFiles = attachmentIds.length
        ? await tx
          .select({
            id: issueAttachments.id,
            originalFilename: assets.originalFilename,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .where(
            and(
              eq(issueAttachments.companyId, conversation.companyId),
              eq(issueAttachments.issueId, conversation.issueId),
              eq(issueAttachments.issueCommentId, comment.id),
              inArray(issueAttachments.id, attachmentIds),
            ),
          )
        : [];
      const attachedFileById = new Map(
        attachedFiles.map((file) => [file.id, file]),
      );
      const orderedFiles = attachmentIds.map(
        (attachmentId) => attachedFileById.get(attachmentId)!,
      );
      const publicationCreatedAt = new Date();
      await notifyChatPublicationWork(tx);
      const [created] = await tx
        .insert(chatPublications)
        .values({
          companyId: conversation.companyId,
          endpointId,
          conversationId,
          issueId: conversation.issueId,
          commentId: comment.id,
          idempotencyKey,
          payload: projectSafeChatPublication({
            classification: "external",
            source: "explicit_board_send",
            text: comment.body,
          }),
          state: "pending",
          createdAt: publicationCreatedAt,
          updatedAt: publicationCreatedAt,
        })
        .returning();
      let terminalPublication = created;
      for (const [index, file] of orderedFiles.entries()) {
        const attachmentCreatedAt = new Date(
          publicationCreatedAt.getTime() + index + 1,
        );
        await notifyChatPublicationWork(tx);
        const [attachmentPublication] = await tx
          .insert(chatPublications)
          .values({
            companyId: conversation.companyId,
            endpointId,
            conversationId,
            issueId: conversation.issueId,
            commentId: comment.id,
            idempotencyKey: `${idempotencyKey}:attachment:${file.id}`,
            payload: projectSafeChatPublication({
              classification: "external",
              source: "explicit_board_send",
              text: `Shared ${file.originalFilename ?? "a file"}.`,
              attachmentIds: [file.id],
            }),
            state: "pending",
            createdAt: attachmentCreatedAt,
            updatedAt: attachmentCreatedAt,
          })
          .returning();
        await stageTeamsBoardFileIntent(
          tx,
          attachmentPublication,
          userId,
          conversation,
        );
        terminalPublication = attachmentPublication;
      }
      await logActivity(tx as unknown as Db, {
        companyId: conversation.companyId,
        actorType: "user",
        actorId: userId,
        action: "chat.publication_requested",
        entityType: "chat_publication",
        entityId: created.id,
        issueId: conversation.issueId,
        details: {
          endpointId,
          conversationId,
          commentId: comment.id,
          source: "explicit_board_send",
        },
      });
      return terminalPublication;
    });
    if ("rejection" in publication) {
      throw conflict(
        "Selected attachments are already bound to another comment",
        publication.rejection,
      );
    }
    if (emailBoundary?.endpoint.provider === "slack") await processPendingSlackBoardMessages();
    await processPendingPublications();
    const batch = publication.commentId
      ? await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, endpointId),
            eq(chatPublications.conversationId, conversationId),
            eq(chatPublications.commentId, publication.commentId),
          ),
        )
        .orderBy(
          asc(chatPublications.createdAt),
          asc(publicationTransportOrderKey(chatPublications)),
        )
      : [publication];
    // A multi-part send is successful only when every ordered publication is
    // published. Surface the first blocking row so the UI points operators at
    // the actual retry/duplicate-risk resolution instead of a later pending
    // attachment that cannot advance past it.
    return (
      batch.find((candidate) => candidate.state !== "published") ??
      batch.at(-1) ??
      publication
    );
  }
  return { getPublicationBatchStatus, publishComment, publishBoardMessage };
}
