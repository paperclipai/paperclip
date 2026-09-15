import { z } from "zod";
import { Webhook } from "svix";
import type { EmailEnvelope } from "@paperclipai/shared";

const strings = z.array(z.string());
export const agentmailMessageSchema = z.object({
  inbox_id: z.string().min(1),
  thread_id: z.string().min(1),
  message_id: z.string().min(1),
  from: z.string().default(""),
  to: strings.default([]),
  cc: strings.optional(),
  bcc: strings.optional(),
  reply_to: strings.optional(),
  subject: z.string().default("(No subject)"),
  text: z.string().optional(),
  html: z.string().optional(),
  extracted_text: z.string().optional(),
  timestamp: z.string().datetime({ offset: true }),
  created_at: z.string().datetime({ offset: true }).optional(),
  labels: strings.default([]),
  headers: z.record(z.string(), z.string()).default({}),
  attachments: z
    .array(
      z.object({
        attachment_id: z.string(),
        filename: z.string().optional(),
        content_type: z.string().optional(),
        size: z.number().nonnegative(),
      }),
    )
    .default([]),
});
export type AgentmailMessage = z.infer<typeof agentmailMessageSchema>;
export interface AgentmailInbox {
  inbox_id: string;
  display_name?: string;
}
export interface AgentmailScope {
  scope_type: "organization" | "pod" | "inbox";
  organization_id: string;
  pod_id?: string;
  inbox_id?: string;
}
export class AgentmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs = 1000,
  ) {
    // Provider bodies may contain credentials or private mail. Never log them.
    super(`AgentMail request failed (${status})`);
  }
}
export const AGENTMAIL_EVENTS = [
  "message.received",
  "message.sent",
  "message.delivered",
  "message.bounced",
  "message.complained",
  "message.rejected",
];
export function emailText(message: AgentmailMessage): string {
  return (
    message.extracted_text ??
    message.text ??
    (message.html
      ? message.html
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]*>/g, " ")
      : "")
  ).slice(0, 100_000);
}
/** Reconstruct only visible recipients; never let provider reply-all inherit Bcc. */
export function emailReplyRecipients(
  message: EmailEnvelope,
  ownAddress: string,
  replyAll: boolean,
) {
  const address = (value: string) =>
    (value.match(/<([^>]+)>/)?.[1] ?? value).trim();
  const seen = new Set([address(ownAddress).toLowerCase()]);
  const unique = (values: string[]) =>
    values.map(address).filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const replyTargets = message.replyTo?.length ? message.replyTo : [message.from];
  const to = unique([...replyTargets, ...(replyAll ? message.to : [])]);
  const cc = unique(replyAll ? (message.cc ?? []) : []);
  return { to, cc, bcc: [], reply_all: false };
}
export function isAutomaticEmail(message: AgentmailMessage): boolean {
  const headers = Object.fromEntries(
    Object.entries(message.headers).map(([k, v]) => [
      k.toLowerCase(),
      v.toLowerCase(),
    ]),
  );
  return Boolean(
    (headers["auto-submitted"] && headers["auto-submitted"] !== "no") ||
      /^(bulk|list|junk)$/.test(headers.precedence ?? "") ||
      headers["x-autoreply"] ||
      headers["x-autorespond"],
  );
}
export function isFilteredEmail(message: AgentmailMessage): boolean {
  return message.labels.some((label) =>
    ["spam", "blocked", "unauthenticated", "trash"].includes(label),
  );
}
export function verifyAgentmailWebhook(
  body: Buffer,
  headers: Record<string, string>,
  secret: string,
): unknown {
  return new Webhook(secret).verify(body.toString("utf8"), headers);
}
export function normalizeAgentmailEvent(value: unknown) {
  const parsed = z
    .object({
      type: z.string().optional(),
      event_type: z.string().optional(),
      event_id: z.string().optional(),
      message: z.unknown().optional(),
      send: z.unknown().optional(),
      delivery: z.unknown().optional(),
      bounce: z.unknown().optional(),
      complaint: z.unknown().optional(),
      reject: z.unknown().optional(),
    })
    .parse(value);
  const kind =
    parsed.event_type ?? parsed.type?.replace(/^message_/, "message.");
  if (!kind || !AGENTMAIL_EVENTS.includes(kind)) return null;
  // Provider receipts use event-specific envelopes, shared by both transports.
  // Internal reconciliation events may supply the fetched message directly.
  const receipts: Record<string, unknown> = {
    "message.sent": parsed.send,
    "message.delivered": parsed.delivery,
    "message.bounced": parsed.bounce,
    "message.complained": parsed.complaint,
    "message.rejected": parsed.reject,
  };
  // Fetch the authoritative message before intake; delivery events have reduced payloads.
  const message = z
    .object({ inbox_id: z.string(), message_id: z.string() })
    .parse(receipts[kind] ?? parsed.message);
  return {
    kind,
    ...message,
    eventId: parsed.event_id ?? `${kind}:${message.message_id}`,
  };
}

