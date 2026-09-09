import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { assetService } from "./assets.js";
import { logActivity } from "./activity-log.js";
import { getStorageService, type StorageService } from "../storage/index.js";

// Spill store for oversized wake text, borrowed from the DeepSeek Harness
// `spill` capability family (packages/spill/*): full text is stored once in
// the existing asset blob store and replaced inline by a bounded preview
// plus a locator notice with retrieval guidance.
//
// Measurement contract: everything is UTF-16 code units, matching the
// heartbeat caller that truncates with `String.length`. Preview splits stay
// code-point safe so surrogate pairs never break. The returned body always
// satisfies `body.length <= maxInlineChars`, so the caller can subtract it
// from the shared comment allowance without going negative.
//
// Deduplication: spill assets are content-addressed, and the creating
// activity row records comment id plus content hash. A repeat wake for
// unchanged text reuses the existing asset instead of writing again.
//
// Fail-safe throughout: any storage failure keeps the original text, never
// an error, and partial writes are unwound best-effort in reverse order.

export const WAKE_SPILL_NAMESPACE = "spill";
export const WAKE_SPILL_CONTENT_TYPE = "text/plain; charset=utf-8";
export const WAKE_SPILL_MIN_INLINE_CHARS = 256;
export const SPILL_BODY_SEPARATOR = "\n\n";

// Asset ids are UUIDs; the estimate below always covers the real notice.
const MAX_ASSET_ID_CHARS = 36;

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface SpillPreview {
  preview: string;
  omittedBytes: number;
}

/**
 * Split text into a head/tail preview that fits `budgetChars` UTF-16 code
 * units including the separator. Splits fall on code-point boundaries; the
 * tail shrinks first so the head (usually the most informative part) wins.
 */
export function buildSpillPreview(text: string, budgetChars: number): SpillPreview {
  if (text.length <= budgetChars) {
    return { preview: text, omittedBytes: 0 };
  }
  const points = [...text];
  const marker = "\n…\n";
  const textBudget = Math.max(0, budgetChars - marker.length);
  let headCount = Math.ceil(textBudget / 2);
  let tailCount = Math.floor(textBudget / 2);
  const measure = () =>
    points.slice(0, headCount).join("").length + marker.length + points.slice(points.length - tailCount).join("").length;
  while (headCount + tailCount > 0 && measure() > budgetChars) {
    if (tailCount > 0) tailCount -= 1;
    else headCount -= 1;
  }
  const head = points.slice(0, headCount).join("");
  const tail = tailCount > 0 ? points.slice(points.length - tailCount).join("") : "";
  const omittedBytes = utf8ByteLength(text) - utf8ByteLength(head) - utf8ByteLength(tail);
  return { preview: `${head}${marker}${tail}`, omittedBytes };
}

export function spillContentPath(assetId: string): string {
  return `/api/assets/${assetId}/content`;
}

export function formatSpillNotice(omittedBytes: number, assetId: string): string {
  return `(${omittedBytes} bytes omitted. Full text stored at: ${spillContentPath(assetId)}. Fetch it when you need the full content.)`;
}

/** Upper bound on the notice length: callers reserve this inside the budget. */
export function estimateSpillNoticeLength(totalBytes: number): number {
  return formatSpillNotice(totalBytes, "0".repeat(MAX_ASSET_ID_CHARS)).length;
}

/** Recognize our own notice so spilled previews never spill again. */
export function hasSpillNotice(text: string): boolean {
  if (!text.endsWith(")")) return false;
  const location = text.lastIndexOf("Full text stored at: ");
  if (location < 0) return false;
  const after = text.slice(location + "Full text stored at: ".length);
  return after.startsWith("/api/assets/") && after.includes(". Fetch it when you need the full content.");
}

export interface SpillWakeTextInput {
  db: Db;
  storage?: StorageService;
  companyId: string;
  issueId: string;
  commentId: string;
  text: string;
  maxInlineChars: number;
  agentId?: string | null;
  runId?: string | null;
}

export interface SpillWakeTextResult {
  assetId: string;
  contentPath: string;
  byteSize: number;
  body: string;
}

function spillFilename(digestHex: string): string {
  return `spill-${digestHex.slice(0, 16)}.txt`;
}

/**
 * Reuse a previous spill asset for identical comment content, found through
 * the creating activity row. Returns the asset id, or null when no usable
 * prior spill exists. Lookup failures fall through to a fresh spill.
 */
