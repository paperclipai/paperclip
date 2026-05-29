import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { awaitingHumanNotificationOutbox } from "@paperclipai/db";
import { resolveAwaitingHumanReviewFile } from "./awaiting-human-review-files.js";
import { issueService } from "./issues.js";
import { awaitingHumanSettingsService } from "./awaiting-human-settings.js";
import {
  hasAwaitingHumanBridgeAdapter,
  resolveAwaitingHumanBridgeAdapter,
} from "./awaiting-human-bridge-registry.js";
import { awaitingHumanBridgeService } from "./awaiting-human-bridge.js";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";

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
  clickupTaskUrl?: string | null;
  clickupAttachmentId?: string | null;
  clickupAttachmentUrl?: string | null;
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
  interactionId?: string | null;
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
  db: Db,
  opts: { limit?: number; storage?: StorageService } = {},
) {
  const now = new Date();
  const limit = opts.limit ?? 20;
  const issueSvc = issueService(db);
  const bridgeSettings = awaitingHumanSettingsService(db);
  const bridgeSvc = awaitingHumanBridgeService(db, {
    resolveProviderForCompany: async (companyId) => bridgeSettings.resolveProvider(companyId),
    resolveAdapter: (provider) => resolveAwaitingHumanBridgeAdapter(provider, db),
    hasAdapter: (provider) => hasAwaitingHumanBridgeAdapter(provider),
    storage: opts.storage,
  });

  await db.update(awaitingHumanNotificationOutbox).set({
    status: "pending",
    updatedAt: now,
  }).where(and(
    eq(awaitingHumanNotificationOutbox.status, "processing"),
    lt(awaitingHumanNotificationOutbox.updatedAt, new Date(now.getTime() - STALE_OUTBOX_PROCESSING_MS)),
  ));

  const rows = await db
    .select()
    .from(awaitingHumanNotificationOutbox)
    .where(and(
      or(
        eq(awaitingHumanNotificationOutbox.status, "pending"),
        eq(awaitingHumanNotificationOutbox.status, "retrying"),
        eq(awaitingHumanNotificationOutbox.status, "failed"),
      ),
      lt(awaitingHumanNotificationOutbox.attempts, MAX_OUTBOX_ATTEMPTS),
      or(
        isNull(awaitingHumanNotificationOutbox.nextAttemptAt),
        lte(awaitingHumanNotificationOutbox.nextAttemptAt, now),
      ),
    ))
    .limit(limit);

  let processed = 0;
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const [claimed] = await db
      .update(awaitingHumanNotificationOutbox)
      .set({
        status: "processing",
        updatedAt: new Date(),
      })
      .where(and(
        eq(awaitingHumanNotificationOutbox.id, row.id),
        or(
          eq(awaitingHumanNotificationOutbox.status, "pending"),
          eq(awaitingHumanNotificationOutbox.status, "retrying"),
          eq(awaitingHumanNotificationOutbox.status, "failed"),
        ),
      ))
      .returning({ id: awaitingHumanNotificationOutbox.id });

    if (!claimed) continue;
    processed += 1;

    try {
      const notification = row.notification as unknown as AwaitingHumanNotificationPayload;
      const interactionId = typeof notification.interactionId === "string" && notification.interactionId.trim().length > 0
        ? notification.interactionId.trim()
        : null;
      if (!interactionId) {
        throw new Error("missing-interaction-id");
      }

      const issue = await issueSvc.getById(row.issueId);
      const agentId = issue?.assigneeAgentId ?? issue?.createdByAgentId ?? null;
      if (!issue || !agentId) {
        throw new Error("missing-bridge-agent");
      }

      if (row.handoffKind !== "request_confirmation" && row.handoffKind !== "ask_user_questions") {
        throw new Error(`unsupported-handoff-kind:${row.handoffKind}`);
      }

      const bridge = await bridgeSvc.openOrReuseForInteraction({
        companyId: row.companyId,
        issueId: row.issueId,
        interactionId,
        agentId,
        handoffKind: row.handoffKind,
        notification,
      });

      sent += 1;
      await db.update(awaitingHumanNotificationOutbox).set({
        status: "sent",
        attempts: row.attempts + 1,
        nextAttemptAt: null,
        clickupMessageId: bridge.externalMessageId ?? null,
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(awaitingHumanNotificationOutbox.id, row.id));
    } catch (error) {
      failed += 1;
      const detail = error instanceof Error ? error.message : String(error);
      await db.update(awaitingHumanNotificationOutbox).set({
        status: "failed",
        attempts: row.attempts + 1,
        nextAttemptAt: nextRetryAt(row.attempts + 1, now.getTime()),
        lastError: detail,
        updatedAt: new Date(),
      }).where(eq(awaitingHumanNotificationOutbox.id, row.id));
    }
  }

  return { processed, sent, failed };
}
