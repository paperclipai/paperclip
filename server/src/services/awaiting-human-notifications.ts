import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { awaitingHumanNotificationOutbox } from "@paperclipai/db";
import {
  normalizeReviewFile,
  resolveAwaitingHumanReviewFile,
} from "./awaiting-human-review-files.js";

const MAX_OUTBOX_ATTEMPTS = 8;
const STALE_OUTBOX_PROCESSING_MS = 5 * 60 * 1000;

export interface AwaitingHumanNotificationReviewFile {
  source: "artifact" | "document";
  deliverableId: string;
  title: string;
  filename: string;
  contentType: string;
  byteSize: number;
  contentPath: string;
  deliverableUrl: string;
  attachmentId?: string | null;
  objectKey?: string | null;
  sha256?: string | null;
}

export interface AwaitingHumanNotificationPayload {
  title: string;
  summary: string;
  link: string;
  cta: string;
  labels: string[];
  kind?: string | null;
  audience?: string | null;
  body?: string | null;
  reviewFile?: AwaitingHumanNotificationReviewFile | null;
}

export interface AwaitingHumanNotificationResult {
  status: "sent" | "skipped" | "failed" | "enqueued";
  channel: string;
  detail: string;
  externalId?: string | null;
}

export interface SendAwaitingHumanNotificationInput {
  companyId: string;
  issueId: string;
  handoffKind: "request_confirmation" | "ask_user_questions" | "human_owned_blocker";
  notification: AwaitingHumanNotificationPayload;
}

export interface EnqueueAwaitingHumanNotificationInput extends SendAwaitingHumanNotificationInput {
  dedupeKey: string;
}

function nextRetryAt(attempt: number, now = Date.now()): Date {
  const seq = [5, 10, 20, 40, 80, 160, 320, 640];
  const sec = seq[Math.min(Math.max(attempt - 1, 0), seq.length - 1)] ?? 640;
  return new Date(now + sec * 1000);
}

export async function enqueueAwaitingHumanNotification(
  db: Db,
  input: EnqueueAwaitingHumanNotificationInput,
): Promise<AwaitingHumanNotificationResult> {
  const reviewFile = await resolveAwaitingHumanReviewFile(db, {
    companyId: input.companyId,
    issueId: input.issueId,
    sourceLink: input.notification.link,
  });
  const notification = {
    ...input.notification,
    ...(reviewFile ? { reviewFile } : {}),
  };
  const storedReviewFile = reviewFile ? { ...reviewFile } : null;
  const [row] = await db
    .insert(awaitingHumanNotificationOutbox)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      dedupeKey: input.dedupeKey,
      handoffKind: input.handoffKind,
      status: "pending",
      notification,
      reviewFile: storedReviewFile,
    })
    .onConflictDoUpdate({
      target: [
        awaitingHumanNotificationOutbox.companyId,
        awaitingHumanNotificationOutbox.issueId,
        awaitingHumanNotificationOutbox.dedupeKey,
      ],
      set: {
        handoffKind: input.handoffKind,
        notification,
        reviewFile: storedReviewFile,
        status: sql`
          case
            when ${awaitingHumanNotificationOutbox.status} in ('sent', 'processing', 'retrying', 'partial_failed')
              then ${awaitingHumanNotificationOutbox.status}
            when ${awaitingHumanNotificationOutbox.status} = 'failed'
              and ${awaitingHumanNotificationOutbox.attempts} < ${MAX_OUTBOX_ATTEMPTS}
              and ${awaitingHumanNotificationOutbox.nextAttemptAt} is not null
              then 'retrying'
            when ${awaitingHumanNotificationOutbox.status} = 'failed'
              then ${awaitingHumanNotificationOutbox.status}
            else 'pending'
          end
        `,
        attempts: sql`
          case
            when ${awaitingHumanNotificationOutbox.status} in ('sent', 'processing', 'retrying', 'partial_failed', 'failed')
              then ${awaitingHumanNotificationOutbox.attempts}
            else 0
          end
        `,
        nextAttemptAt: sql`
          case
            when ${awaitingHumanNotificationOutbox.status} in ('retrying', 'partial_failed', 'failed')
              then ${awaitingHumanNotificationOutbox.nextAttemptAt}
            else null
          end
        `,
        lastError: sql`
          case
            when ${awaitingHumanNotificationOutbox.status} in ('sent', 'processing', 'retrying', 'partial_failed', 'failed')
              then ${awaitingHumanNotificationOutbox.lastError}
            else null
          end
        `,
        updatedAt: new Date(),
      },
    })
    .returning({
      status: awaitingHumanNotificationOutbox.status,
    });

  return {
    status: row?.status === "sent" ? "sent" : "enqueued",
    channel: "bridge",
    detail: row?.status === "sent" ? "already-sent" : "enqueued",
    externalId: null,
  };
}

export async function processAwaitingHumanNotificationOutbox(
  _db: Db,
  _opts: { limit?: number; storage?: unknown } = {},
) {
  // Delivery is now handled by the awaiting-human bridge lifecycle.
  // This function remains as a compatibility shim for heartbeat callers.
  return { processed: 0, sent: 0, failed: 0 };
}
