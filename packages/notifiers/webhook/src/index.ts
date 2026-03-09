import crypto from "node:crypto";
import type { NotificationEvent } from "@paperclipai/shared";

export const type = "webhook";
export const label = "Webhook";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "metadata.google.internal",
]);

const PRIVATE_IP_PREFIXES = [
  "10.",
  "172.16.", "172.17.", "172.18.", "172.19.",
  "172.20.", "172.21.", "172.22.", "172.23.",
  "172.24.", "172.25.", "172.26.", "172.27.",
  "172.28.", "172.29.", "172.30.", "172.31.",
  "192.168.",
  "169.254.",
];

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

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export async function send(
  event: NotificationEvent,
  config: Record<string, unknown>,
): Promise<void> {
  const url = config.url as string;
  if (!url || isBlockedUrl(url)) {
    throw new Error(`Blocked or invalid webhook URL`);
  }

  const body = JSON.stringify({
    event: event.type,
    companyId: event.companyId,
    timestamp: event.occurredAt,
    data: {
      actor: event.actor,
      entity: event.entity,
      ...event.payload,
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Paperclip-Webhooks/1.0",
  };

  const secret = config.secret as string | undefined;
  if (secret) {
    const signature = sign(body, secret);
    headers["X-Paperclip-Signature"] = `sha256=${signature}`;
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
      throw new Error(`Webhook delivery returned ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function testConnection(
  config: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const url = config.url as string;
  if (!url) return { ok: false, error: "Missing url in config" };
  if (isBlockedUrl(url)) return { ok: false, error: "URL is blocked (private/internal address)" };

  const body = JSON.stringify({
    event: "test",
    companyId: "test",
    timestamp: new Date().toISOString(),
    data: { test: true, message: "Paperclip webhook connection test" },
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Paperclip-Webhooks/1.0",
  };

  const secret = config.secret as string | undefined;
  if (secret) {
    const signature = sign(body, secret);
    headers["X-Paperclip-Signature"] = `sha256=${signature}`;
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
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
