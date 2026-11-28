import crypto from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { webhookDeliveries, webhookEndpoints } from "@paperclipai/db";
import type { CreateWebhook, UpdateWebhook } from "@paperclipai/shared";

const MAX_RESPONSE_BODY_BYTES = 4096;

function generateSecret() {
  return crypto.randomBytes(32).toString("hex");
}

function signPayload(secret: string, body: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function webhookService(db: Db) {
  async function list(companyId: string) {
    return db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.companyId, companyId))
      .orderBy(asc(webhookEndpoints.createdAt));
  }

  async function getById(id: string) {
    return db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function create(companyId: string, input: CreateWebhook) {
    const [created] = await db
      .insert(webhookEndpoints)
      .values({
        companyId,
        url: input.url,
        events: input.events,
        enabled: input.enabled ?? true,
        signingSecret: generateSecret(),
      })
      .returning();
    return created!;
  }

  async function update(id: string, input: UpdateWebhook) {
    const patch: Partial<typeof webhookEndpoints.$inferInsert> = {};
    if (input.url !== undefined) patch.url = input.url;
    if (input.events !== undefined) patch.events = input.events;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    patch.updatedAt = new Date();

    const [updated] = await db
      .update(webhookEndpoints)
      .set(patch)
      .where(eq(webhookEndpoints.id, id))
      .returning();
    return updated ?? null;
  }

  async function rotateSecret(id: string) {
    const newSecret = generateSecret();
    const [updated] = await db
      .update(webhookEndpoints)
      .set({ signingSecret: newSecret, updatedAt: new Date() })
      .where(eq(webhookEndpoints.id, id))
      .returning();
    if (!updated) return null;
    return { secret: newSecret };
  }

  async function remove(id: string) {
    const [deleted] = await db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .returning();
    return deleted ?? null;
  }

  async function dispatch(companyId: string, event: string, payload: unknown) {
    const endpoints = await db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.companyId, companyId),
          eq(webhookEndpoints.enabled, true),
        ),
      );

    const eligible = endpoints.filter(
      (ep) => ep.events.length === 0 || ep.events.includes(event),
    );

    await Promise.allSettled(
      eligible.map((ep) => dispatchToEndpoint(ep, event, payload)),
    );
  }

  async function dispatchToEndpoint(
    ep: typeof webhookEndpoints.$inferSelect,
    event: string,
    payload: unknown,
  ) {
    const body = JSON.stringify({ event, data: payload });
    const signature = signPayload(ep.signingSecret, body);

    let responseCode: number | null = null;
    let responseBody: string | null = null;
    let errorMessage: string | null = null;
    let deliveredAt: Date | null = null;

    try {
      const res = await fetch(ep.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Paperclip-Signature": signature,
          "X-Paperclip-Event": event,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      responseCode = res.status;
      const rawBody = await res.text();
      responseBody = rawBody.slice(0, MAX_RESPONSE_BODY_BYTES);
      if (res.ok) deliveredAt = new Date();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    await db.insert(webhookDeliveries).values({
      endpointId: ep.id,
      event,
      payload: body,
      responseCode,
      responseBody,
      errorMessage,
      deliveredAt,
    });
  }

  async function listDeliveries(endpointId: string, limit = 50) {
    return db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpointId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit);
  }

  return { list, getById, create, update, rotateSecret, remove, dispatch, listDeliveries };
}
