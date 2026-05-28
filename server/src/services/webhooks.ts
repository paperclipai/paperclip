import { randomBytes, createHmac } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { webhooks, webhookDeliveries } from "@paperclipai/db";
import type { WebhookEventType, WebhookDeliveryStatus } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

interface WebhookRow {
  id: string;
  companyId: string;
  url: string;
  secret: string;
  eventTypes: WebhookEventType[];
  metadataFilter: Record<string, unknown> | null;
  description: string | null;
  active: string;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const RETRY_DELAYS_MS = [30_000, 60_000, 120_000];

export function webhookService(db: Db) {
  async function create(
    companyId: string,
    input: {
      url: string;
      eventTypes: WebhookEventType[];
      metadataFilter?: Record<string, unknown> | null;
      description?: string | null;
      secret?: string;
    },
    actor: { userId?: string | null; agentId?: string | null },
  ) {
    const secret = input.secret ?? randomBytes(32).toString("hex");
    const [row] = await db
      .insert(webhooks)
      .values({
        companyId,
        url: input.url,
        secret,
        eventTypes: input.eventTypes,
        metadataFilter: input.metadataFilter ?? undefined,
        description: input.description ?? undefined,
        createdByUserId: actor.userId ?? undefined,
        createdByAgentId: actor.agentId ?? undefined,
      })
      .returning();
    return row;
  }

  async function list(companyId: string) {
    return db
      .select({
        id: webhooks.id,
        companyId: webhooks.companyId,
        url: webhooks.url,
        eventTypes: webhooks.eventTypes,
        metadataFilter: webhooks.metadataFilter,
        description: webhooks.description,
        active: webhooks.active,
        createdAt: webhooks.createdAt,
        updatedAt: webhooks.updatedAt,
      })
      .from(webhooks)
      .where(eq(webhooks.companyId, companyId));
  }

  async function get(id: string) {
    const [row] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, id));
    return row ?? null;
  }

  async function remove(id: string) {
    const [row] = await db
      .delete(webhooks)
      .where(eq(webhooks.id, id))
      .returning();
    return row ?? null;
  }

  async function getActiveWebhooksForEvent(
    companyId: string,
    eventType: WebhookEventType,
  ) {
    const rows = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.companyId, companyId), eq(webhooks.active, "true")));
    return rows.filter((w: WebhookRow) => w.eventTypes.includes(eventType));
  }

  function signPayload(secret: string, payload: string): string {
    return createHmac("sha256", secret).update(payload).digest("hex");
  }

  function matchesMetadataFilter(
    filter: Record<string, unknown> | null | undefined,
    metadata: Record<string, unknown> | null | undefined,
  ): boolean {
    if (!filter) return true;
    if (!metadata) return false;
    for (const [key, value] of Object.entries(filter)) {
      if (metadata[key] !== value) return false;
    }
    return true;
  }

  async function dispatchEvent(
    companyId: string,
    eventType: WebhookEventType,
    payload: Record<string, unknown>,
  ) {
    const activeWebhooks = await getActiveWebhooksForEvent(companyId, eventType);
    const issueMetadata = (payload.metadata as Record<string, unknown>) ?? null;

    const matchingWebhooks = activeWebhooks.filter((w: WebhookRow) =>
      matchesMetadataFilter(w.metadataFilter, issueMetadata),
    );

    for (const webhook of matchingWebhooks) {
      const [delivery] = await db
        .insert(webhookDeliveries)
        .values({
          webhookId: webhook.id,
          eventType,
          payload,
          status: "pending" as WebhookDeliveryStatus,
          attempt: 0,
          maxAttempts: 3,
        })
        .returning();

      deliverWebhook(webhook, delivery).catch((err) => {
        logger.error({ err, deliveryId: delivery.id }, "webhook delivery failed");
      });
    }
  }

  async function deliverWebhook(
    webhook: { id: string; url: string; secret: string },
    delivery: { id: string; payload: Record<string, unknown>; attempt: number; maxAttempts: number },
  ) {
    const body = JSON.stringify(delivery.payload);
    const signature = signPayload(webhook.secret, body);
    let attempt = delivery.attempt;

    while (attempt < delivery.maxAttempts) {
      attempt += 1;
      await db
        .update(webhookDeliveries)
        .set({ status: "delivering" as WebhookDeliveryStatus, attempt })
        .where(eq(webhookDeliveries.id, delivery.id));

      try {
        const response = await fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Paperclip-Signature": `sha256=${signature}`,
            "X-Paperclip-Event": (delivery.payload as Record<string, unknown>).event as string ?? "",
            "X-Paperclip-Delivery": delivery.id,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
          await db
            .update(webhookDeliveries)
            .set({
              status: "delivered" as WebhookDeliveryStatus,
              responseStatus: response.status,
              deliveredAt: new Date(),
            })
            .where(eq(webhookDeliveries.id, delivery.id));
          return;
        }

        const responseBody = await response.text().catch(() => "");
        if (attempt >= delivery.maxAttempts) {
          await db
            .update(webhookDeliveries)
            .set({
              status: "failed" as WebhookDeliveryStatus,
              responseStatus: response.status,
              responseBody: responseBody.slice(0, 4096),
              error: `HTTP ${response.status}`,
            })
            .where(eq(webhookDeliveries.id, delivery.id));
          return;
        }

        await db
          .update(webhookDeliveries)
          .set({
            responseStatus: response.status,
            responseBody: responseBody.slice(0, 4096),
            nextRetryAt: new Date(Date.now() + RETRY_DELAYS_MS[attempt - 1]),
          })
          .where(eq(webhookDeliveries.id, delivery.id));
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        if (attempt >= delivery.maxAttempts) {
          await db
            .update(webhookDeliveries)
            .set({
              status: "failed" as WebhookDeliveryStatus,
              error: errorMsg,
            })
            .where(eq(webhookDeliveries.id, delivery.id));
          return;
        }

        await db
          .update(webhookDeliveries)
          .set({
            error: errorMsg,
            nextRetryAt: new Date(Date.now() + RETRY_DELAYS_MS[attempt - 1]),
          })
          .where(eq(webhookDeliveries.id, delivery.id));
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }
  }

  return { create, list, get, remove, dispatchEvent };
}
