import { z } from "zod";
import { OutlookClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  execute: (input: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>, client: OutlookClient) => Promise<unknown>,
  client: OutlookClient,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed, client));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

const msgId = z.string().describe("Message ID from list/search results");
const emailList = z.array(z.string().email()).min(1).describe("List of email addresses");

export function createToolDefinitions(client: OutlookClient): ToolDefinition[] {
  return [
    // ── List folders ──────────────────────────────────────────────────────────
    makeTool(
      "outlook_list_folders",
      "List all mail folders in the mailbox (Inbox, Sent, Drafts, custom folders, etc.).",
      z.object({}),
      async () => client.listFolders(),
      client,
    ),

    // ── List emails ───────────────────────────────────────────────────────────
    makeTool(
      "outlook_list_emails",
      "List emails in a mail folder. Defaults to Inbox, newest first.",
      z.object({
        folder: z.string().default("inbox").describe("Folder name or ID (default: inbox)"),
        top: z.number().int().min(1).max(100).default(20).describe("Number of emails to return"),
        onlyUnread: z.boolean().default(false).describe("Return only unread emails"),
      }),
      async ({ folder, top, onlyUnread }) => client.listEmails({ folder, top, onlyUnread }),
      client,
    ),

    // ── Read email ────────────────────────────────────────────────────────────
    makeTool(
      "outlook_read_email",
      "Read the full content of an email including body, sender, recipients, and metadata.",
      z.object({ messageId: msgId }),
      async ({ messageId }) => client.readEmail(messageId),
      client,
    ),

    // ── Search emails ─────────────────────────────────────────────────────────
    makeTool(
      "outlook_search_emails",
      "Search emails across all folders by keyword (subject, body, sender).",
      z.object({
        query: z.string().describe("Search term"),
        top: z.number().int().min(1).max(50).default(20),
      }),
      async ({ query, top }) => client.searchEmails(query, top),
      client,
    ),

    // ── Mark as read ──────────────────────────────────────────────────────────
    makeTool(
      "outlook_mark_read",
      "Mark an email as read.",
      z.object({ messageId: msgId }),
      async ({ messageId }) => { await client.markAsRead(messageId); return { ok: true }; },
      client,
    ),

    // ── Create draft ──────────────────────────────────────────────────────────
    makeTool(
      "outlook_create_draft",
      "Create a draft email (not sent). Returns the draft message ID for review or editing before sending.",
      z.object({
        subject: z.string(),
        body: z.string().describe("Email body content"),
        toRecipients: emailList,
        ccRecipients: z.array(z.string().email()).default([]),
        isHtml: z.boolean().default(false).describe("Set true if body contains HTML"),
      }),
      async ({ subject, body, toRecipients, ccRecipients, isHtml }) =>
        client.createDraft({ subject, body, toRecipients, ccRecipients, isHtml }),
      client,
    ),

    // ── Update draft ──────────────────────────────────────────────────────────
    makeTool(
      "outlook_update_draft",
      "Update an existing draft email (change subject, body, or recipients).",
      z.object({
        messageId: msgId,
        subject: z.string().optional(),
        body: z.string().optional(),
        toRecipients: z.array(z.string().email()).optional(),
        ccRecipients: z.array(z.string().email()).optional(),
        isHtml: z.boolean().default(false),
      }),
      async ({ messageId, ...patch }) => client.updateDraft(messageId, patch),
      client,
    ),

    // ── Send draft ────────────────────────────────────────────────────────────
    makeTool(
      "outlook_send_draft",
      "Send an existing draft email by its message ID.",
      z.object({ messageId: msgId }),
      async ({ messageId }) => { await client.sendDraft(messageId); return { sent: true }; },
      client,
    ),

    // ── Send email ────────────────────────────────────────────────────────────
    makeTool(
      "outlook_send_email",
      "Compose and send an email immediately.",
      z.object({
        subject: z.string(),
        body: z.string(),
        toRecipients: emailList,
        ccRecipients: z.array(z.string().email()).default([]),
        isHtml: z.boolean().default(false),
      }),
      async ({ subject, body, toRecipients, ccRecipients, isHtml }) => {
        await client.sendEmail({ subject, body, toRecipients, ccRecipients, isHtml });
        return { sent: true };
      },
      client,
    ),

    // ── Reply ─────────────────────────────────────────────────────────────────
    makeTool(
      "outlook_reply",
      "Reply to an email. Set replyAll=true to reply to all recipients.",
      z.object({
        messageId: msgId,
        body: z.string().describe("Reply body text"),
        replyAll: z.boolean().default(false),
      }),
      async ({ messageId, body, replyAll }) => {
        await client.replyToEmail(messageId, body, replyAll);
        return { replied: true };
      },
      client,
    ),

    // ── Forward ───────────────────────────────────────────────────────────────
    makeTool(
      "outlook_forward",
      "Forward an email to one or more recipients.",
      z.object({
        messageId: msgId,
        toRecipients: emailList,
        comment: z.string().default("").describe("Optional comment to add above forwarded content"),
      }),
      async ({ messageId, toRecipients, comment }) => {
        await client.forwardEmail(messageId, toRecipients, comment);
        return { forwarded: true };
      },
      client,
    ),

    // ── Move email ────────────────────────────────────────────────────────────
    makeTool(
      "outlook_move_email",
      "Move an email to a different folder.",
      z.object({
        messageId: msgId,
        destinationFolderId: z.string().describe("Target folder ID (use outlook_list_folders to get IDs)"),
      }),
      async ({ messageId, destinationFolderId }) =>
        client.moveEmail(messageId, destinationFolderId),
      client,
    ),

    // ── Delete email ──────────────────────────────────────────────────────────
    makeTool(
      "outlook_delete_email",
      "Delete an email permanently.",
      z.object({ messageId: msgId }),
      async ({ messageId }) => { await client.deleteEmail(messageId); return { deleted: true }; },
      client,
    ),
  ];
}
