import crypto from "node:crypto";
import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { webhookEndpoints, webhookDeliveries } from "@paperclipai/db";
import type {
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointListItem,
  WebhookEventType,
  WebhookPayload,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

const CONSECUTIVE_FAILURE_DISABLE_THRESHOLD = 100;
const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const MAX_DELIVERIES_PER_WEBHOOK = 200;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

function generateHmacSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

function computeHmacSignature(secret: string, body: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function computePayloadHash(payload: WebhookPayload): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function webhookService(db: Db) {
  async function list(companyId: string): Promise<WebhookEndpointListItem[]> {
    const rows = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.companyId, companyId))
      .orderBy(desc(webhookEndpoints.createdAt));

    return rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      name: r.name,
      url: r.url,
      eventTypes: r.eventTypes,
      active: r.active,
      consecutiveFailures: r.consecutiveFailures,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async function get(id: string, companyId: string): Promise<WebhookEndpoint | null> {
    const [row] = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.companyId, companyId)));

    if (!row) return null;
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      url: row.url,
      secret: row.secret,
      eventTypes: row.eventTypes,
      active: row.active,
      consecutiveFailures: row.consecutiveFailures,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function create(
    companyId: string,
    input: { name: string; url: string; eventTypes: WebhookEventType[]; active?: boolean },
  ): Promise<WebhookEndpoint> {
    const [row] = await db
      .insert(webhookEndpoints)
      .values({
        companyId,
        name: input.name,
        url: input.url,
        secret: generateHmacSecret(),
        eventTypes: input.eventTypes,
        active: input.active ?? true,
      })
      .returning();

    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      url: row.url,
      secret: row.secret,
      eventTypes: row.eventTypes,
      active: row.active,
      consecutiveFailures: row.consecutiveFailures,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function update(
    id: string,
    companyId: string,
    input: {
      name?: string;
      url?: string;
      eventTypes?: WebhookEventType[];
      active?: boolean;
    },
  ): Promise<WebhookEndpoint | null> {
    const patch: Partial<typeof webhookEndpoints.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.url !== undefined) patch.url = input.url;
    if (input.eventTypes !== undefined) patch.eventTypes = input.eventTypes;
    if (input.active !== undefined) patch.active = input.active;

    const [row] = await db
      .update(webhookEndpoints)
      .set(patch)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.companyId, companyId)))
      .returning();

    if (!row) return null;
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      url: row.url,
      secret: row.secret,
      eventTypes: row.eventTypes,
      active: row.active,
      consecutiveFailures: row.consecutiveFailures,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function remove(id: string, companyId: string): Promise<boolean> {
    const [row] = await db
      .delete(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.companyId, companyId)))
      .returning({ id: webhookEndpoints.id });

    return !!row;
  }

  async function listDeliveries(webhookId: string, companyId: string): Promise<WebhookDelivery[]> {
    const webhook = await get(webhookId, companyId);
    if (!webhook) return [];

    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(MAX_DELIVERIES_PER_WEBHOOK);

    return rows.map((r) => ({
      id: r.id,
      webhookId: r.webhookId,
      eventType: r.eventType,
      status: r.status,
      attempt: r.attempt,
      nextAttemptAt: r.nextAttemptAt,
      httpStatus: r.httpStatus,
      latencyMs: r.latencyMs,
      payloadHash: r.payloadHash,
      payload: r.payload,
      responseBody: r.responseBody,
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async function executeDelivery(deliveryId: string): Promise<void> {
    const [deliveryRow] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));

    if (!deliveryRow) return;

    const [webhookRow] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, deliveryRow.webhookId));

    if (!webhookRow) return;

    const payloadJson = JSON.stringify(deliveryRow.payload);
    const signature = computeHmacSignature(webhookRow.secret, payloadJson);
    const start = Date.now();

    let httpStatus: number | null = null;
    let responseBody: string | null = null;
    let error: string | null = null;
    let success = false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
      try {
        const response = await fetch(webhookRow.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Solaris-Signature": signature,
            "X-Solaris-Event": deliveryRow.eventType,
            "User-Agent": "Solaris-Webhooks/1.0",
          },
          body: payloadJson,
          signal: controller.signal,
        });
        httpStatus = response.status;
        responseBody = (await response.text()).slice(0, 4096);
        success = response.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const latencyMs = Date.now() - start;
    const nextAttempt = deliveryRow.attempt + 1;

    if (success) {
      await db
        .update(webhookDeliveries)
        .set({ status: "success", httpStatus, latencyMs, responseBody, updatedAt: new Date() })
        .where(eq(webhookDeliveries.id, deliveryId));

      await db
        .update(webhookEndpoints)
        .set({ consecutiveFailures: 0, updatedAt: new Date() })
        .where(eq(webhookEndpoints.id, webhookRow.id));
    } else if (nextAttempt <= MAX_ATTEMPTS) {
      const delayMs = RETRY_DELAYS_MS[deliveryRow.attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!;
      const nextAttemptAt = new Date(Date.now() + delayMs);
      await db
        .update(webhookDeliveries)
        .set({
          status: "retrying",
          httpStatus,
          latencyMs,
          responseBody,
          error,
          attempt: nextAttempt,
          nextAttemptAt,
          updatedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, deliveryId));
    } else {
      await db
        .update(webhookDeliveries)
        .set({
          status: "failed",
          httpStatus,
          latencyMs,
          responseBody,
          error,
          updatedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, deliveryId));

      const newFailures = webhookRow.consecutiveFailures + 1;
      const shouldDisable = newFailures >= CONSECUTIVE_FAILURE_DISABLE_THRESHOLD;
      await db
        .update(webhookEndpoints)
        .set({
          consecutiveFailures: newFailures,
          active: shouldDisable ? false : webhookRow.active,
          updatedAt: new Date(),
        })
        .where(eq(webhookEndpoints.id, webhookRow.id));

      if (shouldDisable) {
        logger.warn({ webhookId: webhookRow.id, url: webhookRow.url }, "Webhook auto-disabled after 100 consecutive failures");
      }
    }

    await pruneDeliveries(webhookRow.id);
  }

  async function deliverEvent(
    companyId: string,
    eventType: WebhookEventType,
    data: Record<string, unknown>,
  ): Promise<void> {
    const activeWebhooks = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.companyId, companyId), eq(webhookEndpoints.active, true)));

    const subscribed = activeWebhooks.filter((w) =>
      (w.eventTypes as WebhookEventType[]).includes(eventType),
    );

    if (subscribed.length === 0) return;

    const payload: WebhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      org_id: companyId,
      data,
    };
    const payloadHash = computePayloadHash(payload);

    await Promise.allSettled(
      subscribed.map(async (webhook) => {
        const [delivery] = await db
          .insert(webhookDeliveries)
          .values({
            webhookId: webhook.id,
            eventType,
            status: "pending",
            attempt: 1,
            payloadHash,
            payload: payload as unknown as Record<string, unknown>,
          })
          .returning();

        void executeDelivery(delivery.id).catch((err) => {
          logger.error({ err, deliveryId: delivery.id }, "Webhook delivery error");
        });
      }),
    );
  }

  async function testWebhook(id: string, companyId: string): Promise<{ deliveryId: string } | null> {
    const webhook = await get(id, companyId);
    if (!webhook) return null;

    const payload: WebhookPayload = {
      event: "ping",
      timestamp: new Date().toISOString(),
      org_id: companyId,
      data: { message: "Webhook test ping from Solaris" },
    };
    const payloadHash = computePayloadHash(payload);

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        webhookId: id,
        eventType: "ping",
        status: "pending",
        attempt: 1,
        payloadHash,
        payload: payload as unknown as Record<string, unknown>,
      })
      .returning();

    void executeDelivery(delivery.id).catch((err) => {
      logger.error({ err, deliveryId: delivery.id }, "Webhook test delivery error");
    });

    return { deliveryId: delivery.id };
  }

  async function retryDelivery(deliveryId: string, companyId: string): Promise<boolean> {
    const [row] = await db
      .select({ webhookId: webhookDeliveries.webhookId })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));

    if (!row) return false;

    const webhook = await get(row.webhookId, companyId);
    if (!webhook) return false;

    await db
      .update(webhookDeliveries)
      .set({ status: "pending", attempt: 1, nextAttemptAt: null, updatedAt: new Date() })
      .where(eq(webhookDeliveries.id, deliveryId));

    void executeDelivery(deliveryId).catch((err) => {
      logger.error({ err, deliveryId }, "Webhook retry delivery error");
    });

    return true;
  }

  async function processPendingRetries(): Promise<void> {
    const now = new Date();
    const due = await db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.status, "retrying"),
          isNotNull(webhookDeliveries.nextAttemptAt),
          lte(webhookDeliveries.nextAttemptAt, now),
        ),
      )
      .limit(50);

    await Promise.allSettled(
      due.map((d) =>
        executeDelivery(d.id).catch((err) => {
          logger.error({ err, deliveryId: d.id }, "Webhook retry execution error");
        }),
      ),
    );
  }

  async function pruneDeliveries(webhookId: string): Promise<void> {
    const rows = await db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.createdAt));

    if (rows.length > MAX_DELIVERIES_PER_WEBHOOK) {
      const toDelete = rows.slice(MAX_DELIVERIES_PER_WEBHOOK).map((r) => r.id);
      await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.id, toDelete));
    }
  }

  return {
    list,
    get,
    create,
    update,
    remove,
    listDeliveries,
    deliverEvent,
    testWebhook,
    retryDelivery,
    processPendingRetries,
  };
}
