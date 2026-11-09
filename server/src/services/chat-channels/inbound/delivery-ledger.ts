import type { LifecycleRuntimeFence } from "../runtime-types.js";

import {
  asc,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  chatActions,
  chatDeliveries,
} from "@paperclipai/db";

import {
  type ChatProviderLifecycleEffect,
} from "../../chat-provider-lifecycle.js";

type DeliveryRow = typeof chatDeliveries.$inferSelect;

const DELIVERY_PROCESSING_STALE_MS = 60_000;

  function deliveryContentWasRedacted(normalizedEvent: unknown): boolean {
    if (
      !normalizedEvent ||
      typeof normalizedEvent !== "object" ||
      Array.isArray(normalizedEvent)
    )
      return false;
    const filtering = (normalizedEvent as { filtering?: unknown }).filtering;
    return (
      Boolean(filtering) &&
      typeof filtering === "object" &&
      !Array.isArray(filtering) &&
      (filtering as { contentRetained?: unknown }).contentRetained === false
    );
  }

  function setupDestinationActivationSuppressed(
    normalizedEvent: unknown,
  ): boolean {
    if (
      !normalizedEvent ||
      typeof normalizedEvent !== "object" ||
      Array.isArray(normalizedEvent)
    )
      return false;
    const normalized = normalizedEvent as {
      admission?: { origin?: unknown };
      admissionAuthorization?: { version?: unknown };
    };
    return (
      normalized.admission?.origin === "provider_confirmed_action" ||
      normalized.admissionAuthorization?.version === 1
    );
  }

  function normalizedDeliveryThreadId(delivery: Pick<DeliveryRow, "normalizedEvent">): string | null {
    const normalized = delivery.normalizedEvent as {
      conversation?: { externalThreadId?: unknown };
    };
    return typeof normalized.conversation?.externalThreadId === "string"
      ? normalized.conversation.externalThreadId
      : null;
  }

  function normalizedLifecycleTargetEventId(
    delivery: Pick<DeliveryRow, "eventKind" | "normalizedEvent">,
  ): string | null {
    if (
      delivery.eventKind !== "message_updated" &&
      delivery.eventKind !== "message_deleted" &&
      delivery.eventKind !== "message_restored"
    )
      return null;
    const normalized = delivery.normalizedEvent as {
      message?: { targetProviderEventId?: unknown; admissionDependencyEventId?: unknown };
    };
    // An edit can also introduce a new addressed request. Process that durable
    // admission before waiting for the old, potentially unadmitted source.
    if (typeof normalized.message?.admissionDependencyEventId === "string")
      return normalized.message.admissionDependencyEventId;
    return typeof normalized.message?.targetProviderEventId === "string"
      ? normalized.message.targetProviderEventId
      : null;
  }

  function normalizedLifecycleEffect(
    delivery: Pick<DeliveryRow, "normalizedEvent">,
  ): ChatProviderLifecycleEffect | null {
    const normalized = delivery.normalizedEvent as { lifecycle?: unknown };
    const value = normalized.lifecycle;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const effect = value as Record<string, unknown>;
    if (
      (effect.provider !== "slack" &&
        effect.provider !== "github" &&
        effect.provider !== "discord" &&
        effect.provider !== "microsoft-teams" &&
        effect.provider !== "telegram") ||
      typeof effect.providerEventId !== "string"
    )
      return null;
    if (
      effect.kind === "endpoint" &&
      (effect.availability === "available" ||
        effect.availability === "attention" ||
        effect.availability === "revoked") &&
      typeof effect.reason === "string"
    )
      return effect as ChatProviderLifecycleEffect;
    if (
      effect.kind === "resource" &&
      (effect.availability === "available" ||
        effect.availability === "unavailable" ||
        effect.availability === "removed") &&
      typeof effect.providerResourceId === "string" &&
      (effect.previousProviderResourceId === undefined ||
        typeof effect.previousProviderResourceId === "string") &&
      typeof effect.resourceType === "string" &&
      typeof effect.label === "string"
    )
      return effect as ChatProviderLifecycleEffect;
    return null;
  }

  function deliveryReady(delivery: DeliveryRow, now: Date): boolean {
    // Accepted input may still own the conversation head through its wake
    // outbox. The action dispatcher checks its own retry/claim deadline.
    if (delivery.state === "processed") return true;
    if (delivery.state === "received")
      return !delivery.nextAttemptAt || delivery.nextAttemptAt <= now;
    if (delivery.state === "retry") {
      return !delivery.nextAttemptAt || delivery.nextAttemptAt <= now;
    }
    return (
      delivery.state === "processing" &&
      delivery.updatedAt <=
        new Date(now.getTime() - DELIVERY_PROCESSING_STALE_MS)
    );
  }

  function conversationDeliveryOrder() {
    return [
      asc(
        sql`coalesce(nullif(${chatDeliveries.normalizedEvent}->'message'->>'providerSentAt', '')::timestamptz, ${chatDeliveries.receivedAt})`,
      ),
      // GitHub timestamps and Telegram message dates have one-second
      // resolution. GitHub's numeric comment id and Telegram's message_id
      // are monotonic within one conversation, so use them before receipt
      // order. The Telegram update_id is a final provider-native tie-breaker
      // for unusual payloads that lack a usable message_id.
      asc(sql`coalesce(
        case
          when ${chatDeliveries.normalizedEvent}->'message'->>'providerMessageSequence' ~ '^[0-9]+$'
          then (${chatDeliveries.normalizedEvent}->'message'->>'providerMessageSequence')::numeric
          else null
        end,
        case
          when ${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId' ~ '^[0-9]+$'
          then (${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId')::numeric
          else null
        end
      )`),
      asc(sql`case
        when ${chatDeliveries.normalizedEvent}->'message'->>'providerUpdateId' ~ '^[0-9]+$'
        then (${chatDeliveries.normalizedEvent}->'message'->>'providerUpdateId')::numeric
        else null
      end`),
      // GitHub exposes no sortable webhook sequence. When an edit and delete
      // share its whole-second updated_at value, preserve the only valid
      // lifecycle state transition: update before delete. Provider-native
      // update ids (Telegram) remain the stronger preceding key.
      asc(sql`case ${chatDeliveries.eventKind}
        when 'message_updated' then 1
        when 'message_deleted' then 2
        when 'message_restored' then 3
        else 0
      end`),
      asc(chatDeliveries.receivedAt),
      asc(chatDeliveries.id),
    ];
  }

  function pendingInboundWakeupCondition(readyOnly = false): SQL {
    if (!readyOnly) {
      return sql`(${chatDeliveries.companyId}, ${chatDeliveries.endpointId}, ${chatDeliveries.id}) in (
        select ${chatActions.companyId}, ${chatActions.endpointId}, ${chatActions.deliveryId}
        from ${chatActions}
        where ${chatActions.kind} = 'inbound_wakeup'
          and ${chatActions.deliveryId} is not null
          and ${chatActions.status} in ('issued', 'processing')
      )`;
    }
    return sql`exists (
      select 1 from ${chatActions}
      where ${chatActions.deliveryId} = ${chatDeliveries.id}
        and ${chatActions.endpointId} = ${chatDeliveries.endpointId}
        and ${chatActions.companyId} = ${chatDeliveries.companyId}
        and ${chatActions.kind} = 'inbound_wakeup'
        and ${chatActions.status} in ('issued', 'processing')
        ${
          readyOnly
            ? sql`and (
          (${chatActions.status} = 'issued' and (${chatActions.result}->>'retryAt' is null or (${chatActions.result}->>'retryAt')::timestamptz <= now()))
          or (${chatActions.status} = 'processing' and ${chatActions.updatedAt} <= ${new Date(Date.now() - DELIVERY_PROCESSING_STALE_MS).toISOString()}::timestamptz)
        )`
            : sql``
        }
    )`;
  }

  function lifecycleRuntimeFence(
    delivery: DeliveryRow,
  ): LifecycleRuntimeFence | null {
    const normalized = delivery.normalizedEvent;
    if (
      !normalized ||
      typeof normalized !== "object" ||
      Array.isArray(normalized)
    )
      return null;
    const value = (normalized as Record<string, unknown>).runtimeContext;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const context = value as Record<string, unknown>;
    return typeof context.generation === "number" &&
      Number.isSafeInteger(context.generation) &&
      typeof context.credentialFingerprint === "string"
      ? {
          generation: context.generation as number,
          credentialFingerprint: context.credentialFingerprint,
        }
      : null;
  }

  function normalizedLifecycleWithRuntimeFence(
    delivery: DeliveryRow,
    runtimeContext: LifecycleRuntimeFence,
  ): Record<string, unknown> {
    const normalized =
      delivery.normalizedEvent &&
      typeof delivery.normalizedEvent === "object" &&
      !Array.isArray(delivery.normalizedEvent)
        ? (delivery.normalizedEvent as Record<string, unknown>)
        : {};
    return { ...normalized, runtimeContext };
  }

export { DELIVERY_PROCESSING_STALE_MS, deliveryContentWasRedacted, setupDestinationActivationSuppressed, normalizedDeliveryThreadId, normalizedLifecycleTargetEventId, normalizedLifecycleEffect, deliveryReady, conversationDeliveryOrder, pendingInboundWakeupCondition, lifecycleRuntimeFence, normalizedLifecycleWithRuntimeFence };
