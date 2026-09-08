import type { Db } from "@paperclipai/db";
import { assetService } from "./assets.js";
import { logActivity } from "./activity-log.js";
import { getStorageService, type StorageService } from "../storage/index.js";

// Spill store for oversized wake text, borrowed from the DeepSeek Harness
// `spill` capability family (packages/spill/*): full text is stored once in
// the existing asset blob store and replaced inline by a bounded preview
// plus a locator notice with retrieval guidance. Fail-safe throughout: any
// storage failure keeps the original text, never an error.

export const WAKE_SPILL_NAMESPACE = "spill";
export const WAKE_SPILL_CONTENT_TYPE = "text/plain; charset=utf-8";
export const WAKE_SPILL_MIN_INLINE_CHARS = 256;

const SPILL_NOTICE_LOCATION = "Full text stored at: ";
const SPILL_NOTICE_CLOSE = ")";

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export interface SpillPreview {
  preview: string;
  omittedBytes: number;
}

/** Split text into a bounded head/tail preview, code-point safe. */
export function buildSpillPreview(text: string, budgetChars: number): SpillPreview {
  const points = [...text];
  if (points.length <= budgetChars) {
    return { preview: text, omittedBytes: 0 };
  }
  const headChars = Math.ceil(budgetChars / 2);
  const tailChars = Math.floor(budgetChars / 2);
  const head = points.slice(0, headChars).join("");
  const tail = tailChars > 0 ? points.slice(points.length - tailChars).join("") : "";
  const omittedBytes = utf8ByteLength(text) - utf8ByteLength(head) - utf8ByteLength(tail);
  return { preview: `${head}\n…\n${tail}`, omittedBytes };
}

export function spillContentPath(assetId: string): string {
  return `/api/assets/${assetId}/content`;
}

export function formatSpillNotice(omittedBytes: number, assetId: string): string {
  return `(${omittedBytes} bytes omitted. ${SPILL_NOTICE_LOCATION}${spillContentPath(assetId)}. Fetch it when you need the full content.${SPILL_NOTICE_CLOSE}`;
}

/** Recognize our own notice so spilled previews never spill again. */
export function hasSpillNotice(text: string): boolean {
  if (!text.endsWith(SPILL_NOTICE_CLOSE)) return false;
  const location = text.lastIndexOf(SPILL_NOTICE_LOCATION);
  if (location < 0) return false;
  const after = text.slice(location + SPILL_NOTICE_LOCATION.length);
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

function spillFilename(commentId: string): string {
  const safe = commentId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  return `spill-comment-${safe || "unknown"}.txt`;
}

/**
 * Store oversized text as a spill asset and return the inline replacement
 * (preview + notice). Returns null when no spill applies or when storage
 * fails — callers keep the original text in both cases.
 */
export async function spillWakeText(input: SpillWakeTextInput): Promise<SpillWakeTextResult | null> {
  const { text, maxInlineChars } = input;
  if ([...text].length <= maxInlineChars) return null;
  if (maxInlineChars < WAKE_SPILL_MIN_INLINE_CHARS) return null;
  if (hasSpillNotice(text)) return null;
  const { preview, omittedBytes } = buildSpillPreview(text, maxInlineChars);
  try {
    const storage = input.storage ?? getStorageService();
    const saved = await storage.putFile({
      companyId: input.companyId,
      namespace: WAKE_SPILL_NAMESPACE,
      originalFilename: spillFilename(input.commentId),
      contentType: WAKE_SPILL_CONTENT_TYPE,
      body: Buffer.from(text, "utf8"),
    });
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
    if (!asset) return null;
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
      details: { source: "wake_output_spill", byteSize: saved.byteSize },
    });
    const notice = formatSpillNotice(omittedBytes, asset.id);
    return {
      assetId: asset.id,
      contentPath: spillContentPath(asset.id),
      byteSize: saved.byteSize,
      body: `${preview}\n\n${notice}`,
    };
  } catch {
    // A spill failure must never turn prompt assembly into an error or
    // hide the inline result. The caller falls back to plain truncation.
    return null;
  }
}
