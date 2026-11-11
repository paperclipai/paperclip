import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { guardedRemoteHttpFetch } from "../remote-http-fetch.js";

export class McpEventError extends Error {
  constructor(readonly code: number, message: string, readonly reason?: string) { super(message); }
}
export type EventFetch = (url: string, init: RequestInit) => Promise<Response>;
export const eventFetch: EventFetch = (url, init) => guardedRemoteHttpFetch(url, init, {
  allowPrivateNetwork: false, connectTimeoutMs: 5000, responseTimeoutMs: 10_000,
  error: () => new McpEventError(-32015, "Callback endpoint is unavailable.", "invalid_destination"),
});

export function callbackUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new McpEventError(-32602, "Invalid callback URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || value.length > 2048) {
    throw new McpEventError(-32602, "Callbacks require an HTTPS URL without credentials or a fragment.");
  }
  return url.toString();
}

export function signingKey(secret: string) {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new McpEventError(-32602, "Invalid webhook signing secret.");
  const key = Buffer.from(secret.slice(6), "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64").replace(/=+$/, "") !== secret.slice(6).replace(/=+$/, "")) {
    throw new McpEventError(-32602, "Invalid webhook signing secret.");
  }
  return key;
}

export function webhookSignature(secret: string, id: string, timestamp: number, body: string) {
  return "v1," + createHmac("sha256", signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export async function postEvent(fetcher: EventFetch, subscriptionId: string, url: string, secrets: string[], id: string, payload: unknown, now: number) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 262144) throw new McpEventError(-32602, "Event exceeds the delivery size limit.");
  const timestamp = Math.floor(now / 1000);
  return fetcher(callbackUrl(url), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": String(timestamp),
      "webhook-signature": secrets.map(secret => webhookSignature(secret, id, timestamp, body)).join(" "),
      "X-MCP-Subscription-Id": subscriptionId }, body,
  });
}

export async function boundedJson(response: Response, limit = 16384): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Response too large");
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response");
    return value as Record<string, unknown>;
  } finally { await reader.cancel().catch(() => {}); }
}

export async function verifyCallback(fetcher: EventFetch, id: string, url: string, secret: string, now: number) {
  const challenge = randomBytes(32).toString("base64url");
  try {
    const response = await postEvent(fetcher, id, url, [secret], "verify_" + randomBytes(24).toString("base64url"), { type: "verification", challenge }, now);
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const result = await boundedJson(response);
    const echoed = typeof result.challenge === "string" ? Buffer.from(result.challenge) : Buffer.alloc(0);
    if (echoed.length !== Buffer.byteLength(challenge) || !timingSafeEqual(echoed, Buffer.from(challenge))) throw new Error();
  } catch (error) {
    if (error instanceof McpEventError) throw error;
    throw new McpEventError(-32015, "Callback verification failed.", error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "challenge_failed");
  }
}
