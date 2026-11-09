import {
  createHash,
} from "node:crypto";
import {
  and,
  eq,
  inArray,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  assets,
  chatPublications,
  issueAttachments,
} from "@paperclipai/db";
import type {
  SafeChatPublicationPayload,
} from "@paperclipai/shared";

import {
  isAllowedContentType,
  MAX_ATTACHMENT_BYTES,
} from "../../attachment-types.js";

import type { StorageService } from "../../storage/types.js";

import {
  isTeamsInlineImageContentType,
  TEAMS_INLINE_IMAGE_MAX_BYTES,
} from "../chat-teams-inline-images.js";

import type {
  FileUpload,
} from "chat";

const OUTBOUND_ATTACHMENT_STORAGE_TIMEOUT_MS = 10_000;

class OutboundAttachmentHydrationError extends Error {
  readonly code = "CHAT_ATTACHMENT_HYDRATION_FAILED";

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OutboundAttachmentHydrationError";
  }
}

class OutboundAttachmentValidationError extends Error {
  readonly code = "CHAT_ATTACHMENT_VALIDATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "OutboundAttachmentValidationError";
  }
}

function isOutboundAttachmentHydrationError(
  error: unknown,
): error is OutboundAttachmentHydrationError {
  return error instanceof OutboundAttachmentHydrationError;
}

function isOutboundAttachmentValidationError(
  error: unknown,
): error is OutboundAttachmentValidationError {
  return error instanceof OutboundAttachmentValidationError;
}

/**
 * Read one already-authorized attachment before any provider transport starts.
 * The database digest, rather than mutable object-store metadata, is the
 * integrity boundary. Both acquisition and streaming are bounded so a stuck
 * storage backend cannot hold the publication lane indefinitely.
 */
export async function hydrateOutboundAttachment(input: {
  storage: StorageService;
  companyId: string;
  objectKey: string;
  byteSize: number;
  sha256: string;
  filename: string;
  mimeType: string;
  timeoutMs?: number;
}): Promise<FileUpload> {
  const timeoutMs =
    typeof input.timeoutMs === "number" &&
    Number.isFinite(input.timeoutMs) &&
    input.timeoutMs > 0
      ? input.timeoutMs
      : OUTBOUND_ATTACHMENT_STORAGE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(input.byteSize) ||
    input.byteSize <= 0 ||
    input.byteSize > MAX_ATTACHMENT_BYTES ||
    !/^[0-9a-f]{64}$/iu.test(input.sha256)
  ) {
    throw new OutboundAttachmentHydrationError(
      "Chat publication attachment metadata is invalid",
    );
  }
  const acquisitionTimeoutError = new OutboundAttachmentHydrationError(
    "Chat publication attachment storage read timed out",
  );
  let acquisitionTimedOut = false;
  let rejectAcquisition!: (error: Error) => void;
  const acquisitionTimeout = new Promise<never>((_resolve, reject) => {
    rejectAcquisition = reject;
  });
  const acquisitionTimer = setTimeout(() => {
    acquisitionTimedOut = true;
    rejectAcquisition(acquisitionTimeoutError);
  }, timeoutMs);
  acquisitionTimer.unref?.();
  const objectPromise = Promise.resolve()
    .then(() => input.storage.getObject(input.companyId, input.objectKey))
    .then((object) => {
      if (acquisitionTimedOut) object.stream.destroy();
      return object;
    })
    .catch((error) => {
      throw isOutboundAttachmentHydrationError(error)
        ? error
        : new OutboundAttachmentHydrationError(
            "Chat publication attachment storage read failed",
            error,
          );
    });
  let object: Awaited<ReturnType<StorageService["getObject"]>>;
  try {
    object = await Promise.race([objectPromise, acquisitionTimeout]);
  } finally {
    clearTimeout(acquisitionTimer);
  }

  if (
    object.contentLength !== undefined &&
    object.contentLength !== input.byteSize
  ) {
    object.stream.destroy();
    throw new OutboundAttachmentHydrationError(
      "Chat publication attachment size changed after registration",
    );
  }

  const streamTimeoutError = new OutboundAttachmentHydrationError(
    "Chat publication attachment storage read timed out",
  );
  const streamTimer = setTimeout(() => {
    object.stream.destroy(streamTimeoutError);
  }, timeoutMs);
  streamTimer.unref?.();
  const chunks: Buffer[] = [];
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of object.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > input.byteSize || bytes > MAX_ATTACHMENT_BYTES) {
        object.stream.destroy();
        throw new OutboundAttachmentHydrationError(
          "Chat publication attachment exceeded its streaming byte limit",
        );
      }
      digest.update(buffer);
      chunks.push(buffer);
    }
  } catch (error) {
    throw isOutboundAttachmentHydrationError(error)
      ? error
      : new OutboundAttachmentHydrationError(
          "Chat publication attachment storage read failed",
          error,
        );
  } finally {
    clearTimeout(streamTimer);
  }

  const actualDigest = digest.digest("hex");
  if (bytes !== input.byteSize || actualDigest !== input.sha256.toLowerCase()) {
    if (!object.stream.destroyed) object.stream.destroy();
    throw new OutboundAttachmentHydrationError(
      "Chat publication attachment integrity changed after registration",
    );
  }

  return {
    data: Buffer.concat(chunks, bytes),
    filename: input.filename,
    mimeType: input.mimeType,
  };
}
export { isOutboundAttachmentHydrationError, isOutboundAttachmentValidationError };

