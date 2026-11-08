import type { EndpointRow, DbTransaction, DbOrTransaction, LifecycleRuntimeFence } from "../../chat-channels/runtime-types.js";

import { notifyChatPublicationWork } from "../../chat-work-notifications.js";

import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";

import { chatCredentialMutationLease, type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import {
  randomUUID,
} from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
} from "@paperclipai/db";

import {
  isUuidLike,
} from "@paperclipai/shared";

import {
  type SlackFileUploadAcceptedReceipt,
} from "../../chat-sdk-runtime.js";

import {
  stageSlackSessionSync,
} from "../../chat-slack-session-outbox.js";

import { classifyChatPublicationError } from "../../chat-publication-errors.js";

import type { EndpointRecord } from "../runtime-types.js";

type SlackFileUploadReceiptPayload = {
  version: 1;
  publicationId: string;
  publicationAttempt: number;
  threadId: string;
  fileIds: string[];
  botExternalId: string;
  runtimeGeneration: number;
  credentialFingerprint: string;
};

function slackFileUploadReceiptPayload(
  payload: Record<string, unknown>,
): SlackFileUploadReceiptPayload | null {
  if (
    payload.version !== 1 ||
    typeof payload.publicationId !== "string" ||
    !isUuidLike(payload.publicationId) ||
    typeof payload.publicationAttempt !== "number" ||
    !Number.isSafeInteger(payload.publicationAttempt) ||
    payload.publicationAttempt < 1 ||
    typeof payload.threadId !== "string" ||
    payload.threadId.length < 1 ||
    payload.threadId.length > 2_048 ||
    !payload.threadId.startsWith("slack:") ||
    typeof payload.botExternalId !== "string" ||
    payload.botExternalId.length < 1 ||
    payload.botExternalId.length > 255 ||
    typeof payload.runtimeGeneration !== "number" ||
    !Number.isSafeInteger(payload.runtimeGeneration) ||
    payload.runtimeGeneration < 0 ||
    typeof payload.credentialFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.credentialFingerprint) ||
    !Array.isArray(payload.fileIds) ||
    payload.fileIds.length < 1 ||
    payload.fileIds.length > 20 ||
    payload.fileIds.some(
      (fileId) =>
        typeof fileId !== "string" || !/^F[A-Z0-9]{1,254}$/.test(fileId),
    ) ||
    new Set(payload.fileIds).size !== payload.fileIds.length
  ) {
    return null;
  }
  return payload as SlackFileUploadReceiptPayload;
}

function operatorConfirmedSlackFileReceipt(
  result: Record<string, unknown> | null,
  payload: SlackFileUploadReceiptPayload,
): boolean {
  return (
    result?.operatorConfirmedPublicationId === payload.publicationId &&
    result.operatorConfirmedAttempt === payload.publicationAttempt &&
    typeof result.operatorConfirmedAt === "string" &&
    Number.isFinite(Date.parse(result.operatorConfirmedAt))
  );
}

function sameSlackFileUploadReceipt(
  left: SlackFileUploadReceiptPayload,
  right: SlackFileUploadReceiptPayload,
): boolean {
  return (
    left.publicationId === right.publicationId &&
    left.publicationAttempt === right.publicationAttempt &&
    left.threadId === right.threadId &&
    left.botExternalId === right.botExternalId &&
    left.runtimeGeneration === right.runtimeGeneration &&
    left.credentialFingerprint === right.credentialFingerprint &&
    left.fileIds.length === right.fileIds.length &&
    left.fileIds.every((fileId, index) => fileId === right.fileIds[index])
  );
}
const SLACK_FILE_RECEIPT_MAX_AGE_MS = 24 * 60 * 60_000;
const SLACK_FILE_RECEIPT_MAX_ATTEMPTS = 12;
const SLACK_FILE_RECEIPT_STALE_MS = 60_000;
type ConversationRow = typeof chatConversations.$inferSelect;
type SlackFileReceiptsOptions = {
  endpointRecord: (id: string) => Promise<EndpointRecord | null>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: typeof chatEndpointResources.$inferSelect | null | undefined) => boolean;
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  isExplicitOperatorPublication: (publication: typeof chatPublications.$inferSelect) => boolean;
  recordExactOutboundPublicationLink: (tx: DbOrTransaction, input: { publication: typeof chatPublications.$inferSelect; providerMessageId: string }) => Promise<boolean>;
};

