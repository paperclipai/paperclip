import { createHash } from "node:crypto";
import { stableStringify } from "./json.js";

/**
 * Computes the deterministic Paperclip ingest ID for a run event.
 *
 * Format: `paperclip:<run_id>:<usage_updated_at>:<payload_hash>`
 *
 * The ingestId is computed from this template so that re-ingesting the same
 * logical event (same run + same usage timestamp + same payload hash) produces
 * the same key, enabling idempotent upsert via ON CONFLICT DO NOTHING.
 *
 * @see PAPERCLIP_EVENT_KEY_FORMAT in constants.ts
 */
export function computePaperclipRunEventKey(params: {
  runId: string;
  usageUpdatedAt: string; // ISO timestamp string
  payloadHash: string;
}): string {
  return `paperclip:${params.runId}:${params.usageUpdatedAt}:${params.payloadHash}`;
}

/**
 * Computes a SHA-256 hex digest of a canonicalized event payload.
 *
 * Uses stableStringify to guarantee that structurally-equal payloads (even
 * with different key insertion orders) always produce the same hash.
 */
export function computePayloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/**
 * Computes the deterministic source_event_id for a Paperclip-sourced event.
 *
 * Format: `paperclip:<run_id>:<usage_updated_at>`
 *
 * This is used as the idempotency key composite — paired with
 * source_system + event_kind + attempt_index in the unique constraint.
 *
 * @see PAPERCLIP_SOURCE_EVENT_ID_FORMAT in constants.ts
 */
export function computeSourceEventId(params: {
  runId: string;
  usageUpdatedAt: string;
}): string {
  return `paperclip:${params.runId}:${params.usageUpdatedAt}`;
}