/** REST is the email protocol boundary; credentials never enter an agent runtime. */
export function agentmailApi(apiKey: string, fetchImpl: typeof fetch = fetch) {
  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await fetchImpl(`https://api.agentmail.to/v0${path}`, {
      method,
      signal: AbortSignal.timeout(25_000),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const seconds = Number(retryAfter ?? 1);
      const delay = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retryAfter ?? "") - Date.now();
      throw new AgentmailApiError(
        response.status,
        Math.max(1000, Math.min(300_000, Number.isFinite(delay) ? delay : 1000)),
      );
    }
    if (response.status === 204) return undefined as T;
    if (!response.body) throw new Error("Empty AgentMail response");
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 16 * 1024 * 1024)
          throw new Error("AgentMail response exceeds the processing limit");
        parts.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as T;
  }
  const inboxPath = (id: string) => `/inboxes/${encodeURIComponent(id)}`;
  return {
    request,
    whoami: () => request<AgentmailScope>("/auth/me"),
    getInbox: (id: string) => request<AgentmailInbox>(inboxPath(id)),
    listInboxes: () =>
      request<{ inboxes: AgentmailInbox[] }>("/inboxes?limit=100"),
    listDomains: () =>
      request<{ domains: { domain_id: string; domain: string }[] }>(
        "/domains?limit=100",
      ),
    getDomain: (id: string) =>
      request<{ domain_id: string; domain: string; status: string }>(
        `/domains/${encodeURIComponent(id)}`,
      ),
    createInbox: (body: unknown) =>
      request<AgentmailInbox>("/inboxes", "POST", body),
    createInboxKey: (id: string) =>
      request<{ api_key: string; api_key_id: string }>(
        `${inboxPath(id)}/api-keys`,
        "POST",
        { name: "Paperclip email runtime" },
      ),
    deleteInboxKey: (id: string, keyId: string) =>
      request<void>(
        `${inboxPath(id)}/api-keys/${encodeURIComponent(keyId)}`,
        "DELETE",
      ),
    createWebhook: (id: string, url: string, clientId: string) =>
      request<{ webhook_id: string; secret: string }>(
        `${inboxPath(id)}/webhooks`,
        "POST",
        { url, event_types: AGENTMAIL_EVENTS, client_id: clientId },
      ),
    deleteWebhook: (id: string, webhookId: string) =>
      request<void>(
        `${inboxPath(id)}/webhooks/${encodeURIComponent(webhookId)}`,
        "DELETE",
      ),
    getMessage: async (id: string, messageId: string) =>
      agentmailMessageSchema.parse(
        await request(
          `${inboxPath(id)}/messages/${encodeURIComponent(messageId)}`,
        ),
      ),
    getThread: async (id: string, threadId: string) =>
      z
        .object({ messages: z.array(agentmailMessageSchema) })
        .parse(
          await request(
            `${inboxPath(id)}/threads/${encodeURIComponent(threadId)}`,
          ),
        ),
    listMessages: (id: string, after?: string, page?: string) =>
      request<{
        messages: {
          message_id: string;
          created_at?: string;
          timestamp?: string;
        }[];
        next_page_token?: string;
      }>(
        `${inboxPath(id)}/messages?${new URLSearchParams({ ...(after ? { after } : {}), ascending: "true", limit: "100", ...(page ? { page_token: page } : {}) })}`,
      ),
    send: (id: string, body: unknown, key: string, replyId?: string) =>
      request<{ message_id: string; thread_id: string }>(
        `${inboxPath(id)}/messages/${replyId ? `${encodeURIComponent(replyId)}/reply` : "send"}`,
        "POST",
        body,
        key,
      ),
    getAttachment: (id: string, messageId: string, attachmentId: string) =>
      request<{ download_url: string; size: number }>(
        `${inboxPath(id)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      ),
  };
}
