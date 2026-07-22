import { Buffer } from "node:buffer";
import {
  definePlugin,
  runWorker,
  type EnvSecretRefBinding,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { DEFAULT_MAX_ATTACHMENT_BYTES, FINANCE_GRANT_ID } from "./manifest.js";

const GRANT_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const API_BASES = {
  us: "https://api.us.nylas.com",
  eu: "https://api.eu.nylas.com",
} as const;
const MAX_CONFIGURED_ATTACHMENT_BYTES = 5_000_000;
const MAX_BODY_CHARS = 200_000;

type NylasRecord = Record<string, unknown>;
type NylasRegion = keyof typeof API_BASES;

type NylasConfig = {
  apiKey: EnvSecretRefBinding | null;
  grantId: string;
  apiRegion: NylasRegion;
  maxAttachmentBytes: number;
};

function isRecord(value: unknown): value is NylasRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  return isRecord(value)
    && value.type === "secret_ref"
    && typeof value.secretId === "string"
    && value.secretId.length > 0;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function environmentApiKey(): string {
  return readString(process.env.PAPERCLIP_NYLAS) || readString(process.env.paperclip_nylas);
}

function readRegion(value: unknown): NylasRegion {
  const region = readString(value) || "us";
  if (region !== "us" && region !== "eu") {
    throw new Error("Nylas API region must be either us or eu.");
  }
  return region;
}

function readAttachmentLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_MAX_ATTACHMENT_BYTES;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONFIGURED_ATTACHMENT_BYTES) {
    throw new Error(`Maximum attachment size must be a whole number between 1 and ${MAX_CONFIGURED_ATTACHMENT_BYTES}.`);
  }
  return parsed;
}

function validateConfig(config: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (config.apiKey !== undefined && config.apiKey !== null && !isSecretRef(config.apiKey)) {
    errors.push("Configure the Nylas API key as a Paperclip company secret, never as a raw config value.");
  } else if (!isSecretRef(config.apiKey) && !environmentApiKey()) {
    errors.push("Configure a Nylas API-key company secret or set PAPERCLIP_NYLAS in the Paperclip server environment.");
  }

  const grantId = readString(config.grantId) || FINANCE_GRANT_ID;
  if (!GRANT_ID_PATTERN.test(grantId)) {
    errors.push("Configure a valid UUID Nylas grant ID for the finance mailbox.");
  }

  try {
    readRegion(config.apiRegion);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    readAttachmentLimit(config.maxAttachmentBytes);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function requireCompanyId(runCtx: ToolRunContext): string {
  const companyId = runCtx.companyId?.trim();
  if (!companyId) throw new Error("Nylas tools require a company-scoped agent run.");
  return companyId;
}

async function readConfig(ctx: PluginContext, companyId: string): Promise<NylasConfig> {
  const raw = await ctx.config.get(companyId);
  const errors = validateConfig(raw);
  if (errors.length > 0) throw new Error(errors.join(" "));

  return {
    apiKey: isSecretRef(raw.apiKey) ? raw.apiKey : null,
    grantId: readString(raw.grantId) || FINANCE_GRANT_ID,
    apiRegion: readRegion(raw.apiRegion),
    maxAttachmentBytes: readAttachmentLimit(raw.maxAttachmentBytes),
  };
}

function requiredId(value: unknown, name: string): string {
  const id = readString(value);
  if (!id || id.length > 2_000) throw new Error(`${name} must be a non-empty string of 2,000 characters or fewer.`);
  return id;
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) throw new Error(`${name} must be ${maxLength} characters or fewer.`);
  return normalized;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be true or false.`);
  return value;
}

function integerInRange(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return parsed;
}

function optionalUnixTimestamp(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative Unix timestamp in seconds.`);
  return parsed;
}

function appendQuery(url: URL, key: string, value: string | number | boolean | undefined): void {
  if (value !== undefined) url.searchParams.set(key, String(value));
}

function errorText(payload: unknown, status: number): string {
  if (!isRecord(payload)) return `HTTP ${status}`;
  const nested = isRecord(payload.error) ? payload.error : null;
  const type = readString(nested?.type) || readString(nested?.code) || readString(payload.type);
  const message = readString(nested?.message) || readString(payload.message);
  const combined = [type, message].filter(Boolean).join(": ");
  return combined ? combined.slice(0, 500) : `HTTP ${status}`;
}

async function parseErrorResponse(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null);
  return errorText(payload, response.status);
}

async function readResponseBytesWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Attachment exceeds the configured ${maxBytes}-byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