export function createSlackFileReceipts(db: Db, options: SlackFileReceiptsOptions) {
  const { endpointRecord, withCredentialMutationLease, runtimeCallbackEndpoint, nonDirectDestinationAllowed, runtimeFor, isExplicitOperatorPublication, recordExactOutboundPublicationLink } = options;


  async function recordSlackFileUploadReceipt(input: {
    credentialLease: CredentialMutationLeaseGuard;
    conversation: ConversationRow;
    endpoint: EndpointRow;
    publication: typeof chatPublications.$inferSelect;
    receipt: SlackFileUploadAcceptedReceipt;
    runtimeContext: LifecycleRuntimeFence;
  }): Promise<string> {
    const publicationAttempt = input.publication.attempts + 1;
    const botExternalId = input.endpoint.botExternalId;
    const expectedThreadId = `slack:${input.receipt.channelId}:${input.receipt.threadTs ?? ""}`;
    if (
      input.endpoint.provider !== "slack" ||
      !botExternalId ||
      input.receipt.version !== 1 ||
      expectedThreadId !== input.conversation.externalThreadId ||
      input.receipt.fileIds.length !==
        (input.publication.payload.attachmentIds?.length ?? 0)
    ) {
      throw new Error(
        "Slack file upload receipt did not match its publication",
      );
    }
    const payload: SlackFileUploadReceiptPayload = {
      version: 1,
      publicationId: input.publication.id,
      publicationAttempt,
      threadId: expectedThreadId,
      fileIds: [...input.receipt.fileIds],
      botExternalId,
      runtimeGeneration: input.runtimeContext.generation,
      credentialFingerprint: input.runtimeContext.credentialFingerprint,
    };
    if (!slackFileUploadReceiptPayload(payload)) {
      throw new Error("Slack file upload receipt was malformed");
    }
    const providerActionId = `slack-file-receipt:${input.publication.id}:${publicationAttempt}`;
    const recordedAt = new Date();
    return db.transaction(async (tx) => {
      await input.credentialLease.assertOwned(tx);
      const publication = await tx
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.id, input.publication.id),
            eq(chatPublications.companyId, input.publication.companyId),
            eq(chatPublications.endpointId, input.publication.endpointId),
            eq(
              chatPublications.conversationId,
              input.publication.conversationId,
            ),
            eq(chatPublications.state, "streaming"),
            eq(chatPublications.attempts, publicationAttempt),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const endpoint = publication
        ? await runtimeCallbackEndpoint(
            tx,
            input.endpoint.id,
            input.runtimeContext,
            ["verifying", "active"],
          )
        : null;
      const conversation = endpoint
        ? await tx
            .select({
              externalThreadId: chatConversations.externalThreadId,
              id: chatConversations.id,
            })
            .from(chatConversations)
            .where(
              and(
                eq(chatConversations.id, input.conversation.id),
                eq(chatConversations.companyId, input.publication.companyId),
                eq(chatConversations.endpointId, input.endpoint.id),
                inArray(chatConversations.state, [
                  "active",
                  "waiting",
                  "completed",
                ]),
              ),
            )
            .for("no key update")
            .then((rows) => rows[0] ?? null)
        : null;
      if (
        !publication ||
        endpoint?.provider !== "slack" ||
        endpoint.botExternalId !== botExternalId ||
        conversation?.externalThreadId !== expectedThreadId
      ) {
        throw new Error(
          "Slack file upload ownership changed before receipt persistence",
        );
      }
      await notifyChatPublicationWork(tx);
      const inserted = await tx
        .insert(chatActions)
        .values({
          companyId: input.publication.companyId,
          endpointId: input.publication.endpointId,
          conversationId: input.publication.conversationId,
          kind: "slack_file_upload_receipt",
          providerActionId,
          payload,
          status: "received",
          result: { code: "slack_file_upload_identity_pending", attempts: 0 },
          createdAt: recordedAt,
          updatedAt: recordedAt,
        })
        .onConflictDoNothing()
        .returning({ id: chatActions.id });
      if (inserted[0]) {
        await input.credentialLease.assertOwned(tx);
        return inserted[0].id;
      }
      const existing = await tx
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, input.publication.endpointId),
            eq(chatActions.providerActionId, providerActionId),
            eq(chatActions.kind, "slack_file_upload_receipt"),
            sql`${chatActions.payload} = ${JSON.stringify(payload)}::jsonb`,
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existing) {
        throw new Error(
          "Slack file upload receipt conflicted with durable state",
        );
      }
      await input.credentialLease.assertOwned(tx);
      return existing.id;
    });
  }

  async function stageSlackFilePublicationSuccess(
    tx: DbTransaction,
    input: {
      committedAt: Date;
      endpoint: EndpointRow;
      publication: typeof chatPublications.$inferSelect;
      providerMessageId: string;
      runtimeContext: LifecycleRuntimeFence;
      stageSessionSync: boolean;
    },
  ): Promise<void> {
    if (
      !(await recordExactOutboundPublicationLink(tx, {
        publication: input.publication,
        providerMessageId: input.providerMessageId,
      }))
    ) {
      throw new Error(
        "Slack file upload message identity conflicts with another publication",
      );
    }
    await tx
      .update(chatEndpoints)
      .set({
        lastPublicationAt: input.committedAt,
        updatedAt: input.committedAt,
      })
      .where(
        and(
          eq(chatEndpoints.id, input.endpoint.id),
          inArray(chatEndpoints.status, ["verifying", "active"]),
          sql`coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0) = ${input.runtimeContext.generation}`,
        ),
      );
    if (input.stageSessionSync) {
      await stageSlackSessionSync(tx, {
        companyId: input.publication.companyId,
        endpointId: input.publication.endpointId,
        conversationId: input.publication.conversationId,
        runtimeGeneration: input.runtimeContext.generation,
        credentialFingerprint: input.runtimeContext.credentialFingerprint,
      });
    }
  }

  async function lockSlackFileReceiptAuthorization(
    tx: DbTransaction,
    input: {
      actionId: string;
      payload: SlackFileUploadReceiptPayload;
    },
  ): Promise<
    | {
        action: typeof chatActions.$inferSelect;
        conversation: ConversationRow;
        endpoint: EndpointRow;
        mode: "delivery_unknown" | "operator_confirmed";
        publication: typeof chatPublications.$inferSelect;
      }
    | { action: typeof chatActions.$inferSelect; mode: "defer" | "settled" }
    | null
  > {
    const publication = await tx
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.id, input.payload.publicationId),
          eq(chatPublications.attempts, input.payload.publicationAttempt),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    const action = publication
      ? await tx
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.id, input.actionId),
              eq(chatActions.companyId, publication.companyId),
              eq(chatActions.endpointId, publication.endpointId),
              eq(chatActions.conversationId, publication.conversationId),
              eq(chatActions.kind, "slack_file_upload_receipt"),
              eq(
                chatActions.providerActionId,
                `slack-file-receipt:${publication.id}:${publication.attempts}`,
              ),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null)
      : null;
    const currentPayload = action
      ? slackFileUploadReceiptPayload(action.payload)
      : null;
    if (
      !publication ||
      !action ||
      !publication.payload.attachmentIds?.length ||
      publication.payload.card ||
      publication.payload.interactionId ||
      publication.idempotencyKey.startsWith("control:") ||
      !currentPayload ||
      !sameSlackFileUploadReceipt(currentPayload, input.payload)
    ) {
      return null;
    }
    if (publication.state === "streaming") {
      return { action, mode: "defer" };
    }
    if (publication.state === "published" && publication.providerMessageId) {
      const exactLink = await tx
        .select({ id: chatMessageLinks.id })
        .from(chatMessageLinks)
        .where(
          and(
            eq(chatMessageLinks.companyId, publication.companyId),
            eq(chatMessageLinks.endpointId, publication.endpointId),
            eq(chatMessageLinks.conversationId, publication.conversationId),
            eq(chatMessageLinks.publicationId, publication.id),
            publication.commentId
              ? eq(chatMessageLinks.commentId, publication.commentId)
              : isNull(chatMessageLinks.commentId),
            eq(
              chatMessageLinks.providerMessageId,
              publication.providerMessageId,
            ),
            eq(chatMessageLinks.direction, "outbound"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return exactLink ? { action, mode: "settled" } : null;
    }
    const mode =
      publication.state === "delivery_unknown"
        ? "delivery_unknown"
        : publication.state === "published" &&
            !publication.providerMessageId &&
            operatorConfirmedSlackFileReceipt(action.result, input.payload)
          ? "operator_confirmed"
          : null;
    if (!mode) return null;
    const endpoint = await runtimeCallbackEndpoint(
      tx,
      publication.endpointId,
      {
        generation: input.payload.runtimeGeneration,
        credentialFingerprint: input.payload.credentialFingerprint,
      },
      ["verifying", "active"],
    );
    const conversation = endpoint
      ? await tx
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.id, publication.conversationId),
              eq(chatConversations.companyId, publication.companyId),
              eq(chatConversations.endpointId, publication.endpointId),
              eq(chatConversations.externalThreadId, input.payload.threadId),
              inArray(chatConversations.state, [
                "active",
                "waiting",
                "completed",
              ]),
            ),
          )
          .for("no key update")
          .then((rows) => rows[0] ?? null)
      : null;
    const resource =
      endpoint && conversation?.resourceId && !conversation.isDirectMessage
        ? await tx
            .select()
            .from(chatEndpointResources)
            .where(
              and(
                eq(chatEndpointResources.id, conversation.resourceId),
                eq(chatEndpointResources.companyId, endpoint.companyId),
                eq(chatEndpointResources.endpointId, endpoint.id),
              ),
            )
            .for("no key update")
            .then((rows) => rows[0] ?? null)
        : null;
    if (
      endpoint?.provider !== "slack" ||
      endpoint.botExternalId !== input.payload.botExternalId ||
      !conversation ||
      !(conversation.isDirectMessage
        ? endpoint.allowDirectMessages
        : nonDirectDestinationAllowed(endpoint, resource))
    ) {
      return null;
    }
    return { action, conversation, endpoint, mode, publication };
  }

  async function processPendingSlackFileUploadReceipts(limit = 25) {
    const selectedAt = new Date();
    const actions = await db
      .select()
      .from(chatActions)
      .where(
        slackReceiptEligibility(selectedAt),
      )
      .orderBy(asc(chatActions.updatedAt), asc(chatActions.id))
      .limit(limit);
    let processed = 0;
    for (const selected of actions) {
      const payload = slackFileUploadReceiptPayload(selected.payload);
      if (!payload) {
        await db.transaction(async (tx) => {
          await notifyChatPublicationWork(tx);
          return tx
            .update(chatActions)
            .set({
              status: "failed",
              result: {
                code: "slack_file_upload_receipt_payload_invalid",
                retryable: false,
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, selected.id),
                eq(chatActions.kind, selected.kind),
                eq(chatActions.status, selected.status),
                sql`${chatActions.payload} = ${JSON.stringify(selected.payload)}::jsonb`,
                selected.result === null
                  ? isNull(chatActions.result)
                  : sql`${chatActions.result} = ${JSON.stringify(selected.result)}::jsonb`,
              ),
            );
        });
        continue;
      }
      const record = await endpointRecord(selected.endpointId);
      if (!record) {
        await db.transaction(async (tx) => {
          await notifyChatPublicationWork(tx);
          return tx
            .update(chatActions)
            .set({
              status: "cancelled",
              result: { code: "slack_file_upload_receipt_endpoint_removed" },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, selected.id),
                eq(chatActions.kind, selected.kind),
                eq(chatActions.status, selected.status),
                sql`${chatActions.payload} = ${JSON.stringify(selected.payload)}::jsonb`,
                selected.result === null
                  ? isNull(chatActions.result)
                  : sql`${chatActions.result} = ${JSON.stringify(selected.result)}::jsonb`,
              ),
            );
        });
        continue;
      }
      if (["paused", "attention"].includes(record.endpoint.status)) continue;
      const ownerToken = randomUUID();
      let attempt = 1;
      try {
        await withCredentialMutationLease(record.endpoint, async (lease) => {
          const claim = await db.transaction(async (tx) => {
            await lease.assertOwned(tx);
            const locked = await lockSlackFileReceiptAuthorization(tx, {
              actionId: selected.id,
              payload,
            });
            const decisionAt = new Date();
            const priorAttempts =
              typeof locked?.action.result?.attempts === "number" &&
              Number.isSafeInteger(locked.action.result.attempts)
                ? locked.action.result.attempts
                : 0;
            attempt = priorAttempts + 1;
            const retryAt =
              typeof locked?.action.result?.retryAt === "string"
                ? Date.parse(locked.action.result.retryAt)
                : Number.NaN;
            const eligible = locked
              ? locked.action.status === "received" ||
                (locked.action.status === "failed" &&
                  locked.action.result?.retryable === true &&
                  Number.isFinite(retryAt) &&
                  retryAt <= decisionAt.getTime()) ||
                (locked.action.status === "processing" &&
                  locked.action.updatedAt.getTime() <=
                    decisionAt.getTime() - SLACK_FILE_RECEIPT_STALE_MS)
              : false;
            if (locked && !eligible) return null;
            if (locked?.mode === "defer") {
              if (locked.action.status === "processing") {
                await notifyChatPublicationWork(tx);
                await tx
                  .update(chatActions)
                  .set({
                    status: "received",
                    result: {
                      code: "slack_file_upload_identity_pending",
                      attempts: priorAttempts,
                    },
                    updatedAt: new Date(),
                  })
                  .where(eq(chatActions.id, locked.action.id));
              }
              return null;
            }
            if (locked?.mode === "settled") {
              await notifyChatPublicationWork(tx);
              await tx
                .update(chatActions)
                .set({
                  status: "processed",
                  result: {
                    code: "slack_file_upload_identity_confirmed",
                    attempts: priorAttempts,
                  },
                  updatedAt: new Date(),
                })
                .where(eq(chatActions.id, locked.action.id));
              return null;
            }
            if (
              !locked ||
              decisionAt.getTime() -
                (locked?.action.createdAt ?? selected.createdAt).getTime() >
                SLACK_FILE_RECEIPT_MAX_AGE_MS ||
              attempt > SLACK_FILE_RECEIPT_MAX_ATTEMPTS
            ) {
              await notifyChatPublicationWork(tx);
              await tx
                .update(chatActions)
                .set({
                  status: "cancelled",
                  result: {
                    code: locked
                      ? "slack_file_upload_receipt_expired"
                      : "slack_file_upload_receipt_authorization_changed",
                    attempts: priorAttempts,
                  },
                  updatedAt: decisionAt,
                })
                .where(
                  and(
                    eq(chatActions.id, selected.id),
                    inArray(chatActions.status, [
                      "received",
                      "failed",
                      "processing",
                    ]),
                  ),
                );
              return null;
            }
            if (
              !["received", "failed", "processing"].includes(
                locked.action.status,
              )
            ) {
              return null;
            }
            await notifyChatPublicationWork(tx);
            const [claimed] = await tx
              .update(chatActions)
              .set({
                status: "processing",
                result: {
                  attempts: attempt,
                  ownerToken,
                  ...(locked.mode === "operator_confirmed"
                    ? {
                        operatorConfirmedPublicationId:
                          locked.action.result?.operatorConfirmedPublicationId,
                        operatorConfirmedAttempt:
                          locked.action.result?.operatorConfirmedAttempt,
                        operatorConfirmedAt:
                          locked.action.result?.operatorConfirmedAt,
                      }
                    : {}),
                },
                updatedAt: decisionAt,
              })
              .where(
                and(
                  eq(chatActions.id, locked.action.id),
                  eq(chatActions.status, locked.action.status),
                ),
              )
              .returning({ id: chatActions.id });
            await lease.assertOwned(tx);
            return claimed ? locked : null;
          });
          if (!claim || !("endpoint" in claim)) return;
          processed += 1;
          const endpointRuntime = await runtimeFor(claim.endpoint);
          await lease.assertOwned();
          const providerMessageId =
            await endpointRuntime.resolveSlackFileUploadReceipt(
              payload.threadId,
              payload.fileIds,
            );
          if (!providerMessageId) {
            await db.transaction(async (tx) => {
              await lease.assertOwned(tx);
              await notifyChatPublicationWork(tx);
              await tx
                .update(chatActions)
                .set({
                  status: "failed",
                  result: sql`coalesce(${chatActions.result}, '{}'::jsonb) || ${JSON.stringify(
                    {
                      attempts: attempt,
                      code: "slack_file_upload_identity_pending",
                      retryable: true,
                      retryAt: new Date(
                        Date.now() + Math.min(60_000, 1_000 * 2 ** attempt),
                      ).toISOString(),
                    },
                  )}::jsonb`,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatActions.id, selected.id),
                    eq(chatActions.status, "processing"),
                    sql`${chatActions.result}->>'ownerToken' = ${ownerToken}`,
                  ),
                );
            });
            return;
          }
          await db.transaction(async (tx) => {
            await lease.assertOwned(tx);
            const locked = await lockSlackFileReceiptAuthorization(tx, {
              actionId: selected.id,
              payload,
            });
            if (
              !locked ||
              locked.mode === "defer" ||
              locked.mode === "settled" ||
              !("publication" in locked) ||
              locked.action.status !== "processing" ||
              locked.action.result?.ownerToken !== ownerToken
            ) {
              if (!locked) {
                await notifyChatPublicationWork(tx);
                await tx
                  .update(chatActions)
                  .set({
                    status: "cancelled",
                    result: {
                      attempts: attempt,
                      code: "slack_file_upload_receipt_authorization_changed",
                    },
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(chatActions.id, selected.id),
                      eq(chatActions.status, "processing"),
                      sql`${chatActions.result}->>'ownerToken' = ${ownerToken}`,
                    ),
                  );
              } else if (locked.mode === "defer") {
                await notifyChatPublicationWork(tx);
                await tx
                  .update(chatActions)
                  .set({
                    status: "received",
                    result: {
                      attempts: attempt,
                      code: "slack_file_upload_identity_pending",
                    },
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(chatActions.id, selected.id),
                      eq(chatActions.status, "processing"),
                      sql`${chatActions.result}->>'ownerToken' = ${ownerToken}`,
                    ),
                  );
              } else {
                await notifyChatPublicationWork(tx);
                await tx
                  .update(chatActions)
                  .set({
                    status:
                      locked.mode === "settled" ? "processed" : "cancelled",
                    result: {
                      attempts: attempt,
                      code:
                        locked.mode === "settled"
                          ? "slack_file_upload_identity_confirmed"
                          : "slack_file_upload_receipt_superseded",
                    },
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(chatActions.id, selected.id),
                      eq(chatActions.status, "processing"),
                      sql`${chatActions.result}->>'ownerToken' = ${ownerToken}`,
                    ),
                  );
              }
              return;
            }
            const committedAt = new Date();
            if (
              !(await recordExactOutboundPublicationLink(tx, {
                publication: locked.publication,
                providerMessageId,
              }))
            ) {
              await notifyChatPublicationWork(tx);
              await tx
                .update(chatActions)
                .set({
                  status: "failed",
                  result: {
                    attempts: attempt,
                    code: "slack_file_upload_receipt_message_conflict",
                    retryable: false,
                  },
                  updatedAt: committedAt,
                })
                .where(eq(chatActions.id, selected.id));
              return;
            }
            if (locked.mode === "delivery_unknown") {
              await notifyChatPublicationWork(tx);
              const [settled] = await tx
                .update(chatPublications)
                .set({
                  state: "published",
                  providerMessageId,
                  publishedAt: committedAt,
                  nextAttemptAt: null,
                  redactedError: null,
                  updatedAt: committedAt,
                })
                .where(
                  and(
                    eq(chatPublications.id, locked.publication.id),
                    eq(chatPublications.state, "delivery_unknown"),
                    eq(chatPublications.attempts, payload.publicationAttempt),
                  ),
                )
                .returning({ id: chatPublications.id });
              if (!settled) {
                throw new Error(
                  "Slack file upload publication changed before receipt commit",
                );
              }
              await stageSlackFilePublicationSuccess(tx, {
                committedAt,
                endpoint: locked.endpoint,
                publication: locked.publication,
                providerMessageId,
                runtimeContext: {
                  generation: payload.runtimeGeneration,
                  credentialFingerprint: payload.credentialFingerprint,
                },
                stageSessionSync:
                  !isExplicitOperatorPublication(locked.publication) &&
                  !locked.publication.idempotencyKey.startsWith(
                    "control:status:",
                  ),
              });
            } else {
              await notifyChatPublicationWork(tx);
              const [enriched] = await tx
                .update(chatPublications)
                .set({ providerMessageId })
                .where(
                  and(
                    eq(chatPublications.id, locked.publication.id),
                    eq(chatPublications.state, "published"),
                    eq(chatPublications.attempts, payload.publicationAttempt),
                    isNull(chatPublications.providerMessageId),
                  ),
                )
                .returning({ id: chatPublications.id });
              if (!enriched) {
                throw new Error(
                  "Slack file upload publication changed before identity enrichment",
                );
              }
            }
            await notifyChatPublicationWork(tx);
            await tx
              .update(chatActions)
              .set({
                status: "processed",
                result: {
                  attempts: attempt,
                  code: "slack_file_upload_identity_confirmed",
                },
                updatedAt: committedAt,
              })
              .where(
                and(
                  eq(chatActions.id, selected.id),
                  eq(chatActions.status, "processing"),
                  sql`${chatActions.result}->>'ownerToken' = ${ownerToken}`,
                ),
              );
            await lease.assertOwned(tx);
          });
        });
      } catch (error) {
        const disposition = classifyChatPublicationError(error, attempt);
        const retryable =
          disposition.kind === "retry" ||
          disposition.kind === "delivery_unknown";
        const retryMs =
          disposition.kind === "retry"
            ? disposition.retryAfterMs
            : Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 8));
        await db.transaction(async (tx) => {
          await notifyChatPublicationWork(tx);
          return tx
            .update(chatActions)
            .set({
              status: retryable ? "failed" : "cancelled",
              result: sql`coalesce(${chatActions.result}, '{}'::jsonb) || ${JSON.stringify(
                {
                  attempts: attempt,
                  code: retryable
                    ? "slack_file_upload_receipt_lookup_retry"
                    : "slack_file_upload_receipt_lookup_rejected",
                  retryable,
                  ...(retryable
                    ? { retryAt: new Date(Date.now() + retryMs).toISOString() }
                    : {}),
                },
              )}::jsonb`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, selected.id),
                eq(chatActions.status, "processing"),
                sql`${chatActions.result}->>'ownerToken' = ${ownerToken}`,
              ),
            );
        });
      }
    }
    return processed;
  }

  function slackReceiptEligibility(selectedAt?: Date) {
    return and(
      eq(chatActions.kind, "slack_file_upload_receipt"),
      notExists(
        db
          .select({ id: chatEndpoints.id })
          .from(chatEndpoints)
          .where(
            and(
              eq(chatEndpoints.id, chatActions.endpointId),
              inArray(chatEndpoints.status, ["paused", "attention"]),
            ),
          ),
      ),
      // The normal publication owner is still polling Slack. Receipt
      // recovery must neither contend with it nor let its not-yet-due
      // action occupy the bounded recovery page.
      notExists(
        db
          .select({ id: chatPublications.id })
          .from(chatPublications)
          .where(
            and(
              sql`${chatPublications.id}::text = ${chatActions.payload}->>'publicationId'`,
              sql`${chatPublications.attempts}::text = ${chatActions.payload}->>'publicationAttempt'`,
              eq(chatPublications.state, "streaming"),
            ),
          ),
      ),
      or(
        eq(chatActions.status, "received"),
        and(
          eq(chatActions.status, "failed"),
          sql`coalesce(${chatActions.result}->>'retryable', 'false') = 'true'`,
          selectedAt ? sql`(${chatActions.result}->>'retryAt')::timestamptz <= ${selectedAt.toISOString()}::timestamptz` : sql`${chatActions.result}->>'retryAt' is not null`,
        ),
        and(
          eq(chatActions.status, "processing"),
          selectedAt ? lte(chatActions.updatedAt, new Date(selectedAt.getTime() - SLACK_FILE_RECEIPT_STALE_MS)) : undefined,
        ),
      ),
    );
  }

  async function nextSlackReceiptAt(): Promise<number | null> {
    const [row] = await db.select({ at: sql<string | null>`min(case
      when ${chatActions.status} = 'processing' then ${chatActions.updatedAt} + ${SLACK_FILE_RECEIPT_STALE_MS} * interval '1 millisecond'
      when ${chatActions.status} = 'failed' then (${chatActions.result}->>'retryAt')::timestamptz
      else now() end)` }).from(chatActions).where(slackReceiptEligibility());
    return row?.at == null ? null : new Date(row.at).getTime();
  }
  return { recordSlackFileUploadReceipt, stageSlackFilePublicationSuccess, processPendingSlackFileUploadReceipts, nextSlackReceiptAt };
}
