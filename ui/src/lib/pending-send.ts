/**
 * Durable sends: writes that must not lose the user's text across a deploy,
 * a restart, or a network drop.
 *
 * The pattern (generalized from `components/chat/board-send-draft.ts`):
 *
 * 1. Persist the payload and its idempotency key **before** the request.
 * 2. Send.
 * 3. On a transient or unconfirmed failure, keep the record and resend it with
 *    the **same key** when the connection returns. The server dedupes by that
 *    key (`clientRequestId` for comments, `idempotencyKey` for issue create and
 *    board publishes), so a resend after a lost response cannot post twice.
 * 4. Clear the record only after a confirmed receipt.
 * 5. On a definitive rejection (a 4xx), clear the record and give the text
 *    back to the editor with `describeError` copy.
 *
 * Only writes the server dedupes, or that set absolute values, may resend on
 * their own. Uploads and other non-idempotent POSTs keep the input and offer
 * Retry, but never resend by themselves.
 */

import { classifyError, errorStatus } from "@/api/errors";
import { CommentSubmissionUnknownError } from "./comment-submit-result";

/** What to do after a send failed. */
export type SendFailure =
  /** Not delivered, or not known to be delivered: keep it and resend with the same key. */
  | "pending"
  /** The server refused it; resending the same request cannot help. */
  | "rejected";

export type SendOutcome = "sent" | SendFailure;

/**
 * Classify a failed idempotent send. "Pending" covers outages (network drop,
 * proxy 5xx, gateway codes, 429) and lost receipts (any 5xx may have committed
 * before failing). Everything else, including a plain `Error` thrown by the
 * caller, is a definitive answer.
 */
export function classifySendFailure(error: unknown): SendFailure {
  if (error instanceof CommentSubmissionUnknownError) return "pending";
  const kind = classifyError(error);
  if (kind === "transient") return "pending";
  if (kind === "unknown" && (errorStatus(error) ?? 0) >= 500) return "pending";
  return "rejected";
}

// --- Persisted records ------------------------------------------------------------

export interface PendingSend<T> {
  idempotencyKey: string;
  payload: T;
  /** Epoch ms of the first attempt. */
  createdAt: number;
}

const RECORD_VERSION = 1;
const MAX_RECORD_LENGTH = 256_000;

export type PendingSendStorage = "local" | "session";

function storageFor(kind: PendingSendStorage): Storage | null {
  try {
    return kind === "session" ? sessionStorage : localStorage;
  } catch {
    return null;
  }
}

export function readPendingSend<T>(
  key: string,
  isPayload: (value: unknown) => value is T,
  storage: PendingSendStorage = "local",
): PendingSend<T> | null {
  try {
    const raw = storageFor(storage)?.getItem(key);
    if (!raw || raw.length > MAX_RECORD_LENGTH) return null;
    const record = JSON.parse(raw) as Record<string, unknown> | null;
    if (
      !record ||
      record.version !== RECORD_VERSION ||
      record.key !== key ||
      typeof record.idempotencyKey !== "string" ||
      record.idempotencyKey.length < 8 ||
      record.idempotencyKey.length > 255 ||
      typeof record.createdAt !== "number" ||
      !isPayload(record.payload)
    )
      return null;
    return {
      idempotencyKey: record.idempotencyKey,
      payload: record.payload,
      createdAt: record.createdAt,
    };
  } catch {
    return null;
  }
}

/** Returns false when browser storage refused the write; the caller keeps the record in memory. */
export function writePendingSend<T>(
  key: string,
  record: PendingSend<T>,
  storage: PendingSendStorage = "local",
): boolean {
  try {
    const target = storageFor(storage);
    if (!target) return false;
    target.setItem(key, JSON.stringify({ version: RECORD_VERSION, key, ...record }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a record. With `idempotencyKey`, only that exact send is cleared: a
 * late response for an older send must not drop a newer one.
 */
export function clearPendingSend(
  key: string,
  idempotencyKey?: string,
  storage: PendingSendStorage = "local",
): void {
  try {
    const target = storageFor(storage);
    if (!target) return;
    if (idempotencyKey !== undefined) {
      const raw = target.getItem(key);
      if (raw) {
        const record = JSON.parse(raw) as { idempotencyKey?: unknown } | null;
        if (record?.idempotencyKey !== idempotencyKey) return;
      }
    }
    target.removeItem(key);
  } catch {
    // Unavailable storage holds nothing to clear.
  }
}

// --- Resend schedule ------------------------------------------------------------------

/** Delay before each automatic resend while the app is online; the last value repeats. */
export const RESEND_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;
/**
 * Automatic resends while the app looks online before waiting for the user.
 * A route that keeps failing while health is fine is not an outage; polling it
 * forever helps nobody. Recovering from an outage starts a fresh round.
 */
export const MAX_ONLINE_RESENDS = 8;

export function resendDelayFor(attempt: number): number {
  return RESEND_BACKOFF_MS[Math.min(Math.max(attempt, 0), RESEND_BACKOFF_MS.length - 1)];
}