async function findSpillAssetForComment(
  db: Db,
  companyId: string,
  commentId: string,
  digestHex: string,
): Promise<string | null> {
  const rows = await db
    .select({ entityId: activityLog.entityId })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "asset.created"),
      sql`${activityLog.details} ->> 'source' = 'wake_output_spill'`,
      sql`${activityLog.details} ->> 'commentId' = ${commentId}`,
      sql`${activityLog.details} ->> 'sha256' = ${digestHex}`,
    ))
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  const assetId = rows[0]?.entityId ?? null;
  if (!assetId) return null;
  const asset = await assetService(db).getById(assetId);
  return asset && asset.companyId === companyId ? asset.id : null;
}

/**
 * Store oversized text as a spill asset and return the inline replacement
 * (preview + notice) with `body.length <= maxInlineChars`. Returns null when
 * no spill applies or when storage fails — callers keep the original text
 * (truncated by their own cap) in both cases.
 */
export async function spillWakeText(input: SpillWakeTextInput): Promise<SpillWakeTextResult | null> {
  const { text, maxInlineChars } = input;
  if (text.length <= maxInlineChars) return null;
  if (maxInlineChars < WAKE_SPILL_MIN_INLINE_CHARS) return null;
  if (hasSpillNotice(text)) return null;
  const totalBytes = utf8ByteLength(text);
  const digestHex = sha256Hex(text);
  const previewBudget = maxInlineChars - SPILL_BODY_SEPARATOR.length - estimateSpillNoticeLength(totalBytes);
  if (previewBudget < WAKE_SPILL_MIN_INLINE_CHARS) return null;

  try {
    const reusedAssetId = await findSpillAssetForComment(input.db, input.companyId, input.commentId, digestHex);
    if (reusedAssetId) {
      const { preview, omittedBytes } = buildSpillPreview(text, previewBudget);
      const notice = formatSpillNotice(omittedBytes, reusedAssetId);
      const body = `${preview}${SPILL_BODY_SEPARATOR}${notice}`;
      // Asset ids are UUIDs, so the estimate above always covers the real
      // notice. This guard exists only for foreign (non-UUID) asset ids.
      if (body.length > maxInlineChars) return null;
      return {
        assetId: reusedAssetId,
        contentPath: spillContentPath(reusedAssetId),
        byteSize: totalBytes,
        body,
      };
    }
  } catch {
    // Lookup failure must not block a fresh spill; fall through.
  }

  const storage = input.storage ?? getStorageService();
  const bodyBuffer = Buffer.from(text, "utf8");
  let objectKey: string | null = null;
  let assetId: string | null = null;
  try {
    const saved = await storage.putFile({
      companyId: input.companyId,
      namespace: WAKE_SPILL_NAMESPACE,
      originalFilename: spillFilename(digestHex),
      contentType: WAKE_SPILL_CONTENT_TYPE,
      body: bodyBuffer,
    });
    objectKey = saved.objectKey;
    const asset = await assetService(input.db).create(input.companyId, {
      provider: saved.provider,
      objectKey: saved.objectKey,
      contentType: saved.contentType,
      byteSize: saved.byteSize,
      sha256: saved.sha256,
      originalFilename: saved.originalFilename,
      createdByAgentId: null,
      createdByUserId: null,
    });
    if (!asset) throw new Error("spill asset row missing after insert");
    assetId = asset.id;
    await logActivity(input.db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "system",
      action: "asset.created",
      entityType: "asset",
      entityId: asset.id,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      issueId: input.issueId,
      details: { source: "wake_output_spill", byteSize: saved.byteSize, commentId: input.commentId, sha256: digestHex },
    });
    const { preview, omittedBytes } = buildSpillPreview(text, previewBudget);
    const notice = formatSpillNotice(omittedBytes, asset.id);
    const out = `${preview}${SPILL_BODY_SEPARATOR}${notice}`;
    if (out.length > maxInlineChars) throw new Error("spill body exceeds inline budget");
    return {
      assetId: asset.id,
      contentPath: spillContentPath(asset.id),
      byteSize: saved.byteSize,
      body: out,
    };
  } catch {
    // Best-effort unwind in reverse order; never throw. The row goes first
    // so a concurrent reuse either misses (and rewrites safely) or raced an
    // already-gone row in a window too small to close without refcounting.
    if (assetId) {
      try {
        await assetService(input.db).remove(assetId);
      } catch {
        return null;
      }
    }
    if (objectKey) {
      try {
        await storage.deleteObject(input.companyId, objectKey);
      } catch {
        // Blob without a row is unreachable; storage retention owns it.
      }
    }
    return null;
  }
}
