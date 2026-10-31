import { createProviderEffects, type ProviderEffectTarget } from "../provider-effects.js";

import type { EndpointRow, RuntimeContext, InboundRuntimeContext } from "../runtime-types.js";

import { notifyChatDeliveryWork } from "../../chat-work-notifications.js";

import {
  and,
  eq,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatDeliveries,
  issueComments,
} from "@paperclipai/db";

import {
  formatAttachmentSize,
  MAX_ATTACHMENT_BYTES,
} from "../../../attachment-types.js";

import type {
  Message,
  Thread,
} from "chat";

import type { EndpointRecord } from "../runtime-types.js";

type DeliveryRow = typeof chatDeliveries.$inferSelect;
type TelegramAttachmentFailureOptions = {
  attachmentOmissionDetail: (result: { omissionReasons: Record<string, number> }) => string | null;
  runtimeContextForRecord: (record: EndpointRecord) => RuntimeContext;
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  stageProviderEffect: ReturnType<typeof createProviderEffects>["stageProviderEffect"];
  scheduleProviderEffect: (actionId: string, liveTarget?: ProviderEffectTarget) => void;
};

export function createTelegramAttachmentFailure(db: Db, options: TelegramAttachmentFailureOptions) {
  const { attachmentOmissionDetail, runtimeContextForRecord, endpointRecord, stageProviderEffect, scheduleProviderEffect } = options;


  async function settleTelegramAttachmentOnlyFailure(input: {
    activeDelivery: DeliveryRow;
    attachmentResult: {
      storedIds: string[];
      omissionReasons: Record<string, number>;
    };
    commentId: string;
    conversationId: string;
    endpoint: EndpointRow;
    message: Message;
    principalId: string | null;
    resourceId: string | null;
    runtimeContext?: InboundRuntimeContext;
    thread: Thread;
  }): Promise<boolean> {
    if (
      input.endpoint.provider !== "telegram" ||
      input.message.text.trim().length > 0 ||
      input.message.attachments.length === 0 ||
      input.attachmentResult.storedIds.length > 0
    ) {
      return false;
    }
    const diagnostic =
      attachmentOmissionDetail(input.attachmentResult) ??
      "The Telegram attachment could not be imported";
    const visibleFailure = `Paperclip could not safely import the attached Telegram file. Please resend it as a supported file under ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} or include text describing the request.`;
    const effectContext =
      input.runtimeContext ??
      runtimeContextForRecord(
        (await endpointRecord(input.endpoint.id)) ??
          (() => {
            throw new Error("Chat endpoint is unavailable");
          })(),
      );
    const effect = await db.transaction(async (tx) => {
      // Replace the optimistic attachment placeholder with an explicit safe
      // Paperclip-visible failure. The message link stays authoritative for
      // exact provider redelivery, while no agent wakeup is enqueued for an
      // empty turn that contains no usable bytes.
      await tx
        .update(issueComments)
        .set({ body: visibleFailure, updatedAt: new Date() })
        .where(
          and(
            eq(issueComments.id, input.commentId),
            eq(issueComments.companyId, input.endpoint.companyId),
          ),
        );
      await tx
        .update(chatActions)
        .set({
          status: "failed",
          result: { code: "inbound_wakeup_attachment_unavailable" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.deliveryId, input.activeDelivery.id),
            eq(chatActions.kind, "inbound_wakeup"),
            eq(chatActions.status, "preparing"),
          ),
        );
      const staged = await stageProviderEffect(tx, {
        endpoint: input.endpoint,
        deliveryId: input.activeDelivery.id,
        conversationId: input.conversationId,
        principalId: input.principalId,
        providerActionId: `provider_effect:attachment-ingest-failure:${input.activeDelivery.id}`,
        payload: {
          version: 1,
          authorizationMode: "safe_notice",
          effect: "thread_message",
          threadId: input.thread.id,
          text: visibleFailure,
          settleDelivery: false,
          ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        },
        runtimeContext: effectContext,
      });
      await notifyChatDeliveryWork(tx);
      await tx
        .update(chatDeliveries)
        .set({
          conversationId: input.conversationId,
          state: "processed",
          processedAt: new Date(),
          nextAttemptAt: null,
          redactedError: diagnostic,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatDeliveries.id, input.activeDelivery.id),
            eq(chatDeliveries.state, "processing"),
          ),
        );
      return staged;
    });
    if (!effect) throw new Error("Attachment failure notice was not persisted");
    // Posting the safe notice is its own durable outbox operation. A provider
    // outage must not turn the already-settled, deliberately unwoken inbound
    // delivery back into a replayable attachment message.
    scheduleProviderEffect(effect.id, input.thread);
    return true;
  }
  return { settleTelegramAttachmentOnlyFailure };
}
