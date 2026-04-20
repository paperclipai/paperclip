import { randomUUID, createHmac } from "node:crypto";
import { and, eq, desc, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { webhooks, webhookDeliveries } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";

const RETRY_DELAYS_MS = [
  10_000, // 10s
  60_000, // 1m
  300_000, // 5m
  1_800_000, // 30m
  3_600_000, // 1h
];

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function webhookService(db: Db) {
  return {
    list: async (companyId: string) => {
      return db.select().from(webhooks).where(eq(webhooks.companyId, companyId)).orderBy(desc(webhooks.createdAt));
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(webhooks)
        .where(eq(webhooks.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Webhook not found");
      return row;
    },

    create: async (
      companyId: string,
      input: {
        url: string;
        secret?: string | null;
        description?: string | null;
        eventTypes?: string[] | null;
        projectId?: string | null;
        active?: boolean;
      },
    ) => {
      const [row] = await db
        .insert(webhooks)
        .values({
          companyId,
          url: input.url,
          secret: input.secret ?? null,
          description: input.description ?? null,
          eventTypes: input.eventTypes ?? null,
          projectId: input.projectId ?? null,
          active: input.active ?? true,
        })
        .returning();
      return row;
    },

    update: async (
      id: string,
      input: {
        url?: string;
        secret?: string | null;
        description?: string | null;
        eventTypes?: string[] | null;
        projectId?: string | null;
        active?: boolean;
      },
    ) => {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.url !== undefined) updates.url = input.url;
      if (input.secret !== undefined) updates.secret = input.secret;
      if (input.description !== undefined) updates.description = input.description;
      if (input.eventTypes !== undefined) updates.eventTypes = input.eventTypes;
      if (input.projectId !== undefined) updates.projectId = input.projectId;
      if (input.active !== undefined) updates.active = input.active;

      const [row] = await db.update(webhooks).set(updates).where(eq(webhooks.id, id)).returning();
      if (!row) throw notFound("Webhook not found");
      return row;
    },

    delete: async (id: string) => {
      const [row] = await db.delete(webhooks).where(eq(webhooks.id, id)).returning();
      if (!row) throw notFound("Webhook not found");
      return row;
    },

    listDeliveries: async (webhookId: string, opts?: { limit?: number; offset?: number }) => {
      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;
      return db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, webhookId))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(limit)
        .offset(offset);
    },

    getDeliveryById: async (id: string) => {
      const row = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Webhook delivery not found");
      return row;
    },
  };
}

export interface WebhookEvent {
  eventId: string;
  eventType: string;
  companyId: string;
  entityType: string;
  entityId: string;
  actorType: string;
  actorId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/**
 * Dispatches a domain event to all matching webhooks for a company.
 * Runs asynchronously — does not block the caller.
 */
export async function dispatchWebhookEvent(db: Db, event: WebhookEvent): Promise<void> {
  const activeWebhooks = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.companyId, event.companyId), eq(webhooks.active, true)));

  for (const webhook of activeWebhooks) {
    // Filter by event type if webhook has a filter configured
    if (webhook.eventTypes && webhook.eventTypes.length > 0) {
      if (!webhook.eventTypes.includes(event.eventType)) continue;
    }

    // Filter by project if webhook is scoped to a project
    if (webhook.projectId) {
      const projectId = (event.payload as Record<string, unknown>).projectId as string | undefined;
      if (projectId && projectId !== webhook.projectId) continue;
    }

    // Create delivery record
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        webhookId: webhook.id,
        eventId: event.eventId,
        eventType: event.eventType,
        payload: {
          event: event.eventType,
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          entityType: event.entityType,
          entityId: event.entityId,
          actorType: event.actorType,
          actorId: event.actorId,
          data: event.payload,
        },
        status: "pending",
        attempts: 0,
        maxAttempts: 5,
      })
      .returning();

    // Attempt delivery immediately
    void attemptDelivery(
      db,
      delivery.id,
      webhook.url,
      webhook.secret,
      delivery.payload as Record<string, unknown>,
    ).catch((err) => {
      logger.warn({ err, deliveryId: delivery.id }, "webhook delivery attempt failed");
    });
  }
}

async function attemptDelivery(
  db: Db,
  deliveryId: string,
  url: string,
  secret: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Paperclip-Webhooks/1.0",
    "X-Webhook-Id": deliveryId,
  };

  if (secret) {
    headers["X-Webhook-Signature"] = `sha256=${signPayload(body, secret)}`;
  }

  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let success = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    statusCode = response.status;
    responseBody = await response.text().catch(() => null);
    // Truncate large response bodies
    if (responseBody && responseBody.length > 4096) {
      responseBody = responseBody.slice(0, 4096) + "...[truncated]";
    }
    success = response.ok;
  } catch (err) {
    responseBody = err instanceof Error ? err.message : "Unknown error";
  }

  // Get current delivery state to determine attempt count
  const [current] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
  if (!current) return;

  const attempts = current.attempts + 1;
  const now = new Date();

  if (success) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "success",
        statusCode,
        responseBody,
        attempts,
        lastAttemptAt: now,
        completedAt: now,
      })
      .where(eq(webhookDeliveries.id, deliveryId));
  } else if (attempts >= current.maxAttempts) {
    // Max retries exhausted — move to dead letter
    await db
      .update(webhookDeliveries)
      .set({
        status: "dead_letter",
        statusCode,
        responseBody,
        attempts,
        lastAttemptAt: now,
        completedAt: now,
      })
      .where(eq(webhookDeliveries.id, deliveryId));
  } else {
    // Schedule retry with exponential backoff
    const delayMs = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
    const nextRetryAt = new Date(now.getTime() + delayMs);
    await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        statusCode,
        responseBody,
        attempts,
        lastAttemptAt: now,
        nextRetryAt,
      })
      .where(eq(webhookDeliveries.id, deliveryId));
  }
}

/**
 * Process pending retries. Call this periodically (e.g., every 30s).
 */
export async function processWebhookRetries(db: Db): Promise<number> {
  const now = new Date();
  const pendingRetries = await db
    .select({
      delivery: webhookDeliveries,
      webhookUrl: webhooks.url,
      webhookSecret: webhooks.secret,
      webhookActive: webhooks.active,
    })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
    .where(and(eq(webhookDeliveries.status, "failed"), lte(webhookDeliveries.nextRetryAt, now)))
    .limit(100);

  let processed = 0;
  for (const { delivery, webhookUrl, webhookSecret, webhookActive } of pendingRetries) {
    if (!webhookActive) {
      // Webhook was deactivated — move to dead letter
      await db
        .update(webhookDeliveries)
        .set({
          status: "dead_letter",
          completedAt: now,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      processed++;
      continue;
    }

    void attemptDelivery(db, delivery.id, webhookUrl, webhookSecret, delivery.payload as Record<string, unknown>).catch(
      (err) => {
        logger.warn({ err, deliveryId: delivery.id }, "webhook retry attempt failed");
      },
    );
    processed++;
  }

  return processed;
}
