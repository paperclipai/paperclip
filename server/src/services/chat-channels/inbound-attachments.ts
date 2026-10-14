import type { EndpointRow, DbTransaction, DbOrTransaction, LifecycleRuntimeFence } from "./runtime-types.js";

import type { ChatEndpointRuntime } from "../voice/voice-runtime.js";

import { takePhotonCompanion } from "../photon/attachments.js";

import { HEIF_CONTENT_TYPES, photonHeifPreview, validatePhotonImage } from "../photon/media.js";

import { PhotonError } from "../photon/cloud.js";

import {
  createHash,
} from "node:crypto";
import {
  and,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  assets,
  chatActions,
  chatConversations,
  chatDeliveries,
  issueComments,
  issueAttachments,
} from "@paperclipai/db";

import {
  isAllowedContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeContentType,
  normalizeUploadAttachmentContentType,
} from "../../attachment-types.js";

import {
  hasTelegramMediaProvenance,
  identifyTelegramMedia,
  telegramMediaNeedsIdentification,
} from "../chat-telegram-media-intake.js";

import {
  forbidden,
} from "../../errors.js";
import { logger } from "../../middleware/logger.js";

import type { StorageService } from "../../storage/types.js";

import { issueService } from "../issues.js";

import { isExternalChatWaitAuthorizationContention } from "../native-runtime/chat-attachment-reuse.js";

import {
  GITHUB_ATTACHMENT_BATCH_TIMEOUT_MS,
  GitHubAttachmentUnavailableError,
  prepareGitHubPublicAttachment,
} from "../chat-github-attachments.js";

import type {
  Attachment,
} from "chat";

type DeliveryRow = typeof chatDeliveries.$inferSelect;

type InboundAttachmentsOptions = {
  storage?: StorageService;
  authorizeInboundWakeup: (tx: DbOrTransaction, action: typeof chatActions.$inferSelect) => Promise<{ delivery: DeliveryRow; conversation: typeof chatConversations.$inferSelect }>;
  lifecycleRuntimeFence: (delivery: DeliveryRow) => LifecycleRuntimeFence | null;
  sanitizeFilename: (value: string | undefined) => string | null;
  issuesSvc: Pick<ReturnType<typeof issueService>, "createAttachment">;
  isExternalActionAuthorizationChange: (error: unknown) => boolean;
  redactError: (error: unknown) => string;
};

