import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { buildDocumentFilename } from "../lib/document-filenames.js";
import { resolveDocumentTitle } from "../lib/document-titles.js";
import type { StorageService } from "../storage/types.js";
import type {
  AwaitingHumanNotificationPayload,
  AwaitingHumanNotificationReviewFile,
} from "./awaiting-human-notifications.js";

function toRowArray<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sha256Hex(body: Buffer) {
  return createHash("sha256").update(body).digest("hex");
}

function resolveAbsoluteUrl(pathOrUrl: string, sourceLink: string) {
  try {
    return new URL(pathOrUrl).toString();
  } catch {
    // Continue below.
  }

  try {
    return new URL(pathOrUrl, sourceLink).toString();
  } catch {
    return pathOrUrl;
  }
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeReviewFile(value: unknown): AwaitingHumanNotificationReviewFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const source = row.source === "artifact" || row.source === "document" ? row.source : null;
  const deliverableId = readString(row.deliverableId);
  const title = readString(row.title);
  const filename = readString(row.filename);
  const contentType = readString(row.contentType);
  const contentPath = readString(row.contentPath);
  const deliverableUrl = readString(row.deliverableUrl);
  const byteSize = typeof row.byteSize === "number" && Number.isFinite(row.byteSize) ? row.byteSize : null;
  if (!source || !deliverableId || !title || !filename || !contentType || !contentPath || !deliverableUrl || byteSize === null) {
    return null;
  }
  return {
    source,
    deliverableId,
    title,
    filename,
    contentType,
    byteSize,
    contentPath,
    deliverableUrl,
    clickupTaskUrl: readString(row.clickupTaskUrl),
    clickupAttachmentId: readString(row.clickupAttachmentId),
    clickupAttachmentUrl: readString(row.clickupAttachmentUrl),
    attachmentId: readString(row.attachmentId),
    objectKey: readString(row.objectKey),
    sha256: readString(row.sha256),
  };
}

export async function resolveAwaitingHumanReviewFile(
  db: Db,
  input: { companyId: string; issueId: string; sourceLink: string },
): Promise<AwaitingHumanNotificationReviewFile | null> {
  const artifactRows = await db.execute<{
    deliverable_id: string;
    title: string;
    content_path: string;
    content_type: string;
    byte_size: number;
    original_filename: string | null;
    attachment_id: string | null;
    object_key: string | null;
    sha256: string | null;
  }>(sql`
    SELECT
      wp.id AS deliverable_id,
      wp.title,
      wp.metadata ->> 'contentPath' AS content_path,
      wp.metadata ->> 'contentType' AS content_type,
      COALESCE(NULLIF(wp.metadata ->> 'byteSize', '')::integer, a.byte_size, 0) AS byte_size,
      COALESCE(wp.metadata ->> 'originalFilename', a.original_filename, 'deliverable') AS original_filename,
      wp.metadata ->> 'attachmentId' AS attachment_id,
      a.object_key,
      a.sha256
    FROM issue_work_products wp
    LEFT JOIN issue_attachments ia ON ia.id::text = wp.metadata ->> 'attachmentId'
    LEFT JOIN assets a ON a.id = ia.asset_id
    WHERE wp.company_id = ${input.companyId}
      AND wp.issue_id = ${input.issueId}
      AND wp.type = 'artifact'
      AND COALESCE(wp.audience, 'human') = 'human'
      AND wp.metadata ->> 'contentPath' IS NOT NULL
    ORDER BY
      CASE
        WHEN wp.review_state = 'needs_board_review' THEN 0
        WHEN wp.status = 'ready_for_review' THEN 1
        WHEN wp.status = 'active' THEN 2
        ELSE 3
      END,
      wp.is_primary DESC,
      wp.updated_at DESC
    LIMIT 1
  `);
  const artifact = toRowArray<{
    deliverable_id: string;
    title: string;
    content_path: string;
    content_type: string;
    byte_size: number;
    original_filename: string | null;
    attachment_id: string | null;
    object_key: string | null;
    sha256: string | null;
  }>(artifactRows)[0];
  if (artifact?.content_path && artifact.content_type) {
    return {
      source: "artifact",
      deliverableId: artifact.deliverable_id,
      title: artifact.title,
      filename: artifact.original_filename?.trim() || "deliverable",
      contentType: artifact.content_type,
      byteSize: Number(artifact.byte_size) || 0,
      contentPath: artifact.content_path,
      deliverableUrl: resolveAbsoluteUrl(artifact.content_path, input.sourceLink),
      attachmentId: artifact.attachment_id,
      objectKey: artifact.object_key,
      sha256: artifact.sha256,
    };
  }

  const documentRows = await db.execute<{
    deliverable_id: string;
    key: string;
    title: string | null;
    format: string;
    body: string | null;
    byte_size: number;
  }>(sql`
    SELECT
      idoc.id AS deliverable_id,
      idoc.key,
      d.title,
      d.format,
      d.latest_body AS body,
      COALESCE(octet_length(d.latest_body), 0)::integer AS byte_size
    FROM issue_documents idoc
    JOIN documents d ON d.id = idoc.document_id
    WHERE idoc.company_id = ${input.companyId}
      AND idoc.issue_id = ${input.issueId}
      AND COALESCE(idoc.audience, 'human') = 'human'
      AND idoc.key <> 'continuation-summary'
    ORDER BY d.updated_at DESC, idoc.updated_at DESC
    LIMIT 1
  `);
  const document = toRowArray<{
    deliverable_id: string;
    key: string;
    title: string | null;
    format: string;
    body: string | null;
    byte_size: number;
  }>(documentRows)[0];
  if (!document) return null;
  const key = document.key?.trim() || "document";
  const contentPath = `/api/deliverables/${document.deliverable_id}/content`;
  return {
    source: "document",
    deliverableId: document.deliverable_id,
    title: resolveDocumentTitle(document.title, document.format, document.body) ?? key,
    filename: buildDocumentFilename(document.key, document.title, document.format, document.body),
    contentType: document.format === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    byteSize: Number(document.byte_size) || 0,
    contentPath,
    deliverableUrl: resolveAbsoluteUrl(contentPath, input.sourceLink),
  };
}

export async function readAwaitingHumanReviewFileBody(
  db: Db,
  storage: StorageService,
  companyId: string,
  reviewFile: AwaitingHumanNotificationReviewFile,
) {
  if (reviewFile.source === "artifact") {
    if (!reviewFile.objectKey) throw new Error("review artifact is missing object key");
    const object = await storage.getObject(companyId, reviewFile.objectKey);
    const body = await readStreamToBuffer(object.stream);
    return {
      body,
      sha256: reviewFile.sha256 ?? sha256Hex(body),
    };
  }

  const rows = await db.execute<{ body: string }>(sql`
    SELECT d.latest_body AS body
    FROM issue_documents idoc
    JOIN documents d ON d.id = idoc.document_id
    WHERE idoc.id = ${reviewFile.deliverableId}
      AND idoc.company_id = ${companyId}
    LIMIT 1
  `);
  const body = Buffer.from(toRowArray<{ body: string }>(rows)[0]?.body ?? "", "utf8");
  return {
    body,
    sha256: sha256Hex(body),
  };
}

export function withClickUpTaskUrl(
  notification: AwaitingHumanNotificationPayload,
  reviewFile: AwaitingHumanNotificationReviewFile | null,
  clickupTaskUrl: string | null,
  clickupAttachmentId: string | null,
) {
  if (!reviewFile) return notification;
  return {
    ...notification,
    reviewFile: {
      ...reviewFile,
      clickupTaskUrl,
      clickupAttachmentId,
    },
  };
}
