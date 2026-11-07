import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GmailClient } from "./google-client.js";

export type ToolResult = CallToolResult;

export interface GmailToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject;
  annotations: ToolAnnotations;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

export interface GmailToolOptions {
  client: GmailClient;
  secretRedactions?: string[];
}

type ToolRisk = "read" | "write";

const emailListSchema = z.array(z.string().trim().email()).max(50);

const searchThreadsSchema = z.object({
  q: z.string().trim().min(1).max(500),
  max_results: z.number().int().positive().max(50).optional().default(25),
  page_token: z.string().trim().min(1).optional(),
});

const threadIdSchema = z.object({
  thread_id: z.string().trim().min(1),
});

const messageIdSchema = z.object({
  message_id: z.string().trim().min(1),
});

const listDraftsSchema = z.object({
  max_results: z.number().int().positive().max(50).optional().default(25),
  page_token: z.string().trim().min(1).optional(),
});

const draftIdSchema = z.object({
  draft_id: z.string().trim().min(1),
});

const createDraftSchema = z.object({
  to: emailListSchema.min(1),
  cc: emailListSchema.optional(),
  bcc: emailListSchema.optional(),
  subject: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(50_000),
  reply_to_message_id: z.string().trim().min(1).optional(),
});

function annotationsFor(title: string, risk: ToolRisk): ToolAnnotations {
  if (risk === "read") {
    return { title, readOnlyHint: true, openWorldHint: false };
  }
  // "write" here is strictly scoped to draft creation — this module has no
  // tool, schema, or client method for send/trash/delete/modify-labels, so
  // destructiveHint stays false and there is nothing to mark as destructive.
  return { title, readOnlyHint: false, destructiveHint: false, openWorldHint: false };
}

function formatTextResponse(value: unknown): ToolResult {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((entry) => entry.message).join("; ");
  if (error instanceof Error) return error.message;
  return String(error);
}

function redact(value: string, secretRedactions: string[]): string {
  let output = value;
  for (const secret of secretRedactions) {
    if (secret.length >= 8) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

function formatErrorResponse(error: unknown, secretRedactions: string[]): ToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: redact(errorMessage(error), secretRedactions),
    }],
  };
}

function makeTool<TSchema extends z.ZodRawShape>(
  options: GmailToolOptions,
  name: string,
  description: string,
  risk: ToolRisk,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<unknown>,
): GmailToolDefinition {
  return {
    name,
    description,
    schema,
    annotations: annotationsFor(description, risk),
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed));
      } catch (error) {
        return formatErrorResponse(error, options.secretRedactions ?? []);
      }
    },
  };
}

/**
 * Builds the tool set for the GA Gmail REST API. Deliberately omits any
 * send, trash, delete, or label-mutation tool even though the
 * `gmail.compose` OAuth scope would technically permit sending mail through
 * `users.messages.send` — this server has no code path to that endpoint at
 * all, so a caller cannot reach it no matter what tool arguments it sends.
 */
export function createToolDefinitions(options: GmailToolOptions): GmailToolDefinition[] {
  return [
    makeTool(
      options,
      "get_profile",
      "Get the Gmail account profile (email address, message/thread counts) for the authorized mailbox.",
      "read",
      z.object({}),
      async () => options.client.getProfile(),
    ),
    makeTool(
      options,
      "search_threads",
      "Search Gmail threads using Gmail's search syntax. Returns From/To/Subject/Date metadata and a snippet per thread.",
      "read",
      searchThreadsSchema,
      async ({ q, max_results, page_token }) =>
        options.client.searchThreads({ query: q, maxResults: max_results, pageToken: page_token }),
    ),
    makeTool(
      options,
      "get_thread",
      "Get every message in a Gmail thread, including each message's headers and plain-text body.",
      "read",
      threadIdSchema,
      async ({ thread_id }) => options.client.getThread(thread_id),
    ),
    makeTool(
      options,
      "get_message",
      "Get one Gmail message: headers, plain-text body (HTML stripped when no plain-text part exists, capped at 20,000 characters), and attachment filenames.",
      "read",
      messageIdSchema,
      async ({ message_id }) => options.client.getMessage(message_id),
    ),
    makeTool(
      options,
      "list_labels",
      "List the Gmail labels (system and user-created) on the authorized mailbox.",
      "read",
      z.object({}),
      async () => options.client.listLabels(),
    ),
    makeTool(
      options,
      "list_drafts",
      "List drafts in the authorized mailbox.",
      "read",
      listDraftsSchema,
      async ({ max_results, page_token }) =>
        options.client.listDrafts({ maxResults: max_results, pageToken: page_token }),
    ),
    makeTool(
      options,
      "get_draft",
      "Get one draft by ID.",
      "read",
      draftIdSchema,
      async ({ draft_id }) => options.client.getDraft(draft_id),
    ),
    makeTool(
      options,
      "create_draft",
      "Create a Gmail draft (to/cc/bcc/subject/body). Optionally set reply_to_message_id to thread it as a reply (sets In-Reply-To/References and the draft's threadId). This only ever creates a draft — there is no tool that sends mail.",
      "write",
      createDraftSchema,
      async ({ to, cc, bcc, subject, body, reply_to_message_id }) =>
        options.client.createDraft({ to, cc, bcc, subject, body, replyToMessageId: reply_to_message_id }),
    ),
  ];
}
