import { z } from "zod";
import { Webhook } from "svix";
import type { EmailAddressCheckResult, EmailEnvelope } from "@paperclipai/shared";

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

// Only these documented codes may leave the provider boundary. The other
// response fields (including `fix`) can contain addresses, URLs, or credentials.
const providerErrorCodes = [
  "missing_authorization", "invalid_token_type", "unknown_api_key", "unauthorized",
  "missing_permission", "permission_escalation", "unrestricted_key_required", "forbidden",
  "validation_error", "not_found", "unprocessable", "query_range_too_wide",
  "already_exists", "resource_taken", "limit_exceeded", "domain_not_verified",
  "conflict", "race_condition", "resource_deleting", "cannot_delete", "message_rejected",
  "rate_limit_exceeded", "service_unavailable", "internal_error",
] as const;
type ProviderErrorCode = (typeof providerErrorCodes)[number] | "unknown";
const providerOperations = [
  ["GET", /^\/auth\/me$/, "inspect_key"],
  ["GET", /^\/inboxes$/, "list_inboxes"],
  ["POST", /^\/inboxes$/, "create_inbox"],
  ["GET", /^\/inboxes\/[^/]+$/, "get_inbox"],
  ["GET", /^\/domains$/, "list_domains"],
  ["GET", /^\/domains\/[^/]+$/, "get_domain"],
  ["POST", /^\/inboxes\/[^/]+\/api-keys$/, "create_inbox_key"],
  ["DELETE", /^\/inboxes\/[^/]+\/api-keys\/[^/]+$/, "delete_inbox_key"],
  ["POST", /^\/inboxes\/[^/]+\/webhooks$/, "create_webhook"],
  ["DELETE", /^\/inboxes\/[^/]+\/webhooks\/[^/]+$/, "delete_webhook"],
  ["GET", /^\/inboxes\/[^/]+\/messages$/, "list_messages"],
  ["GET", /^\/inboxes\/[^/]+\/messages\/[^/]+$/, "get_message"],
  ["GET", /^\/inboxes\/[^/]+\/threads\/[^/]+$/, "get_thread"],
  ["POST", /^\/inboxes\/[^/]+\/messages\/send$/, "send_message"],
  ["POST", /^\/inboxes\/[^/]+\/messages\/[^/]+\/reply$/, "reply_message"],
  ["GET", /^\/inboxes\/[^/]+\/messages\/[^/]+\/attachments\/[^/]+$/, "get_attachment"],
] as const;
type ProviderOperation = (typeof providerOperations)[number][2] | "request";

async function readProviderErrorCode(response: Response): Promise<ProviderErrorCode> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!response.body) return "unknown";
    const bodyReader = response.body.getReader();
    reader = bodyReader;
    return await Promise.race([
      (async (): Promise<ProviderErrorCode> => {
        const parts: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const part = await bodyReader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 8 * 1024) return "unknown";
          parts.push(part.value);
        }
        const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
        const code = body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>).code
          : undefined;
        return providerErrorCodes.find((known) => known === code) ?? "unknown";
      })(),
      new Promise<ProviderErrorCode>((resolve) => {
        timeout = setTimeout(() => resolve("unknown"), 1000);
      }),
    ]);
  } catch {
    // A malformed, truncated, or interrupted body must not replace the HTTP error.
    return "unknown";
  } finally {
    clearTimeout(timeout);
    void reader?.cancel().catch(() => {});
  }
}

export class AgentmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs = 1000,
    readonly operation: ProviderOperation = "request",
    readonly providerCode: ProviderErrorCode = "unknown",
  ) {
    // Provider bodies may contain credentials or private mail. Never log them.
    super(`AgentMail request failed (${status}) [operation=${operation}, code=${providerCode}]`);
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
        providerOperations.find(([verb, route]) =>
          verb === method && route.test(path.split("?")[0]),
        )?.[2] ?? "request",
        await readProviderErrorCode(response),
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
    checkAddress: async (address: string): Promise<EmailAddressCheckResult> => {
      // Do not GET a speculative inbox ID. Live AgentMail caches missing inbox
      // lookups, so checking a free name can make key creation return 404 after
      // the inbox is created. Listing avoids priming that negative lookup.
      const { inboxes } = await request<{ inboxes: AgentmailInbox[] }>("/inboxes?limit=100");
      // An absent entry can be outside this page or credential's scope. Only
      // creation is authoritative; never claim an unlisted address is free.
      return {
        address,
        status: inboxes.some(inbox => inbox.inbox_id.toLowerCase() === address.toLowerCase()) ? "taken" : "unknown",
      };
    },
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
