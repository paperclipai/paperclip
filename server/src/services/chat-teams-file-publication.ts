import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { CHAT_FILE_TRANSFER_PHASES } from "@paperclipai/shared";
import {
  chatActions,
  chatConversations,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  chatTeamsFileTransfers,
  issueAttachments,
  issueComments,
  issues,
  type Db,
} from "@paperclipai/db";
import { projectChatFileTransfer } from "./chat-publication-batches.js";
import type { TeamsFileTransferSummary } from "./chat-teams-file-transfers.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const opaque = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\x00-\x20\x7f]+$/);
const summarySchema = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    endpointId: z.uuid(),
    conversationId: z.uuid(),
    issueId: z.uuid(),
    publicationId: z.uuid(),
    filename: z.string().min(1).max(255),
    phase: z.enum(CHAT_FILE_TRANSFER_PHASES),
    version: z.number().int().positive(),
    reason: z.string().nullable(),
    consentConfirmed: z.boolean(),
    fileDelivered: z.boolean(),
    consentMessageId: opaque.nullable(),
    fileInfoMessageId: opaque.nullable(),
    operatorConfirmed: z.boolean(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
const effectStage = {
  consent_sending: "consent",
  uploading: "upload",
  file_info_sending: "file_info",
} as const;
const reasons: Record<string, string> = {
  consent_post_unknown:
    "The consent-card delivery outcome is unknown. Operator review is required.",
  upload_outcome_unknown:
    "The file-upload outcome is unknown. The upload will not be repeated automatically.",
  file_info_post_unknown:
    "The file-card delivery outcome is unknown. Operator review is required.",
  worker_outcome_unknown:
    "The file-transfer outcome is unknown. Operator review is required.",
  conflicting_consent_receipt:
    "Conflicting file-consent receipts require operator review.",
  wrong_scope: "The file-consent receipt does not match this transfer.",
  unsupported_upload_host:
    "The Teams upload host is not supported. Use the authenticated task link.",
  invalid_upload_info:
    "Teams did not provide a supported upload destination. Use the authenticated task link.",
  recipient_declined: "The recipient declined this file.",
  unused_consent_expired: "The unused file consent expired.",
  expired: "The file consent expired.",
  cancelled_before_upload: "This file transfer was cancelled before upload.",
  cancelled_after_upload:
    "Further file delivery was cancelled; the uploaded file may remain in Teams.",
  provider_not_attempted:
    "The next file-transfer step has not been sent and is awaiting retry.",
  operator_cancelled_consent_unknown:
    "Further work was stopped; the consent-card outcome remains unknown.",
  operator_cancelled_upload_unknown:
    "Further work was stopped; the upload outcome remains unknown.",
  operator_cancelled_file_info_unknown:
    "Further work was stopped; the file-card outcome remains unknown.",
  operator_cancelled_conflict:
    "Further work was stopped; conflicting transfer evidence is retained.",
};
function fail(): never {
  throw new Error(
    "Teams file publication projection conflicted with durable state",
  );
}

/** Same transaction as the transfer mutation. This records already-admitted
 * receipts, not permission for another effect; no provider work or private URLs.
 * Lock order is publication -> transfer -> endpoint -> conversation -> source. */
export async function projectTeamsFilePublication(
  tx: Tx,
  input: TeamsFileTransferSummary,
): Promise<void> {
  const parsed = summarySchema.safeParse(input);
  if (!parsed.success) fail();
  const s = parsed.data;
  const publication = await tx
    .select()
    .from(chatPublications)
    .where(
      and(
        eq(chatPublications.id, s.publicationId),
        eq(chatPublications.companyId, s.companyId),
        eq(chatPublications.endpointId, s.endpointId),
        eq(chatPublications.conversationId, s.conversationId),
        eq(chatPublications.issueId, s.issueId),
      ),
    )
    .for("update")
    .then((rows) => rows[0]);
  if (!publication) fail();
  const transfer = await tx
    .select({
      id: chatTeamsFileTransfers.id,
      companyId: chatTeamsFileTransfers.companyId,
      endpointId: chatTeamsFileTransfers.endpointId,
      conversationId: chatTeamsFileTransfers.conversationId,
      issueId: chatTeamsFileTransfers.issueId,
      publicationId: chatTeamsFileTransfers.publicationId,
      commentId: chatTeamsFileTransfers.commentId,
      attachmentId: chatTeamsFileTransfers.attachmentId,
      filename: chatTeamsFileTransfers.filename,
      phase: chatTeamsFileTransfers.phase,
      version: chatTeamsFileTransfers.version,
      reason: chatTeamsFileTransfers.reason,
      expiresAt: chatTeamsFileTransfers.expiresAt,
      consentMessageId: chatTeamsFileTransfers.consentMessageId,
      fileInfoMessageId: chatTeamsFileTransfers.fileInfoMessageId,
      responseActivityId: chatTeamsFileTransfers.responseActivityId,
      attemptId: chatTeamsFileTransfers.attemptId,
      attemptExpiresAt: chatTeamsFileTransfers.attemptExpiresAt,
      operatorConfirmed: sql<boolean>`coalesce(${chatTeamsFileTransfers.privateState}->'resolution'->>'schema' = 'paperclip.teams.file-resolution.v1'
      and ${chatTeamsFileTransfers.privateState}->'resolution'->>'action' = 'mark_delivered'
      and ${chatTeamsFileTransfers.privateState}->'resolution'->>'fromPhase' = 'file_info_unknown', false)`,
    })
    .from(chatTeamsFileTransfers)
    .where(
      and(
        eq(chatTeamsFileTransfers.id, s.id),
        eq(chatTeamsFileTransfers.companyId, s.companyId),
      ),
    )
    .for("update")
    .then((rows) => rows[0]);
  if (!transfer) fail();
  const expected: TeamsFileTransferSummary = {
    ...s,
    id: transfer.id,
    companyId: transfer.companyId,
    endpointId: transfer.endpointId,
    conversationId: transfer.conversationId,
    issueId: transfer.issueId,
    publicationId: transfer.publicationId,
    filename: transfer.filename,
    phase: transfer.phase as TeamsFileTransferSummary["phase"],
    version: transfer.version,
    reason: transfer.reason,
    expiresAt: transfer.expiresAt.toISOString(),
    consentMessageId: transfer.consentMessageId,
    fileInfoMessageId: transfer.fileInfoMessageId,
    consentConfirmed: Boolean(
      transfer.consentMessageId || transfer.responseActivityId,
    ),
    operatorConfirmed: transfer.operatorConfirmed,
    fileDelivered:
      transfer.phase === "delivered" &&
      Boolean(transfer.fileInfoMessageId || transfer.operatorConfirmed),
  };
  if (JSON.stringify(summarySchema.parse(expected)) !== JSON.stringify(s))
    fail();
  const endpoint = await tx
    .select({ id: chatEndpoints.id, provider: chatEndpoints.provider })
    .from(chatEndpoints)
    .where(
      and(
        eq(chatEndpoints.id, s.endpointId),
        eq(chatEndpoints.companyId, s.companyId),
      ),
    )
    .for("no key update")
    .then((rows) => rows[0]);
  const conversation = await tx
    .select({ id: chatConversations.id })
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.id, s.conversationId),
        eq(chatConversations.companyId, s.companyId),
        eq(chatConversations.endpointId, s.endpointId),
        eq(chatConversations.issueId, s.issueId),
      ),
    )
    .for("update")
    .then((rows) => rows[0]);
  const issue = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, s.issueId), eq(issues.companyId, s.companyId)))
    .then((rows) => rows[0]);
  if (
    !endpoint ||
    endpoint.provider !== "microsoft-teams" ||
    !conversation ||
    !issue
  )
    fail();
  const comment = await tx
    .select()
    .from(issueComments)
    .where(eq(issueComments.id, transfer.commentId))
    .for("share")
    .then((rows) => rows[0]);
  const attachment = await tx
    .select()
    .from(issueAttachments)
    .where(eq(issueAttachments.id, transfer.attachmentId))
    .for("share")
    .then((rows) => rows[0]);
  if (
    (comment &&
      (comment.companyId !== s.companyId || comment.issueId !== s.issueId)) ||
    (attachment &&
      (attachment.companyId !== s.companyId ||
        attachment.issueId !== s.issueId ||
        attachment.issueCommentId !== transfer.commentId)) ||
    (publication.commentId !== null &&
      publication.commentId !== transfer.commentId) ||
    publication.payload.attachmentIds?.length !== 1 ||
    publication.payload.attachmentIds[0] !== transfer.attachmentId
  )
    fail();
  const commentId =
    comment && !comment.deletedAt && publication.commentId === comment.id
      ? comment.id
      : null;
  const projected = projectChatFileTransfer(
    {
      id: publication.id,
      state: publication.state,
      attempts: publication.attempts,
    },
    {
      ...transfer,
      operatorConfirmed: transfer.operatorConfirmed,
    },
  );
  const state = projected.state;
  const actualFinalId =
    s.phase === "delivered" ? transfer.fileInfoMessageId : null;
  if (
    (publication.providerMessageId &&
      publication.providerMessageId !== actualFinalId) ||
    (publication.state === "published" && state !== "published") ||
    (actualFinalId && actualFinalId === transfer.consentMessageId)
  )
    fail();

  let newAttempt = false;
  const stage = effectStage[s.phase as keyof typeof effectStage];
  if (stage) {
    if (!transfer.attemptId || !transfer.attemptExpiresAt) fail();
    const providerActionId = `teams-file-effect:${transfer.attemptId}`;
    const payload = {
      schema: "paperclip.teams.file-effect-intent.v1",
      transferId: s.id,
      publicationId: s.publicationId,
      attemptId: transfer.attemptId,
      stage,
    };
    const inserted = await tx
      .insert(chatActions)
      .values({
        companyId: s.companyId,
        endpointId: s.endpointId,
        conversationId: s.conversationId,
        kind: "teams_file_effect_intent",
        providerActionId,
        payload,
        status: "processed",
      })
      .onConflictDoNothing()
      .returning({ id: chatActions.id });
    newAttempt = inserted.length === 1;
    if (!newAttempt) {
      const prior = await tx
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.companyId, s.companyId),
            eq(chatActions.endpointId, s.endpointId),
            eq(chatActions.conversationId, s.conversationId),
            eq(chatActions.kind, "teams_file_effect_intent"),
            eq(chatActions.providerActionId, providerActionId),
            eq(chatActions.status, "processed"),
            sql`${chatActions.payload} = ${JSON.stringify(payload)}::jsonb`,
          ),
        )
        .then((rows) => rows[0]);
      if (!prior) fail();
    }
  }
  const now = new Date();
  if (actualFinalId) {
    const inserted = await tx
      .insert(chatMessageLinks)
      .values({
        companyId: s.companyId,
        endpointId: s.endpointId,
        conversationId: s.conversationId,
        publicationId: s.publicationId,
        commentId,
        providerMessageId: actualFinalId,
        direction: "outbound",
      })
      .onConflictDoNothing()
      .returning({ id: chatMessageLinks.id });
    if (!inserted.length) {
      const prior = await tx
        .select()
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.endpointId, s.endpointId),
            eq(chatMessageLinks.conversationId, s.conversationId),
            eq(chatMessageLinks.providerMessageId, actualFinalId),
          ),
        )
        .then((rows) => rows[0]);
      if (
        !prior ||
        prior.companyId !== s.companyId ||
        prior.publicationId !== s.publicationId ||
        prior.direction !== "outbound" ||
        (prior.commentId !== null && prior.commentId !== transfer.commentId)
      )
        fail();
    }
  }
  const redactedError =
    projected.redactedError ??
    (s.reason ? reasons[s.reason] : null) ??
    (state === "delivery_unknown"
      ? "The file-transfer outcome requires operator review."
      : state === "cancelled"
        ? "Further file-transfer work has stopped."
        : null);
  const nextAttemptAt =
    state === "pending"
      ? publication.state === "pending" && publication.nextAttemptAt
        ? publication.nextAttemptAt
        : new Date(
            now.getTime() +
              (s.reason === "provider_not_attempted" ? 30_000 : 0),
          )
      : state === "streaming"
        ? transfer.attemptExpiresAt
        : state === "awaiting_consent"
          ? transfer.expiresAt
          : null;
  const publishedAt =
    state === "published"
      ? (publication.publishedAt ?? now)
      : publication.publishedAt;
  const sameDate = (a: Date | null, b: Date | null) =>
    a?.getTime() === b?.getTime();
  if (
    newAttempt ||
    publication.state !== state ||
    publication.providerMessageId !== actualFinalId ||
    publication.providerUrl !== null ||
    publication.redactedError !== redactedError ||
    !sameDate(publication.nextAttemptAt, nextAttemptAt) ||
    !sameDate(publication.publishedAt, publishedAt)
  ) {
    await tx
      .update(chatPublications)
      .set({
        state,
        attempts: publication.attempts + Number(newAttempt),
        providerMessageId: actualFinalId,
        providerUrl: null,
        redactedError,
        nextAttemptAt,
        publishedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatPublications.id, s.publicationId),
          eq(chatPublications.companyId, s.companyId),
        ),
      );
  }
  if (actualFinalId && publication.providerMessageId === null) {
    await tx
      .update(chatEndpoints)
      .set({
        lastPublicationAt: sql`greatest(${chatEndpoints.lastPublicationAt}, ${now.toISOString()}::timestamptz)`,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatEndpoints.id, s.endpointId),
          eq(chatEndpoints.companyId, s.companyId),
        ),
      );
  }
}
