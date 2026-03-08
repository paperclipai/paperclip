import crypto from "node:crypto";
import type { Db } from "@paperclipai/db";
import { webhooks } from "@paperclipai/db";
import type { WebhookEventType } from "@paperclipai/shared";
import { eq, and } from "drizzle-orm";

export interface WebhookPayload {
  event: string;
  companyId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "metadata.google.internal"]);
const PRIVATE_IP_PREFIXES = ["10.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.", "192.168.", "169.254."];

function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(hostname)) return true;
    if (PRIVATE_IP_PREFIXES.some((prefix) => hostname.startsWith(prefix))) return true;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return true;
    return false;
  } catch {
    return true;
  }
}

function stripSecret<T extends Record<string, unknown>>(row: T): Omit<T, "secret"> {
  const { secret: _, ...rest } = row;
  return rest as Omit<T, "secret">;
}

async function deliver(url: string, payload: WebhookPayload, secret?: string | null) {
  if (isBlockedUrl(url)) {
    console.warn(`[webhooks] blocked delivery to private/internal URL: ${url}`);
    return;
  }

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Paperclip-Webhooks/1.0",
  };
  if (secret) {
    headers["X-Paperclip-Signature"] = `sha256=${sign(body, secret)}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[webhooks] delivery to ${url} returned ${response.status}`);
    }
  } catch (err) {
    console.warn(`[webhooks] delivery failed for ${url}: ${err instanceof Error ? err.message : err}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function webhookService(db: Db) {
  return {
    async list(companyId: string) {
      return db
        .select({
          id: webhooks.id,
          companyId: webhooks.companyId,
          url: webhooks.url,
          events: webhooks.events,
          enabled: webhooks.enabled,
          description: webhooks.description,
          createdAt: webhooks.createdAt,
          updatedAt: webhooks.updatedAt,
        })
        .from(webhooks)
        .where(eq(webhooks.companyId, companyId));
    },

    async getById(id: string) {
      const rows = await db.select().from(webhooks).where(eq(webhooks.id, id));
      return rows[0] ?? null;
    },

    async create(
      companyId: string,
      input: { url: string; secret?: string | null; events: string[]; description?: string | null; enabled?: boolean },
    ) {
      const rows = await db
        .insert(webhooks)
        .values({
          companyId,
          url: input.url,
          secret: input.secret ?? null,
          events: input.events,
          description: input.description ?? null,
          enabled: input.enabled ?? true,
        })
        .returning();
      return stripSecret(rows[0]);
    },

    async update(id: string, input: Partial<{ url: string; secret: string | null; events: string[]; description: string | null; enabled: boolean }>) {
      const values: Record<string, unknown> = { updatedAt: new Date() };
      if (input.url !== undefined) values.url = input.url;
      if (input.secret !== undefined) values.secret = input.secret;
      if (input.events !== undefined) values.events = input.events;
      if (input.description !== undefined) values.description = input.description;
      if (input.enabled !== undefined) values.enabled = input.enabled;

      const rows = await db.update(webhooks).set(values).where(eq(webhooks.id, id)).returning();
      return rows[0] ? stripSecret(rows[0]) : null;
    },

    async remove(id: string) {
      const rows = await db.delete(webhooks).where(eq(webhooks.id, id)).returning();
      return rows[0] ?? null;
    },

    async deliverTo(hook: { url: string; secret?: string | null; companyId: string }, event: WebhookEventType, data: Record<string, unknown>) {
      const payload: WebhookPayload = {
        event,
        companyId: hook.companyId,
        timestamp: new Date().toISOString(),
        data,
      };
      await deliver(hook.url, payload, hook.secret);
    },

    async dispatch(companyId: string, event: WebhookEventType, data: Record<string, unknown>) {
      const hooks = await db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.companyId, companyId), eq(webhooks.enabled, true)));

      const matching = hooks.filter((h) => {
        const events = h.events as string[];
        return events.includes(event) || events.includes("*");
      });

      if (matching.length === 0) return;

      const payload: WebhookPayload = {
        event,
        companyId,
        timestamp: new Date().toISOString(),
        data,
      };

      await Promise.allSettled(matching.map((h) => deliver(h.url, payload, h.secret)));
    },
  };
}

// Exported for testing
export { sign as _signForTest, deliver as _deliverForTest, isBlockedUrl as _isBlockedUrlForTest };
