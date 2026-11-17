/**
 * Gmail REST message shapes and their translation to the `Message` object of
 * Google's Gmail MCP tools. REST types stay inside this folder.
 */
import { z } from "zod";
import { compact } from "../tool.js";

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

/** How much of a message the MCP result carries. */
export type MessageDetail = "metadata_only" | "minimal" | "full";

/** Headers fetched for metadata reads. */
export const SUMMARY_HEADERS = ["From", "To", "Cc", "Subject", "Date"] as const;

/** The `Message` object of Google's Gmail MCP tools. */
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

/** System labels Google's MCP tools report; user labels always pass. */
const REPORTED_SYSTEM_LABELS = new Set(["INBOX", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "CHAT"]);

export function header(part: GmailMessagePart | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return part?.headers?.find((item) => item.name?.toLowerCase() === lower)?.value;
}

/** Plain addresses from an address-list header: `"Ann, B" <a@x.test>, c@y.test` gives `a@x.test`, `c@y.test`. */
export function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const char of value) {
    if (char === "\"") quoted = !quoted;
    else if (!quoted && char === "<") angle += 1;
    else if (!quoted && char === ">") angle = Math.max(0, angle - 1);
    if (char === "," && !quoted && angle === 0) {
      entries.push(current);
      current = "";
    } else current += char;
  }
  entries.push(current);
  return entries.map((entry) => {
    const bracketed = /<([^<>]*)>\s*$/.exec(entry);
    return (bracketed ? bracketed[1]! : entry.replace(/\([^)]*\)/g, "")).trim().replace(/^"|"$/g, "");
  }).filter((address) => address.length > 0);
}

/** `internalDate` (epoch milliseconds) as an ISO 8601 calendar date in UTC. */
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

export interface MessageContent {
  plaintextBody?: string;
  htmlBody?: string;
  attachments: Array<{ id: string; mimeType: string; filename: string }>;
}

/** First text/plain and text/html body parts, and every attachment, depth first. */
export function messageContent(payload: GmailMessagePart | undefined): MessageContent {
  const content: MessageContent = { attachments: [] };
  const visit = (part: GmailMessagePart) => {
    if (part.parts?.length) {
      for (const child of part.parts) visit(child);
      return;
    }
    const mimeType = (part.mimeType ?? "").toLowerCase();
    if (isAttachment(part)) {
      if (part.body?.attachmentId) {
        content.attachments.push({
          id: part.body.attachmentId,
          mimeType: part.mimeType ?? "application/octet-stream",
          filename: part.filename ?? "",
        });
      }
      return;
    }
    const data = part.body?.data;
    if (data === undefined) return;
    if (mimeType === "text/plain" && content.plaintextBody === undefined) content.plaintextBody = decodeBase64Url(data);
    else if (mimeType === "text/html" && content.htmlBody === undefined) content.htmlBody = decodeBase64Url(data);
  };
  if (payload) visit(payload);
  return content;
}

/** A Gmail REST message as Google's MCP `Message`, populated for `detail`. */
export function toMcpMessage(message: GmailRestMessage, detail: MessageDetail): McpGmailMessage {
  const payload = message.payload;
  const withText = detail !== "metadata_only";
  const content = detail === "full" ? messageContent(payload) : undefined;
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

/**
 * Gmail message and thread IDs are opaque URL-safe tokens. Accepting only
 * those keeps caller input from changing the request path (`..`, `/`, `?`).
 */
export const gmailId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, "Must be a Gmail ID");
