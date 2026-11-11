import { and, eq, inArray, sql } from "drizzle-orm";
import { chatActions } from "@paperclipai/db";
import type { DbTransaction } from "../runtime-types.js";
import type { chatPublications } from "@paperclipai/db";
export async function resolveSlackFileReceipt(tx: DbTransaction, publication: typeof chatPublications.$inferSelect, action: "mark_delivered" | "retry_anyway" | "cancel", now: Date): Promise<void> {
  const receiptProviderActionId = `slack-file-receipt:${publication.id}:${publication.attempts}`;
  if (action === "mark_delivered") {
    await tx
      .update(chatActions)
      .set({
        result: sql`coalesce(${chatActions.result}, '{}'::jsonb) || jsonb_build_object(
                  'operatorConfirmedPublicationId', ${publication.id}::text,
                  'operatorConfirmedAttempt', ${publication.attempts}::integer,
                  'operatorConfirmedAt', ${now.toISOString()}::text
                )`,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatActions.companyId, publication.companyId),
          eq(chatActions.endpointId, publication.endpointId),
          eq(chatActions.conversationId, publication.conversationId),
          eq(chatActions.kind, "slack_file_upload_receipt"),
          eq(chatActions.providerActionId, receiptProviderActionId),
          inArray(chatActions.status, [
            "received",
            "failed",
            "processing",
          ]),
          sql`(${chatActions.payload}->>'publicationId')::uuid = ${publication.id}`,
          sql`(${chatActions.payload}->>'publicationAttempt')::int = ${publication.attempts}`,
        ),
      );
  } else {
    await tx
      .update(chatActions)
      .set({
        status: "cancelled",
        result: {
          code:
            action === "retry_anyway"
              ? "slack_file_upload_receipt_retry_superseded"
              : "slack_file_upload_receipt_cancelled_by_operator",
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(chatActions.companyId, publication.companyId),
          eq(chatActions.endpointId, publication.endpointId),
          eq(chatActions.conversationId, publication.conversationId),
          eq(chatActions.kind, "slack_file_upload_receipt"),
          eq(chatActions.providerActionId, receiptProviderActionId),
          inArray(chatActions.status, [
            "received",
            "failed",
            "processing",
          ]),
          sql`(${chatActions.payload}->>'publicationId')::uuid = ${publication.id}`,
          sql`(${chatActions.payload}->>'publicationAttempt')::int = ${publication.attempts}`,
        ),
      );
  }
}
