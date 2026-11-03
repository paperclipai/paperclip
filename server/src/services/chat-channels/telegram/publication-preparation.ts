import { createChatPublicationReplacement } from "../publication-replacement.js";
import { notifyChatPublicationWork } from "../../chat-work-notifications.js";
import {
  eq,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatPublications,
} from "@paperclipai/db";
import type {
  SafeChatPublicationPayload,
} from "@paperclipai/shared";

import {
  splitTelegramPublicationText,
  telegramMarkdownRequiresAttachment,
} from "../../chat-publication-stream.js";
type PublicationPreparationOptions = {
  runPublicationToReplace: ReturnType<typeof createChatPublicationReplacement>["runPublicationToReplace"];
};
export function createTelegramPublicationPreparation(db: Db, options: PublicationPreparationOptions) {
  const { runPublicationToReplace } = options;
  async function prepareTelegramPublication(publication: typeof chatPublications.$inferSelect, persisted: SafeChatPublicationPayload): Promise<typeof chatPublications.$inferSelect> {if (
      persisted.transportPart ||
      persisted.card ||
      persisted.interactionId ||
      persisted.attachmentIds?.length
    ) {
      return publication;
    }
    if (telegramMarkdownRequiresAttachment(persisted.text)) {
      // Telegram parses each message independently. A fixed-size split can
      // turn the second half of a code fence, link, or list into unrelated
      // plain text even though concatenating the source parts is lossless.
      // Preserve structured long Markdown as one document. When this is a run
      // final, first complete its existing progress placeholder, then send the
      // file through a separate ordered outbox row because Telegram cannot add
      // an attachment while editing that placeholder.
      const replacesProgressMessage = Boolean(
        await runPublicationToReplace(publication, persisted),
      );
      return db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.id, publication.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current) return publication;
        const currentPayload = current.payload as SafeChatPublicationPayload;
        if (
          currentPayload.transportPart ||
          currentPayload.card ||
          currentPayload.interactionId ||
          currentPayload.attachmentIds?.length ||
          !["pending", "retry"].includes(current.state) ||
          !telegramMarkdownRequiresAttachment(currentPayload.text)
        ) {
          return current;
        }

        const batchId = current.id;
        const updatedAt = new Date();
        const transportPart = (
          index: number,
          count: number,
          mode: "inline" | "telegram_markdown_attachment",
        ) => ({
          batchId,
          count,
          index,
          mode,
          orderKey: `${batchId}:${String(index).padStart(4, "0")}`,
        });
        if (!replacesProgressMessage) {
          const attachmentPayload: SafeChatPublicationPayload = {
            ...currentPayload,
            transportPart: transportPart(0, 1, "telegram_markdown_attachment"),
          };
          await notifyChatPublicationWork(tx);
          await tx
            .update(chatPublications)
            .set({ payload: attachmentPayload, updatedAt })
            .where(eq(chatPublications.id, current.id));
          return { ...current, payload: attachmentPayload, updatedAt };
        }

        const handoffPayload: SafeChatPublicationPayload = {
          ...currentPayload,
          text: "This response needs a separate attachment because it exceeds the message limit.",
          transportPart: transportPart(0, 2, "inline"),
        };
        delete handoffPayload.attachmentIds;
        await notifyChatPublicationWork(tx);
        await tx
          .update(chatPublications)
          .set({ payload: handoffPayload, updatedAt })
          .where(eq(chatPublications.id, current.id));

        const attachmentPayload: SafeChatPublicationPayload = {
          ...currentPayload,
          transportPart: transportPart(1, 2, "telegram_markdown_attachment"),
        };
        delete attachmentPayload.progressState;
        await notifyChatPublicationWork(tx);
        await tx.insert(chatPublications).values({
          companyId: current.companyId,
          endpointId: current.endpointId,
          conversationId: current.conversationId,
          issueId: current.issueId,
          commentId: current.commentId,
          idempotencyKey: `telegram-markdown-attachment:${current.id}`,
          payload: attachmentPayload,
          state: "pending",
          createdAt: sql`(select ${chatPublications.createdAt} from ${chatPublications} where ${chatPublications.id} = ${current.id})`,
          updatedAt,
        });
        return { ...current, payload: handoffPayload, updatedAt };
      });
    }
    const parts = splitTelegramPublicationText(persisted.text);
    if (parts.length === 1) return publication;

    return db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.id, publication.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!current) return publication;
      const currentPayload = current.payload as SafeChatPublicationPayload;
      if (
        currentPayload.transportPart ||
        currentPayload.card ||
        currentPayload.interactionId ||
        currentPayload.attachmentIds?.length ||
        !["pending", "retry"].includes(current.state)
      ) {
        return current;
      }
      const currentParts = splitTelegramPublicationText(currentPayload.text);
      if (currentParts.length === 1) return current;

      const batchId = current.id;
      const updatedAt = new Date();
      const transportPart = (index: number) => ({
        batchId,
        count: currentParts.length,
        index,
        orderKey: `${batchId}:${String(index).padStart(4, "0")}`,
      });
      const rootPayload: SafeChatPublicationPayload = {
        ...currentPayload,
        text: currentParts[0]!,
        transportPart: transportPart(0),
      };
      await notifyChatPublicationWork(tx);
      await tx
        .update(chatPublications)
        .set({ payload: rootPayload, updatedAt })
        .where(eq(chatPublications.id, current.id));

      const { progressState: _progressState, ...nonProgressPayload } =
        currentPayload;
      await notifyChatPublicationWork(tx);
      await tx.insert(chatPublications).values(
        currentParts.slice(1).map((text, offset) => {
          const index = offset + 1;
          return {
            companyId: current.companyId,
            endpointId: current.endpointId,
            conversationId: current.conversationId,
            issueId: current.issueId,
            commentId: current.commentId,
            idempotencyKey: `${current.idempotencyKey}:telegram-part:${index}`,
            payload: {
              ...nonProgressPayload,
              text,
              transportPart: transportPart(index),
            },
            state: "pending" as const,
            createdAt: sql`(select ${chatPublications.createdAt} from ${chatPublications} where ${chatPublications.id} = ${current.id})`,
            updatedAt,
          };
        }),
      );
      return { ...current, payload: rootPayload, updatedAt };
    });}
  return { prepareTelegramPublication };
}
