import { randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import { gmailId, header, type GmailRestMessage } from "./message.js";
import { buildDraftMime } from "./mime.js";

const plainEmail = z.string().regex(/^[^\s<>@,;"()\\]+@[^\s<>@,;"()\\]+\.[^\s<>@,;"()\\]+$/, "Must be a plain email address such as user@example.com");
const addressList = z.array(plainEmail).max(100).optional();

const args = z.object({
  to: addressList,
  cc: addressList,
  bcc: addressList,
  subject: z.string().max(998).regex(/^[^\r\n]*$/, "Subject must be a single line").optional(),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  replyToMessageId: gmailId.optional(),
  attachments: z.array(z.object({
    id: z.string().optional(),
    filename: z.string().optional(),
    mimeType: z.string().optional(),
    content: z.string(),
    inline: z.boolean().optional(),
  })).optional(),
});
export type CreateDraftArgs = z.infer<typeof args>;

interface GmailRestDraft { id?: string; message?: { id?: string; threadId?: string } }

export interface ReplyContext {
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  subject: string;
}

const MESSAGE_ID_TOKEN = /^<[^<>\s]+>$/;

export function replyLookupRequest(messageId: string): GoogleRequest {
  return {
    method: "GET",
    host: "gmail.googleapis.com",
    path: `/gmail/v1/users/me/messages/${messageId}`,
    query: { format: "metadata", metadataHeaders: ["Message-ID", "References", "Subject"] },
  };
}

export function replyContext(original: GmailRestMessage): ReplyContext {
  const messageId = header(original.payload, "Message-ID")?.trim();
  const inReplyTo = messageId && MESSAGE_ID_TOKEN.test(messageId) ? messageId : undefined;
  const references = [...(header(original.payload, "References") ?? "").split(/\s+/), inReplyTo ?? ""]
    .filter((token) => MESSAGE_ID_TOKEN.test(token));
  const subject = (header(original.payload, "Subject") ?? "").replace(/[\r\n]+/g, " ").trim();
  return {
    threadId: original.threadId,
    inReplyTo,
    references: references.length ? [...new Set(references)].join(" ") : undefined,
    subject,
  };
}

export function draftSubject(input: CreateDraftArgs, reply?: ReplyContext): string {
  if (input.subject) return input.subject;
  if (!reply?.subject) return "";
  return /^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`;
}

export function assertDraftSupported(input: CreateDraftArgs): void {
  if (input.attachments?.length) throw new GoogleToolError("unsupported", "Drafts with attachments are not supported yet.");
}

export function createDraftRequest(input: CreateDraftArgs, reply: ReplyContext | undefined, boundary: string): GoogleRequest {
  const mime = buildDraftMime({
    to: input.to ?? [], cc: input.cc ?? [], bcc: input.bcc ?? [],
    subject: draftSubject(input, reply),
    body: input.body,
    htmlBody: input.htmlBody,
    inReplyTo: reply?.inReplyTo,
    references: reply?.references,
    boundary,
  });
  return {
    method: "POST",
    host: "gmail.googleapis.com",
    path: "/gmail/v1/users/me/drafts",
    body: { message: compact({ raw: Buffer.from(mime, "utf8").toString("base64url"), threadId: reply?.threadId }) },
  };
}

export function createDraftResult(draft: GmailRestDraft, input: CreateDraftArgs, reply: ReplyContext | undefined, now: Date): CallToolResult {
  return structuredResult(compact({
    id: draft.id ?? "",
    subject: draftSubject(input, reply),
    threadId: draft.message?.threadId,
    toRecipients: input.to ?? [],
    ccRecipients: input.cc ?? [],
    bccRecipients: input.bcc ?? [],
    plaintextBody: input.body,
    date: now.toISOString().slice(0, 10),
    htmlBody: input.htmlBody,
  }));
}

const recipients = (description: string) => ({ type: "array", items: { type: "string" }, description });

export const createDraft = defineTool({
  definition: {
    name: "create_draft",
    title: "Create a draft",
    description: "Creates a draft email in the signed-in user's Gmail and returns it. It does not send. To draft a reply, pass the original message's ID as replyToMessageId. Attachments are not supported yet.",
    inputSchema: {
      type: "object",
      properties: {
        to: recipients("Optional. To recipients, each a plain email address such as user@example.com. \"Name <email>\" is not supported."),
        cc: recipients("Optional. Cc recipients, each a plain email address."),
        bcc: recipients("Optional. Bcc recipients, each a plain email address."),
        subject: { type: "string", description: "Optional. The subject line. Empty when not given." },
        body: { type: "string", description: "Optional. The plain-text body. When htmlBody is also given, this is the plain-text alternative." },
        htmlBody: { type: "string", description: "The HTML body, used as the rich-text version." },
        replyToMessageId: { type: "string", description: "Optional. The ID of the message this draft replies to." },
        attachments: {
          type: "array",
          description: "Optional. Attachments, at most 25 MB in total. Not supported yet.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Output only. An external attachment ID." },
              filename: { type: "string", description: "Optional. The file name shown to recipients." },
              mimeType: { type: "string", description: "Optional. IANA media type. Default application/octet-stream." },
              content: { type: "string", description: "Required. The base64-encoded content." },
              inline: { type: "boolean", description: "Optional. Show inline in the HTML body. Default false." },
            },
            required: ["content"],
          },
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The draft ID." },
        subject: { type: "string", description: "The draft's subject line." },
        threadId: { type: "string", description: "The ID of the thread the draft belongs to." },
        toRecipients: recipients("To recipient email addresses."),
        ccRecipients: recipients("Cc recipient email addresses."),
        bccRecipients: recipients("Bcc recipient email addresses."),
        plaintextBody: { type: "string", description: "The plain-text body, if any." },
        date: { type: "string", description: "The draft date, ISO 8601 (YYYY-MM-DD)." },
        htmlBody: { type: "string", description: "The HTML body, if any." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  args,
  async run(input, http) {
    assertDraftSupported(input);
    const reply = input.replyToMessageId
      ? replyContext(await http.send<GmailRestMessage>(replyLookupRequest(input.replyToMessageId)))
      : undefined;
    const draft = await http.send<GmailRestDraft>(createDraftRequest(input, reply, `paperclip-${randomBytes(12).toString("hex")}`));
    return createDraftResult(draft, input, reply, new Date());
  },
});
