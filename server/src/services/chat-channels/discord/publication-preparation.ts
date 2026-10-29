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
  discordMarkdownRequiresAttachment,
} from "../../chat-discord.js";

type PublicationPreparationOptions = {
  runPublicationToReplace: ReturnType<typeof createChatPublicationReplacement>["runPublicationToReplace"];
};
export function createDiscordPublicationPreparation(db: Db, options: PublicationPreparationOptions) {
  const { runPublicationToReplace } = options;
  async function prepareDiscordPublication(publication: typeof chatPublications.$inferSelect, persisted: SafeChatPublicationPayload): Promise<typeof chatPublications.$inferSelect> {
      if (
        persisted.transportPart ||
        persisted.card ||
        persisted.interactionId ||
        !discordMarkdownRequiresAttachment(persisted.text)
      ) {
        return publication;
      }

      // A normal response can replace its run's working placeholder. Discord's
      // adapter cannot add a file while editing, so first turn that placeholder
      // into a durable hand-off and then publish the complete Markdown as its
      // own ordered attachment row. Publications without a replacement lane
      // remain one provider call: a short caption and the lossless file.
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
          !["pending", "retry"].includes(current.state) ||
          !discordMarkdownRequiresAttachment(currentPayload.text)
        ) {
          return current;
        }

        const batchId = current.id;
        const updatedAt = new Date();
        const transportPart = (
          index: number,
          count: number,
          mode: "inline" | "discord_markdown_attachment",
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
            transportPart: transportPart(0, 1, "discord_markdown_attachment"),
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
          transportPart: transportPart(1, 2, "discord_markdown_attachment"),
        };
        delete attachmentPayload.progressState;
        await notifyChatPublicationWork(tx);
        await tx.insert(chatPublications).values({
          companyId: current.companyId,
          endpointId: current.endpointId,
          conversationId: current.conversationId,
          issueId: current.issueId,
          commentId: current.commentId,
          idempotencyKey: `discord-markdown-attachment:${current.id}`,
          payload: attachmentPayload,
          state: "pending",
          createdAt: sql`(select ${chatPublications.createdAt} from ${chatPublications} where ${chatPublications.id} = ${current.id})`,
          updatedAt,
        });
        return { ...current, payload: handoffPayload, updatedAt };
      });
    }
  return { prepareDiscordPublication };
}
