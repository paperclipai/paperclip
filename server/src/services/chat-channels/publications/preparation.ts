import { createDiscordPublicationPreparation } from "../discord/publication-preparation.js";
import { createTelegramPublicationPreparation } from "../telegram/publication-preparation.js";
import { createChatPublicationReplacement } from "../publication-replacement.js";

import { notifyChatPublicationWork } from "../../chat-work-notifications.js";

import {
  eq,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatEndpoints,
  chatPublications,
} from "@paperclipai/db";
import type {
  SafeChatPublicationPayload,
} from "@paperclipai/shared";

import {
  renderPublicationTransportText,
  splitNativePublicationText,
} from "../../chat-publication-text-parts.js";

type PublicationPreparationOptions = {
  runPublicationToReplace: ReturnType<typeof createChatPublicationReplacement>["runPublicationToReplace"];
  publicationTransportPreparationBarrier?: (input: { publicationId: string }) => Promise<void>;
};
export function createChatPublicationPreparation(db: Db, options: PublicationPreparationOptions) {
  const { runPublicationToReplace } = options;
  const { prepareDiscordPublication } = createDiscordPublicationPreparation(db, { runPublicationToReplace });
  const { prepareTelegramPublication } = createTelegramPublicationPreparation(db, { runPublicationToReplace });


  async function ensureDurablePublicationTransport(
    publication: typeof chatPublications.$inferSelect,
  ): Promise<typeof chatPublications.$inferSelect> {
    const persisted = publication.payload as SafeChatPublicationPayload;
    if (
      !persisted ||
      typeof persisted !== "object" ||
      typeof persisted.text !== "string"
    ) {
      throw Object.assign(
        new Error("Durable chat publication payload is malformed"),
        { code: "VALIDATION_ERROR", name: "ValidationError" },
      );
    }
    // Validate closed persisted wrappers even on retries that are already split.
    renderPublicationTransportText(persisted);
    await options.publicationTransportPreparationBarrier?.({
      publicationId: publication.id,
    });
    const provider = await db
      .select({ provider: chatEndpoints.provider })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, publication.endpointId))
      .then((rows) => rows[0]?.provider ?? null);
    if (
      provider === "slack" ||
      provider === "github" ||
      provider === "microsoft-teams"
    ) {
      if (
        persisted.transportPart ||
        persisted.card ||
        persisted.interactionId ||
        persisted.attachmentIds?.length
      )
        return publication;
      const parts = splitNativePublicationText(provider, persisted.text);
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
        renderPublicationTransportText(currentPayload);
        if (
          currentPayload.transportPart ||
          currentPayload.card ||
          currentPayload.interactionId ||
          currentPayload.attachmentIds?.length ||
          !["pending", "retry"].includes(current.state)
        )
          return current;
        const currentParts =
          currentPayload.text === persisted.text
            ? parts
            : splitNativePublicationText(provider, currentPayload.text);
        if (currentParts.length === 1) return current;
        const batchId = current.id;
        const updatedAt = new Date();
        const payloadFor = (index: number): SafeChatPublicationPayload => {
          const part = currentParts[index]!;
          const payload = {
            ...currentPayload,
            text: part.text,
            transportPart: {
              batchId,
              index,
              count: currentParts.length,
              mode: "inline" as const,
              orderKey: `${batchId}:${String(index).padStart(4, "0")}`,
              ...(part.prefix ? { prefix: part.prefix } : {}),
              ...(part.suffix ? { suffix: part.suffix } : {}),
            },
          };
          if (index > 0) delete payload.progressState;
          return payload;
        };
        const rootPayload = payloadFor(0);
        await notifyChatPublicationWork(tx);
        await tx
          .update(chatPublications)
          .set({ payload: rootPayload, updatedAt })
          .where(eq(chatPublications.id, current.id));
        await notifyChatPublicationWork(tx);
        await tx.insert(chatPublications).values(
          currentParts.slice(1).map((_part, offset) => ({
            companyId: current.companyId,
            endpointId: current.endpointId,
            conversationId: current.conversationId,
            issueId: current.issueId,
            commentId: current.commentId,
            idempotencyKey: `${current.idempotencyKey}:${provider}-part:${offset + 1}`,
            payload: payloadFor(offset + 1),
            state: "pending" as const,
            createdAt: sql`(select ${chatPublications.createdAt} from ${chatPublications} where ${chatPublications.id} = ${current.id})`,
            updatedAt,
          })),
        );
        return { ...current, payload: rootPayload, updatedAt };
      });
    }
    if (provider === "discord") {
      return prepareDiscordPublication(publication, persisted);
    }

    if (provider !== "telegram") return publication;
    return prepareTelegramPublication(publication, persisted);
  }
  return { ensureDurablePublicationTransport };
}