async function authorizedFetch(
  ctx: PluginContext,
  companyId: string,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<{ response: Response; config: NylasConfig }> {
  const config = await readConfig(ctx, companyId);
  const apiKey = config.apiKey
    ? await ctx.secrets.resolve(config.apiKey, { companyId, configPath: "apiKey" })
    : environmentApiKey();
  if (!apiKey) {
    throw new Error("PAPERCLIP_NYLAS is not available to the Paperclip server process and no company secret is configured.");
  }
  const url = new URL(`${API_BASES[config.apiRegion]}/v3/grants/${encodeURIComponent(config.grantId)}${path}`);
  for (const [key, value] of Object.entries(query)) appendQuery(url, key, value);

  const response = await ctx.http.fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  return { response, config };
}

async function nylasJson(
  ctx: PluginContext,
  companyId: string,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<NylasRecord> {
  const { response } = await authorizedFetch(ctx, companyId, path, query);
  if (!response.ok) throw new Error(`Nylas request failed: ${await parseErrorResponse(response)}`);
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload)) throw new Error("Nylas returned an unreadable JSON response.");
  return payload;
}

function normalizedAddresses(value: unknown): Array<{ name: string | null; email: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.email !== "string") return [];
    return [{
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : null,
      email: item.email,
    }];
  });
}

function normalizedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizedAttachments(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string") return [];
    return [{
      id: item.id,
      filename: typeof item.filename === "string" ? item.filename : null,
      contentType: typeof item.content_type === "string" ? item.content_type : null,
      size: typeof item.size === "number" ? item.size : null,
      isInline: item.is_inline === true,
      contentId: typeof item.content_id === "string" ? item.content_id : null,
    }];
  });
}

function normalizedBody(value: unknown): { body: string | null; bodyTruncated: boolean } {
  if (typeof value !== "string") return { body: null, bodyTruncated: false };
  return {
    body: value.slice(0, MAX_BODY_CHARS),
    bodyTruncated: value.length > MAX_BODY_CHARS,
  };
}

function normalizedMessage(value: unknown, includeBody: boolean): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const body = includeBody ? normalizedBody(value.body) : {};
  return {
    id: value.id,
    threadId: typeof value.thread_id === "string" ? value.thread_id : null,
    subject: typeof value.subject === "string" ? value.subject : "",
    from: normalizedAddresses(value.from),
    to: normalizedAddresses(value.to),
    cc: normalizedAddresses(value.cc),
    bcc: normalizedAddresses(value.bcc),
    replyTo: normalizedAddresses(value.reply_to),
    date: typeof value.date === "number" ? value.date : null,
    snippet: typeof value.snippet === "string" ? value.snippet : null,
    unread: value.unread === true,
    starred: value.starred === true,
    folders: normalizedStringArray(value.folders),
    labels: normalizedStringArray(value.labels),
    attachments: normalizedAttachments(value.attachments),
    ...body,
  };
}

function normalizedThread(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    subject: typeof value.subject === "string" ? value.subject : "",
    snippet: typeof value.snippet === "string" ? value.snippet : null,
    participants: normalizedAddresses(value.participants),
    messageIds: normalizedStringArray(value.message_ids),
    earliestMessageDate: typeof value.earliest_message_date === "number" ? value.earliest_message_date : null,
    latestMessageReceivedDate: typeof value.latest_message_received_date === "number" ? value.latest_message_received_date : null,
    unread: value.unread === true,
    starred: value.starred === true,
    hasAttachments: value.has_attachments === true,
    folders: normalizedStringArray(value.folders),
    labels: normalizedStringArray(value.labels),
  };
}

function responseDataRecord(payload: NylasRecord): NylasRecord {
  if (!isRecord(payload.data)) throw new Error("Nylas response did not contain an object in data.");
  return payload.data;
}

function responseDataArray(payload: NylasRecord): unknown[] {
  if (!Array.isArray(payload.data)) throw new Error("Nylas response did not contain an array in data.");
  return payload.data;
}

function toolResult(content: string, data: unknown): ToolResult {
  return { content, data };
}

function filenameFromHeaders(headers: Headers, fallback: string): string {
  const disposition = headers.get("content-disposition") ?? "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
    } catch {
      return encoded.replace(/^"|"$/g, "");
    }
  }
  return disposition.match(/filename="([^"]+)"/i)?.[1]
    ?? disposition.match(/filename=([^;]+)/i)?.[1]?.trim()
    ?? fallback;
}

