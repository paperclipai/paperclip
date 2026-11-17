import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleRequest } from "../google-http.js";
import { compact } from "../tool.js";
import { parseAddressList } from "./address.js";

export interface GmailHeader { name?: string; value?: string }
export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}
export interface GmailRestMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}
export interface GmailRestAttachment { size?: number; data?: string }

export type MessageDetail = "metadata_only" | "minimal" | "full";

export const SUMMARY_HEADERS = ["From", "To", "Cc", "Subject", "Date"] as const;

export interface McpGmailMessage extends Record<string, unknown> {
  id: string;
  snippet?: string;
  subject?: string;
  sender?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  date?: string;
  plaintextBody?: string;
  attachmentIds?: string[];
  htmlBody?: string;
  attachments?: Array<{ id: string; mimeType: string; filename: string }>;
  labelIds?: string[];
}

const REPORTED_SYSTEM_LABELS = new Set(["INBOX", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "CHAT"]);

export const gmailId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, "Must be a Gmail ID");
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,4096}$/;

export function header(part: GmailMessagePart | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return part?.headers?.find((item) => item.name?.toLowerCase() === lower)?.value;
}

export function isoDate(internalDate: string | undefined): string | undefined {
  if (!internalDate || !/^\d+$/.test(internalDate)) return undefined;
  const date = new Date(Number(internalDate));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

export function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

export function reportedLabelIds(labelIds: readonly string[] | undefined): string[] {
  return (labelIds ?? []).filter((id) => id.startsWith("Label_") || REPORTED_SYSTEM_LABELS.has(id));
}

function isAttachment(part: GmailMessagePart): boolean {
  const disposition = header(part, "Content-Disposition") ?? "";
  return Boolean(part.filename) || /^\s*attachment\b/i.test(disposition);
}

interface MessageParts {
  plain?: GmailMessagePart;
  html?: GmailMessagePart;
  attachments: Array<{ id: string; mimeType: string; filename: string }>;
}

export function messageParts(payload: GmailMessagePart | undefined): MessageParts {
  const found: MessageParts = { attachments: [] };
  const visit = (part: GmailMessagePart) => {
    if (part.parts?.length) {
      for (const child of part.parts) visit(child);
      return;
    }
    if (isAttachment(part)) {
      if (part.body?.attachmentId) {
        found.attachments.push({
          id: part.body.attachmentId,
          mimeType: part.mimeType ?? "application/octet-stream",
          filename: part.filename ?? "",
        });
      }
      return;
    }
    const mimeType = (part.mimeType ?? "").toLowerCase();
    const hasBody = part.body?.data !== undefined || Boolean(part.body?.attachmentId);
    if (!hasBody) return;
    if (mimeType === "text/plain" && !found.plain) found.plain = part;
    else if (mimeType === "text/html" && !found.html) found.html = part;
  };
  if (payload) visit(payload);
  return found;
}

export function externalBodyIds(payload: GmailMessagePart | undefined): string[] {
  const { plain, html } = messageParts(payload);
  return [plain, html]
    .filter((part): part is GmailMessagePart => Boolean(part && part.body?.data === undefined && part.body?.attachmentId))
    .map((part) => part.body!.attachmentId!);
}

export function bodyAttachmentRequest(messageId: string, attachmentId: string): GoogleRequest {
  if (!ATTACHMENT_ID.test(attachmentId)) throw new GoogleToolError("incomplete", "Gmail returned a message body this tool cannot read.");
  return {
    method: "GET",
    host: "gmail.googleapis.com",
    path: `/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
  };
}

export interface MessageContent {
  plaintextBody?: string;
  htmlBody?: string;
  attachments: Array<{ id: string; mimeType: string; filename: string }>;
}

export function messageContent(payload: GmailMessagePart | undefined, externalBodies: ReadonlyMap<string, string> = new Map()): MessageContent {
  const { plain, html, attachments } = messageParts(payload);
  const text = (part: GmailMessagePart | undefined): string | undefined => {
    if (!part) return undefined;
    if (part.body?.data !== undefined) return decodeBase64Url(part.body.data);
    const data = externalBodies.get(part.body?.attachmentId ?? "");
    if (data === undefined) throw new GoogleToolError("incomplete", "Could not read the full body of this message.");
    return decodeBase64Url(data);
  };
  return { plaintextBody: text(plain), htmlBody: text(html), attachments };
}

export function toMcpMessage(
  message: GmailRestMessage,
  detail: MessageDetail,
  externalBodies?: ReadonlyMap<string, string>,
): McpGmailMessage {
  const payload = message.payload;
  const withText = detail !== "metadata_only";
  const content = detail === "full" ? messageContent(payload, externalBodies) : undefined;
  return compact({
    id: message.id ?? "",
    snippet: withText ? message.snippet ?? "" : undefined,
    subject: withText ? header(payload, "Subject") ?? "" : undefined,
    sender: parseAddressList(header(payload, "From"))[0],
    toRecipients: parseAddressList(header(payload, "To")),
    ccRecipients: parseAddressList(header(payload, "Cc")),
    date: isoDate(message.internalDate),
    plaintextBody: content?.plaintextBody,
    htmlBody: content?.htmlBody,
    attachmentIds: content ? content.attachments.map((attachment) => attachment.id) : undefined,
    attachments: content?.attachments,
    labelIds: reportedLabelIds(message.labelIds),
  });
}