type OutboundAttachmentsOptions = { storage?: StorageService; };

export function createOutboundAttachments(db: Db, options: OutboundAttachmentsOptions) {



  async function publicationFiles(
    publication: typeof chatPublications.$inferSelect,
    payload: SafeChatPublicationPayload,
    preparation: { teamsInlineImagesOnly?: boolean } = {},
  ): Promise<FileUpload[]> {
    if (!payload.attachmentIds?.length) return [];
    try {
      const rows = await db
        .select({
          id: issueAttachments.id,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(
          and(
            eq(issueAttachments.companyId, publication.companyId),
            eq(issueAttachments.issueId, publication.issueId),
            inArray(issueAttachments.id, payload.attachmentIds),
          ),
        );
      const byId = new Map(rows.map((row) => [row.id, row]));
      const orderedRows = payload.attachmentIds.map((attachmentId) => {
        const row = byId.get(attachmentId);
        if (
          !row ||
          (publication.commentId &&
            row.issueCommentId !== publication.commentId) ||
          row.byteSize <= 0 ||
          row.byteSize > MAX_ATTACHMENT_BYTES ||
          !row.objectKey.trim() ||
          !/^[0-9a-f]{64}$/iu.test(row.sha256) ||
          !isAllowedContentType(row.contentType)
        )
          throw new OutboundAttachmentValidationError(
            "Chat publication attachment is invalid or outside its authorized task comment",
          );
        return row;
      });
      // Picture messages have a different Teams contract from arbitrary files.
      // Preserve the normal scope/metadata checks above, but never hydrate a
      // document or oversized image just to discover it needs a task link.
      if (
        preparation.teamsInlineImagesOnly &&
        orderedRows.some(
          (row) =>
            row.byteSize > TEAMS_INLINE_IMAGE_MAX_BYTES ||
            !isTeamsInlineImageContentType(row.contentType),
        )
      ) {
        return [];
      }
      // Authorization and persisted metadata must fail definitively even when
      // storage is unavailable; do not mask an invalid file as a transient outage.
      if (!options.storage)
        throw new OutboundAttachmentHydrationError(
          "Attachment storage is unavailable for chat publication",
        );
      const files: FileUpload[] = [];
      for (const row of orderedRows) {
        files.push(
          await hydrateOutboundAttachment({
            storage: options.storage,
            companyId: publication.companyId,
            objectKey: row.objectKey,
            byteSize: row.byteSize,
            sha256: row.sha256,
            filename: row.originalFilename ?? `attachment-${row.id}`,
            mimeType: row.contentType,
          }),
        );
      }
      return files;
    } catch (error) {
      if (
        isOutboundAttachmentHydrationError(error) ||
        isOutboundAttachmentValidationError(error)
      ) {
        throw error;
      }
      throw new OutboundAttachmentHydrationError(
        "Chat publication attachment preparation failed",
        error,
      );
    }
  }
  return { publicationFiles };
}
