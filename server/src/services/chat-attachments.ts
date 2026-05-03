import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatAttachments, chatSessions } from "@paperclipai/db";
import { forbidden, notFound, badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { resolveClippyAttachmentDir } from "../home-paths.js";
import {
  isAllowedContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeContentType,
} from "../attachment-types.js";

export type ChatAttachmentKind = "image" | "file";

export interface ChatAttachment {
  id: string;
  sessionId: string;
  boardUserId: string;
  kind: ChatAttachmentKind;
  mediaType: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  createdAt: string;
}

export interface ChatAttachmentSummary {
  id: string;
  sessionId: string;
  kind: ChatAttachmentKind;
  mediaType: string;
  name: string;
  sizeBytes: number;
  url: string;
}

function rowToAttachment(
  row: typeof chatAttachments.$inferSelect,
): ChatAttachment {
  return {
    id: row.id,
    sessionId: row.sessionId,
    boardUserId: row.boardUserId,
    kind: row.kind as ChatAttachmentKind,
    mediaType: row.mediaType,
    name: row.name,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    storagePath: row.storagePath,
    createdAt: row.createdAt.toISOString(),
  };
}

export function attachmentDownloadUrl(id: string): string {
  return `/api/chat/attachments/${id}/content`;
}

export function attachmentSummary(att: ChatAttachment): ChatAttachmentSummary {
  return {
    id: att.id,
    sessionId: att.sessionId,
    kind: att.kind,
    mediaType: att.mediaType,
    name: att.name,
    sizeBytes: att.sizeBytes,
    url: attachmentDownloadUrl(att.id),
  };
}

export interface UploadInput {
  sessionId: string;
  boardUserId: string;
  buffer: Buffer;
  mediaType: string;
  originalName: string;
}

export function chatAttachmentService(db: Db) {
  async function ensureSessionOwned(sessionId: string, boardUserId: string) {
    const row = await db
      .select({ id: chatSessions.id, boardUserId: chatSessions.boardUserId })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound(`Chat session ${sessionId} not found`);
    if (row.boardUserId !== boardUserId) {
      throw forbidden("Not your chat session");
    }
  }

  async function upload(input: UploadInput): Promise<ChatAttachment> {
    const mediaType = normalizeContentType(input.mediaType);
    if (input.buffer.length === 0) {
      throw badRequest("Attachment is empty");
    }
    if (input.buffer.length > MAX_ATTACHMENT_BYTES) {
      throw badRequest(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    if (!isAllowedContentType(mediaType)) {
      throw badRequest(`Unsupported attachment type: ${mediaType}`);
    }

    await ensureSessionOwned(input.sessionId, input.boardUserId);

    const dir = resolveClippyAttachmentDir(input.sessionId);
    await fs.mkdir(dir, { recursive: true });

    const sha256 = createHash("sha256").update(input.buffer).digest("hex");
    // We pre-mint the id so the on-disk filename matches the row id, which
    // makes cleanup and audit trivial. The DB then uses the same id.
    const id = crypto.randomUUID();
    const storagePath = path.join(dir, id);
    await fs.writeFile(storagePath, input.buffer);

    const kind: ChatAttachmentKind = mediaType.startsWith("image/") ? "image" : "file";
    try {
      const created = await db
        .insert(chatAttachments)
        .values({
          id,
          sessionId: input.sessionId,
          boardUserId: input.boardUserId,
          kind,
          mediaType,
          name: input.originalName.slice(0, 255) || (kind === "image" ? "image" : "file"),
          sizeBytes: input.buffer.length,
          sha256,
          storagePath,
        })
        .returning()
        .then((rows) => rows[0]);
      return rowToAttachment(created);
    } catch (err) {
      // If the DB insert fails, don't leak the file on disk.
      await fs.rm(storagePath, { force: true }).catch(() => {});
      throw err;
    }
  }

  async function getById(id: string): Promise<ChatAttachment | null> {
    const row = await db
      .select()
      .from(chatAttachments)
      .where(eq(chatAttachments.id, id))
      .then((r) => r[0] ?? null);
    return row ? rowToAttachment(row) : null;
  }

  async function getOwnedById(id: string, boardUserId: string): Promise<ChatAttachment> {
    const att = await getById(id);
    if (!att) throw notFound(`Attachment ${id} not found`);
    if (att.boardUserId !== boardUserId) {
      throw forbidden("Not your attachment");
    }
    return att;
  }

  async function listForSession(sessionId: string, boardUserId: string): Promise<ChatAttachment[]> {
    await ensureSessionOwned(sessionId, boardUserId);
    const rows = await db
      .select()
      .from(chatAttachments)
      .where(eq(chatAttachments.sessionId, sessionId));
    return rows.map(rowToAttachment);
  }

  async function findByIdsForSession(
    ids: string[],
    sessionId: string,
    boardUserId: string,
  ): Promise<ChatAttachment[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .select()
      .from(chatAttachments)
      .where(and(inArray(chatAttachments.id, ids), eq(chatAttachments.sessionId, sessionId)));
    const result = rows.map(rowToAttachment);
    // Make sure every attachment really belongs to this user.
    for (const att of result) {
      if (att.boardUserId !== boardUserId) {
        throw forbidden("Not your attachment");
      }
    }
    return result;
  }

  /**
   * Best-effort cleanup of all on-disk attachments for a session. Called
   * when the session is deleted; the CASCADE drops the rows themselves.
   */
  async function removeAllForSession(sessionId: string): Promise<void> {
    let dir: string;
    try {
      dir = resolveClippyAttachmentDir(sessionId);
    } catch {
      return;
    }
    await fs.rm(dir, { recursive: true, force: true }).catch((err) => {
      logger.warn({ err, sessionId }, "failed to remove chat attachment dir");
    });
  }

  /**
   * Read the raw bytes for an attachment. Caller is responsible for
   * authorising access (use {@link getOwnedById} or {@link findByIdsForSession}).
   */
  async function readContent(att: ChatAttachment): Promise<Buffer> {
    return fs.readFile(att.storagePath);
  }

  return {
    upload,
    getById,
    getOwnedById,
    listForSession,
    findByIdsForSession,
    removeAllForSession,
    readContent,
  };
}

export type ChatAttachmentService = ReturnType<typeof chatAttachmentService>;