export function createInboundAttachments(db: Db, options: InboundAttachmentsOptions) {
  const { authorizeInboundWakeup, lifecycleRuntimeFence, sanitizeFilename, issuesSvc, isExternalActionAuthorizationChange, redactError } = options;


  async function ingestAttachments(input: {
    endpoint: EndpointRow;
    endpointRuntime: ChatEndpointRuntime;
    deliveryId: string;
    issueId: string;
    issueCommentId: string;
    attachments: Attachment[];
    attachmentLimitOmissions?: number;
    unavailableReferenceCount?: number;
    actorUserId: string | null;
  }): Promise<{
    storedIds: string[];
    omissionReasons: Record<string, number>;
  }> {
    const omissionReasons: Record<string, number> = {};
    const omit = (reason: string, count = 1) => {
      omissionReasons[reason] = (omissionReasons[reason] ?? 0) + count;
    };
    const boundedAttachments = input.attachments.slice(0, 20);
    const photonDerivatives = new Map<Attachment, { source: Attachment; sourceHash: string; kind: "heif_jpeg_preview" | "live_photo_video" }>();
    const originalPhotonAttachments = new Map<Attachment, string>();
    if (
      input.endpoint.provider === "microsoft-teams" &&
      input.unavailableReferenceCount
    ) {
      // A channel/group reference is not a download capability. Still tell
      // the exact current-turn consumer that those bytes are unavailable,
      // including when there are no ingestible attachments at all.
      omit("download_unavailable", input.unavailableReferenceCount);
    }
    if (
      ["github", "imessage-photon"].includes(input.endpoint.provider) &&
      input.attachmentLimitOmissions
    ) {
      omit("attachment_limit", input.attachmentLimitOmissions);
    }
    if (input.attachments.length > boundedAttachments.length) {
      omit(
        "attachment_limit",
        input.attachments.length - boundedAttachments.length,
      );
    }
    if (!options.storage) {
      if (boundedAttachments.length)
        omit("storage_unavailable", boundedAttachments.length);
      return { storedIds: [], omissionReasons };
    }
    const existingByFingerprint = new Map<string, string[]>();
    const existingAttachments = await db
      .select({
        id: issueAttachments.id,
        byteSize: assets.byteSize,
        contentType: assets.contentType,
        originalFilename: assets.originalFilename,
        sha256: assets.sha256,
      })
      .from(issueAttachments)
      .innerJoin(
        assets,
        and(
          eq(assets.companyId, issueAttachments.companyId),
          eq(assets.id, issueAttachments.assetId),
        ),
      )
      .where(
        and(
          eq(issueAttachments.companyId, input.endpoint.companyId),
          eq(issueAttachments.issueId, input.issueId),
          eq(issueAttachments.issueCommentId, input.issueCommentId),
        ),
      );
    for (const existing of existingAttachments) {
      const fingerprint = JSON.stringify([
        existing.sha256,
        existing.byteSize,
        existing.contentType,
        existing.originalFilename,
      ]);
      const ids = existingByFingerprint.get(fingerprint) ?? [];
      ids.push(existing.id);
      existingByFingerprint.set(fingerprint, ids);
    }
    const storedIds: string[] = [];
    const withCurrentAttachmentAuthorization = async <T>(
      work: (tx: DbTransaction) => Promise<T>,
      enforceUnchangedSource = false,
      telegramMedia?: Attachment,
    ): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await db.transaction(async (tx) => {
            const action = await tx
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.companyId, input.endpoint.companyId),
                  eq(chatActions.endpointId, input.endpoint.id),
                  eq(chatActions.deliveryId, input.deliveryId),
                  eq(chatActions.kind, "inbound_wakeup"),
                ),
              )
              .limit(1)
              .then((rows) => rows[0]);
            if (
              !action ||
              !["preparing", "issued", "processing", "processed"].includes(
                action.status,
              ) ||
              action.payload.issueId !== input.issueId ||
              action.payload.commentId !== input.issueCommentId
            )
              throw forbidden(
                "The attachment's current chat admission is unavailable",
                { code: "chat_action_authorization_changed" },
              );
            const current = await authorizeInboundWakeup(tx, action);
            // Delivery settlement/replay can update these receipts without
            // taking the issue lock. Lock in delivery -> action order only
            // after policy authorization; NOWAIT breaks cross-worker lock
            // inversions and the outer loop retries the whole transaction.
            const lockedDelivery = await tx
              .select()
              .from(chatDeliveries)
              .where(
                and(
                  eq(chatDeliveries.companyId, input.endpoint.companyId),
                  eq(chatDeliveries.id, input.deliveryId),
                ),
              )
              .for("update", { noWait: true })
              .limit(1)
              .then((rows) => rows[0]);
            const lockedAction = await tx
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.companyId, input.endpoint.companyId),
                  eq(chatActions.id, action.id),
                ),
              )
              .for("update", { noWait: true })
              .limit(1)
              .then((rows) => rows[0]);
            const scopeKeys = [
              "version",
              "issueId",
              "commentId",
              "agentId",
              "sessionGeneration",
              "requestedByActorType",
              "requestedByActorId",
            ] as const;
            if (
              current.delivery.state !== "processing" ||
              !lockedDelivery ||
              !lockedAction ||
              lockedDelivery.state !== "processing" ||
              lockedDelivery.endpointId !== action.endpointId ||
              lockedDelivery.conversationId !== action.conversationId ||
              lockedDelivery.principalId !== action.principalId ||
              lockedDelivery.attempts !== current.delivery.attempts ||
              JSON.stringify(lifecycleRuntimeFence(lockedDelivery)) !==
                JSON.stringify(lifecycleRuntimeFence(current.delivery)) ||
              lockedAction.endpointId !== action.endpointId ||
              lockedAction.deliveryId !== action.deliveryId ||
              lockedAction.conversationId !== action.conversationId ||
              lockedAction.principalId !== action.principalId ||
              lockedAction.kind !== "inbound_wakeup" ||
              !["preparing", "issued", "processing", "processed"].includes(
                lockedAction.status,
              ) ||
              scopeKeys.some(
                (key) => lockedAction.payload[key] !== action.payload[key],
              )
            )
              throw forbidden(
                "The attachment's current chat admission is unavailable",
                { code: "chat_action_authorization_changed" },
              );
            if (enforceUnchangedSource) {
              if (telegramMedia) {
                const normalized = lockedDelivery.normalizedEvent as {
                  principal?: { externalId?: string };
                  message?: {
                    providerMessageId?: string;
                    attachments?: Array<{ recovery?: unknown }>;
                  };
                };
                const fence = lifecycleRuntimeFence(lockedDelivery);
                const descriptor =
                  input.endpointRuntime.attachmentRecoveryDescriptor(
                    telegramMedia,
                    {
                      threadId: current.conversation.externalThreadId,
                      messageId: normalized.message?.providerMessageId ?? "",
                      principalExternalId: normalized.principal?.externalId,
                      runtimeGeneration: fence?.generation,
                      credentialFingerprint: fence?.credentialFingerprint,
                    },
                  );
                if (
                  descriptor?.locator.kind !== "telegram_media" ||
                  !normalized.message?.attachments?.some((item) => {
                    const retained = item.recovery as {
                      version?: unknown;
                      provider?: unknown;
                      locator?: Record<string, unknown>;
                      attachment?: Record<string, unknown>;
                    } | null;
                    return (
                      retained?.version === 1 &&
                      retained.provider === "telegram" &&
                      Object.entries(descriptor.locator).every(
                        ([key, value]) => retained.locator?.[key] === value,
                      ) &&
                      Object.entries(descriptor.attachment).every(
                        ([key, value]) => retained.attachment?.[key] === value,
                      )
                    );
                  })
                )
                  throw forbidden(
                    "The media's admitted source is unavailable",
                    { code: "chat_action_authorization_changed" },
                  );
              }
              const [source] = await tx
                .select({ id: issueComments.id })
                .from(issueComments)
                .where(
                  and(
                    eq(issueComments.companyId, input.endpoint.companyId),
                    eq(issueComments.issueId, input.issueId),
                    eq(issueComments.id, input.issueCommentId),
                    isNull(issueComments.deletedAt),
                    sql`${issueComments.updatedAt} = ${issueComments.createdAt}`,
                  ),
                )
                .for("share", { noWait: true });
              // Lifecycle admission precedes its conversation drain. Pending
              // source changes already invalidate this image download, even
              // when the append-only original comment is still untouched.
              const [lifecycle] = await tx
                .select({ id: chatDeliveries.id })
                .from(chatDeliveries)
                .where(
                  and(
                    eq(chatDeliveries.companyId, input.endpoint.companyId),
                    eq(chatDeliveries.endpointId, input.endpoint.id),
                    or(
                      isNull(chatDeliveries.conversationId),
                      eq(
                        chatDeliveries.conversationId,
                        current.conversation.id,
                      ),
                    ),
                    ne(chatDeliveries.state, "filtered"),
                    inArray(chatDeliveries.eventKind, [
                      "message_updated",
                      "message_deleted",
                      "message_restored",
                    ]),
                    sql`${chatDeliveries.normalizedEvent}->'runtimeContext' = ${JSON.stringify(lifecycleRuntimeFence(lockedDelivery))}::jsonb`,
                    sql`${chatDeliveries.normalizedEvent}->'message'->>'targetProviderEventId' = ${lockedDelivery.providerEventId}`,
                  ),
                )
                .limit(1);
              if (!source || lifecycle)
                throw forbidden(
                  "The image's admitted source changed before attachment registration",
                  {
                    code: "chat_action_authorization_changed",
                  },
                );
            }
            return await work(tx);
          });
        } catch (error) {
          if (!isExternalChatWaitAuthorizationContention(error) || attempt >= 4)
            throw error;
          // Retry the complete short transaction; no network/storage work or
          // backoff occurs while governance rows are locked.
          await new Promise((resolve) =>
            setTimeout(resolve, 20 * (attempt + 1)),
          );
        }
      }
    };
    // One shared deadline bounds the sequential batch; an expired batch never
    // starts another GitHub request. Other providers retain their own policy.
    const githubBatchSignal =
      input.endpoint.provider === "github"
        ? AbortSignal.timeout(GITHUB_ATTACHMENT_BATCH_TIMEOUT_MS)
        : undefined;
    // This new image-only lane shares one budget across token acquisition and
    // downloads. DB/storage commit semantics remain explicit and unchanged.
    const teamsInlineBatchSignal =
      input.endpoint.provider === "microsoft-teams"
        ? AbortSignal.timeout(10_000)
        : undefined;
    for (let attachment of boundedAttachments) {
      const teamsInlineImage =
        input.endpoint.provider === "microsoft-teams" &&
        input.endpointRuntime.attachmentRecoveryDescriptor(attachment)?.locator
          .kind === "teams_inline_image";
      const telegramMedia =
        input.endpoint.provider === "telegram" &&
        hasTelegramMediaProvenance(attachment);
      const sourceBoundMedia =
        teamsInlineImage ||
        telegramMedia ||
        input.endpoint.provider === "imessage-photon";
      const requireCurrentAttachmentAuthorization =
        input.endpoint.provider === "github" || sourceBoundMedia;
      try {
        if (teamsInlineImage && teamsInlineBatchSignal?.aborted) {
          omit("download_unavailable");
          continue;
        }
        // GitHub's anonymized upload URLs carry no trustworthy MIME metadata.
        // Resolve public bytes only here, after durable comment admission, and
        // then apply the same storage/type policy as every native attachment.
        if (input.endpoint.provider === "github") {
          await withCurrentAttachmentAuthorization(async () => {});
          attachment = await prepareGitHubPublicAttachment(
            attachment,
            githubBatchSignal,
            async (request, signal) => {
              await withCurrentAttachmentAuthorization(async () => {});
              return (
                (await input.endpointRuntime.resolveGitHubAttachmentComment?.(
                  request,
                  signal,
                )) ?? null
              );
            },
          );
        }
        if (
          requireCurrentAttachmentAuthorization &&
          input.endpoint.provider !== "github"
        )
          await withCurrentAttachmentAuthorization(
            async () => {},
            sourceBoundMedia,
            telegramMedia ? attachment : undefined,
          );
        if (
          attachment.size !== undefined &&
          attachment.size > MAX_ATTACHMENT_BYTES
        ) {
          omit("declared_too_large");
          continue;
        }
        if (!attachment.fetchData) {
          omit("download_unavailable");
          continue;
        }
        const originalFilename = sanitizeFilename(attachment.name);
        let contentType = normalizeUploadAttachmentContentType({
          contentType: normalizeContentType(
            attachment.mimeType ?? "application/octet-stream",
          ),
          originalFilename,
          isAllowedContentType,
        });
        // Reject a provider-declared type before allocating the downloaded
        // payload. The actual byte length is checked again after the adapter's
        // bounded fetch contract resolves.
        // A filename may infer an Office MIME for ordinary documents, but it
        // must not bypass byte identification for native media without MIME.
        const identifyTelegram =
          telegramMedia &&
          telegramMediaNeedsIdentification(attachment) &&
          normalizeContentType(
            attachment.mimeType ?? "application/octet-stream",
          ) === "application/octet-stream";
        if (!isAllowedContentType(contentType) && !identifyTelegram) {
          omit("unsupported_type");
          continue;
        }
        const fetched = teamsInlineImage
          ? await input.endpointRuntime.fetchTeamsInlineImage(
              attachment,
              teamsInlineBatchSignal!,
            )
          : await attachment.fetchData();
        const body = Buffer.isBuffer(fetched) ? fetched : Buffer.from(fetched);
        if (body.length === 0) {
          omit("empty_download");
          continue;
        }
        if (body.length > MAX_ATTACHMENT_BYTES) {
          omit("downloaded_too_large");
          continue;
        }
        if (identifyTelegram) {
          contentType =
            identifyTelegramMedia(attachment, body) ??
            "application/octet-stream";
          if (!isAllowedContentType(contentType)) {
            omit("unsupported_type");
            continue;
          }
        }
        const photonSourceHash = createHash("sha256")
          .update(body)
          .digest("hex");
        if (input.endpoint.provider === "imessage-photon") {
          await validatePhotonImage(body, contentType);
          const companion = takePhotonCompanion(body);
          if (companion?.unavailable) omit("companion_unavailable");
          else if (companion) {
            const video: Attachment = { type: "video", name: companion.fileName, mimeType: companion.mimeType, size: companion.data.length, fetchData: async () => companion.data };
            photonDerivatives.set(video, { source: attachment, sourceHash: photonSourceHash, kind: "live_photo_video" });
            boundedAttachments.push(video);
          }
          if (
            HEIF_CONTENT_TYPES.has(contentType) &&
            isAllowedContentType("image/jpeg")
          ) {
            try {
              const preview = await photonHeifPreview(body);
              const derivative: Attachment = {
                type: "image",
                name: `${originalFilename} (JPEG preview).jpg`,
                mimeType: "image/jpeg",
                size: preview.length,
                fetchData: async () => preview,
              };
              photonDerivatives.set(derivative, { source: attachment, sourceHash: photonSourceHash, kind: "heif_jpeg_preview" });
              boundedAttachments.push(derivative);
            } catch {
              omit("preview_unavailable");
            }
          }
        }
        const fingerprint = JSON.stringify([
          photonSourceHash,
          body.length,
          contentType,
          originalFilename,
        ]);
        const existingIds = existingByFingerprint.get(fingerprint);
        const existingId = existingIds?.shift();
        if (requireCurrentAttachmentAuthorization) {
          // Revoke during either API resolution or the anonymous byte download
          // must prevent storage and attachment registration for that input.
          await withCurrentAttachmentAuthorization(
            async () => {},
            sourceBoundMedia,
            telegramMedia ? attachment : undefined,
          );
        }
        const registerPhotonProvenance = async (attachmentId: string) => {
          if (input.endpoint.provider !== "imessage-photon") return;
          const relation = photonDerivatives.get(attachment);
          if (!relation) {
            originalPhotonAttachments.set(attachment, attachmentId);
            return;
          }
          const originalAttachmentId =
            originalPhotonAttachments.get(relation.source);
          if (!originalAttachmentId)
            throw new Error("Photon related attachment source is missing");
          await db
            .insert(chatActions)
            .values({
              companyId: input.endpoint.companyId,
              endpointId: input.endpoint.id,
              deliveryId: input.deliveryId,
              kind: relation.kind === "heif_jpeg_preview" ? "attachment_derivative" : "attachment_companion",
              providerActionId: `photon-${relation.kind}:${input.deliveryId}:${originalAttachmentId}`,
              payload: {
                originalAttachmentId,
                derivativeAttachmentId: attachmentId,
                originalSha256: relation.sourceHash,
                derivativeSha256: photonSourceHash,
                kind: relation.kind,
              },
              status: "processed",
            })
            .onConflictDoNothing();
        };
        if (existingId) {
          storedIds.push(existingId);
          await registerPhotonProvenance(existingId);
          continue;
        }
        const stored = await options.storage.putFile({
          companyId: input.endpoint.companyId,
          namespace: `issues/${input.issueId}`,
          originalFilename,
          contentType,
          body,
        });
        const registration = {
          issueId: input.issueId,
          issueCommentId: input.issueCommentId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByUserId: input.actorUserId,
        };
        let row;
        try {
          row = requireCurrentAttachmentAuthorization
            ? await withCurrentAttachmentAuthorization(
                (tx) =>
                  issueService(tx as unknown as Db).createAttachment(
                    registration,
                  ),
                sourceBoundMedia,
                telegramMedia ? attachment : undefined,
              )
            : await issuesSvc.createAttachment(registration);
        } catch (error) {
          // An explicit authorization denial happens before registration. Do
          // not delete on ambiguous database errors which may have committed.
          if (
            requireCurrentAttachmentAuthorization &&
            isExternalActionAuthorizationChange(error)
          )
            await options.storage
              .deleteObject(input.endpoint.companyId, stored.objectKey)
              .catch(() => undefined);
          throw error;
        }
        storedIds.push(row.id);
        await registerPhotonProvenance(row.id);
      } catch (error) {
        if (isExternalActionAuthorizationChange(error)) throw error;
        if (
          error instanceof PhotonError &&
          ["attachment_not_ready", "network", "quota", "credentials"].includes(
            error.code,
          )
        )
          throw error;
        // Use the closed current-input omission vocabulary consumed by native
        // prompts; provider-specific diagnostics remain redacted log codes.
        omit(
          error instanceof GitHubAttachmentUnavailableError
            ? "download_unavailable"
            : "processing_failed",
        );
        // A malformed or unavailable provider attachment must not strand the
        // durable text delivery. The rejected file is intentionally omitted;
        // the delivery remains auditable through its normalized attachment
        // metadata without persisting provider credentials or download URLs.
        logger.warn(
          {
            endpointId: input.endpoint.id,
            issueId: input.issueId,
            ...(error instanceof GitHubAttachmentUnavailableError
              ? {
                  deliveryId: input.deliveryId,
                  attachmentDiagnosticCode: error.code,
                }
              : {}),
            attachmentName: sanitizeFilename(attachment.name),
            error: redactError(error),
          },
          "external chat attachment was rejected",
        );
      }
    }
    return { storedIds, omissionReasons };
  }

  function attachmentOmissionDetail(result: {
    omissionReasons: Record<string, number>;
  }): string | null {
    const entries = Object.entries(result.omissionReasons).filter(
      ([, count]) => count > 0,
    );
    const omitted = entries.reduce((total, [, count]) => total + count, 0);
    if (!omitted) return null;
    const reasons = entries
      .map(([reason, count]) => `${reason.replaceAll("_", " ")}: ${count}`)
      .join(", ");
    return `${omitted} external attachment${omitted === 1 ? " was" : "s were"} omitted (${reasons})`;
  }
  return { ingestAttachments, attachmentOmissionDetail };
}