function registerTools(ctx: PluginContext): void {
  ctx.tools.register(
    "nylas_search_messages",
    {
      displayName: "Search Finance Mailbox",
      description: "Search messages in the configured finance mailbox.",
      parametersSchema: {},
    },
    async (params, runCtx) => {
      const input = isRecord(params) ? params : {};
      const companyId = requireCompanyId(runCtx);
      const payload = await nylasJson(ctx, companyId, "/messages", {
        limit: integerInRange(input.limit, 20, 1, 20, "limit"),
        page_token: optionalString(input.pageToken, "pageToken", 2_000),
        subject: optionalString(input.subject, "subject", 500),
        any_email: optionalString(input.anyEmail, "anyEmail", 2_000),
        from: optionalString(input.fromEmail, "fromEmail", 320),
        to: optionalString(input.toEmail, "toEmail", 320),
        unread: optionalBoolean(input.unread, "unread"),
        has_attachment: optionalBoolean(input.hasAttachment, "hasAttachment"),
        received_after: optionalUnixTimestamp(input.receivedAfter, "receivedAfter"),
        received_before: optionalUnixTimestamp(input.receivedBefore, "receivedBefore"),
      });
      const messages = responseDataArray(payload)
        .map((message) => normalizedMessage(message, false))
        .filter((message): message is Record<string, unknown> => message !== null);
      const nextCursor = typeof payload.next_cursor === "string" ? payload.next_cursor : null;
      return toolResult(`Found ${messages.length} messages in the configured finance mailbox.`, { messages, nextCursor });
    },
  );

  ctx.tools.register(
    "nylas_get_message",
    {
      displayName: "Read Finance Message",
      description: "Read one message from the configured finance mailbox.",
      parametersSchema: {},
    },
    async (params, runCtx) => {
      const input = isRecord(params) ? params : {};
      const companyId = requireCompanyId(runCtx);
      const messageId = requiredId(input.messageId, "messageId");
      const payload = await nylasJson(ctx, companyId, `/messages/${encodeURIComponent(messageId)}`);
      const message = normalizedMessage(responseDataRecord(payload), true);
      if (!message) throw new Error("Nylas returned an invalid message object.");
      return toolResult(`Read finance message ${messageId}.`, { message });
    },
  );

  ctx.tools.register(
    "nylas_read_thread",
    {
      displayName: "Read Finance Thread",
      description: "Read a thread and its messages from the configured finance mailbox.",
      parametersSchema: {},
    },
    async (params, runCtx) => {
      const input = isRecord(params) ? params : {};
      const companyId = requireCompanyId(runCtx);
      const threadId = requiredId(input.threadId, "threadId");
      const limit = integerInRange(input.limit, 50, 1, 50, "limit");
      const [threadPayload, messagesPayload] = await Promise.all([
        nylasJson(ctx, companyId, `/threads/${encodeURIComponent(threadId)}`),
        nylasJson(ctx, companyId, "/messages", { thread_id: threadId, limit }),
      ]);
      const thread = normalizedThread(responseDataRecord(threadPayload));
      if (!thread) throw new Error("Nylas returned an invalid thread object.");
      const messages = responseDataArray(messagesPayload)
        .map((message) => normalizedMessage(message, true))
        .filter((message): message is Record<string, unknown> => message !== null)
        .sort((left, right) => Number(left.date ?? 0) - Number(right.date ?? 0));
      const nextCursor = typeof messagesPayload.next_cursor === "string" ? messagesPayload.next_cursor : null;
      return toolResult(`Read ${messages.length} messages from finance thread ${threadId}.`, {
        thread,
        messages,
        nextCursor,
      });
    },
  );

  ctx.tools.register(
    "nylas_list_attachments",
    {
      displayName: "List Finance Message Attachments",
      description: "List attachment metadata for one finance message.",
      parametersSchema: {},
    },
    async (params, runCtx) => {
      const input = isRecord(params) ? params : {};
      const companyId = requireCompanyId(runCtx);
      const messageId = requiredId(input.messageId, "messageId");
      const payload = await nylasJson(ctx, companyId, `/messages/${encodeURIComponent(messageId)}`, {
        select: "attachments",
      });
      const attachments = normalizedAttachments(responseDataRecord(payload).attachments);
      return toolResult(`Found ${attachments.length} attachments on finance message ${messageId}.`, {
        messageId,
        attachments,
      });
    },
  );

  ctx.tools.register(
    "nylas_download_attachment",
    {
      displayName: "Download Finance Attachment",
      description: "Download one size-capped finance attachment as base64.",
      parametersSchema: {},
    },
    async (params, runCtx) => {
      const input = isRecord(params) ? params : {};
      const companyId = requireCompanyId(runCtx);
      const messageId = requiredId(input.messageId, "messageId");
      const attachmentId = requiredId(input.attachmentId, "attachmentId");
      const { response, config } = await authorizedFetch(
        ctx,
        companyId,
        `/attachments/${encodeURIComponent(attachmentId)}/download`,
        { message_id: messageId },
      );
      if (!response.ok) throw new Error(`Nylas attachment download failed: ${await parseErrorResponse(response)}`);

      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > config.maxAttachmentBytes) {
        throw new Error(`Attachment is ${declaredSize} bytes, above the configured ${config.maxAttachmentBytes}-byte limit.`);
      }
      const bytes = await readResponseBytesWithLimit(response, config.maxAttachmentBytes);

      const filename = filenameFromHeaders(response.headers, attachmentId);
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      return toolResult(`Downloaded ${filename} (${bytes.byteLength} bytes) from the configured finance mailbox.`, {
        messageId,
        attachmentId,
        filename,
        contentType,
        byteSize: bytes.byteLength,
        encoding: "base64",
        content: bytes.toString("base64"),
      });
    },
  );
}

const plugin = definePlugin({
  async setup(ctx) {
    registerTools(ctx);
  },

  async onValidateConfig(config) {
    const errors = validateConfig(config);
    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },

  async onHealth() {
    return { status: "ok", message: "Nylas finance mailbox tools are registered" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
