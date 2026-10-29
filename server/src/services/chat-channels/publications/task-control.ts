import { notifyChatResponseAvailability } from "../../chat-response-availability.js";
import type { DbOrTransaction } from "../runtime-types.js";

import { notifyChatPublicationWork } from "../../chat-work-notifications.js";

import {
  and,
  eq,
  gt,
  inArray,
  like,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatConversations,
  chatPublications,
  issues,
} from "@paperclipai/db";
import type {
  SafeChatPublicationPayload,
} from "@paperclipai/shared";

import { projectSafeChatPublication } from "../../chat-publication-projection.js";

import { publicationTransportOrderKey } from "./order.js";
export function createChatPublicationTaskControl(db: Db) {


  async function currentTaskControlPayload(
    publication: typeof chatPublications.$inferSelect,
  ): Promise<SafeChatPublicationPayload> {
    const persisted = publication.payload as SafeChatPublicationPayload;
    if (!publication.idempotencyKey.startsWith("control:status:")) {
      return persisted;
    }
    const issue = await db
      .select({
        identifier: issues.identifier,
        status: issues.status,
        title: issues.title,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, publication.companyId),
          eq(issues.id, publication.issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!issue) return persisted;
    return projectSafeChatPublication({
      classification: "external",
      source: "task_control",
      text: `${issue.identifier}: ${issue.title} — ${issue.status}`,
    });
  }

  function taskControlCompletesConversation(
    publication: Pick<typeof chatPublications.$inferSelect, "idempotencyKey">,
  ): boolean {
    return /^control:(?:new|close):/.test(publication.idempotencyKey);
  }

  async function hasCommittedTaskControlCompletion(
    conversationId: string,
    database: DbOrTransaction = db,
  ): Promise<boolean> {
    return database
      .select({ id: chatPublications.id })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.conversationId, conversationId),
          eq(chatPublications.state, "published"),
          or(
            like(chatPublications.idempotencyKey, "control:new:%"),
            like(chatPublications.idempotencyKey, "control:close:%"),
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
  }

  async function commitTaskControlCompletion(
    tx: Db,
    publication: Pick<
      typeof chatPublications.$inferSelect,
      | "companyId"
      | "conversationId"
      | "createdAt"
      | "endpointId"
      | "id"
      | "idempotencyKey"
      | "payload"
    >,
    committedAt: Date,
  ): Promise<void> {
    if (!taskControlCompletesConversation(publication)) return;
    await tx
      .update(chatConversations)
      .set({ state: "completed", updatedAt: committedAt })
      .where(
        and(
          eq(chatConversations.companyId, publication.companyId),
          eq(chatConversations.endpointId, publication.endpointId),
          eq(chatConversations.id, publication.conversationId),
          inArray(chatConversations.state, ["active", "waiting"]),
        ),
      );
    // The provider-visible completion is the external boundary. Anything
    // enqueued later for this old generation stays internal even if its run
    // finishes after /new or /close. A racing insert that commits after this
    // transaction is rejected by the completed-conversation send guard.
    await notifyChatPublicationWork(tx);
    await notifyChatResponseAvailability(tx, publication);
    await tx
      .update(chatPublications)
      .set({
        state: "cancelled",
        nextAttemptAt: null,
        redactedError:
          "Conversation was completed by a task control before delivery",
        updatedAt: committedAt,
      })
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          or(
            gt(chatPublications.createdAt, publication.createdAt),
            and(
              eq(chatPublications.createdAt, publication.createdAt),
              gt(
                publicationTransportOrderKey(chatPublications),
                publication.payload.transportPart?.orderKey ?? publication.id,
              ),
            ),
          ),
          inArray(chatPublications.state, ["pending", "retry", "streaming"]),
          sql`not (${chatPublications.idempotencyKey} like 'explicit:%' or ${chatPublications.idempotencyKey} like 'explicit-board:%')`,
        ),
      );
  }
  return { currentTaskControlPayload, hasCommittedTaskControlCompletion, commitTaskControlCompletion };
}
