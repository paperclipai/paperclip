import { z } from "zod";
import type { GoogleRequest } from "../google-http.js";
import { defineTool } from "../tool.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  readThreads,
  searchThreadsResult,
  THREAD_VIEWS,
  threadIds,
  type GmailThreadList,
} from "./search-threads.js";
import { messageSchema } from "./schemas.js";

export const MAX_LABEL_FILTERS = 20;

const args = z.object({
  pageSize: z.number().int().positive().optional(),
  pageToken: z.string().max(2048).optional(),
  labelIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, "Must be a Gmail label ID")).max(MAX_LABEL_FILTERS).optional(),
  includeTrash: z.boolean().optional(),
  view: z.enum(THREAD_VIEWS).optional(),
});
export type ListThreadsArgs = z.infer<typeof args>;

export function listThreadsQuery(input: ListThreadsArgs): { q?: string; includeSpamTrash?: true } {
  const labels = new Set(input.labelIds ?? []);
  const includeSpamTrash = Boolean(input.includeTrash) || labels.has("SPAM") || labels.has("TRASH");
  const excluded: string[] = [];
  if (!labels.has("DRAFT")) excluded.push("-in:draft");
  if (includeSpamTrash && !labels.has("SPAM")) excluded.push("-in:spam");
  return { q: excluded.join(" ") || undefined, includeSpamTrash: includeSpamTrash ? true : undefined };
}

export function listThreadsToolRequest(input: ListThreadsArgs): GoogleRequest {
  return {
    method: "GET",
    host: "gmail.googleapis.com",
    path: "/gmail/v1/users/me/threads",
    query: {
      ...listThreadsQuery(input),
      labelIds: input.labelIds?.length ? input.labelIds : undefined,
      maxResults: Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      pageToken: input.pageToken || undefined,
    },
  };
}

export const listThreads = defineTool({
  definition: {
    name: "list_threads",
    description: "Lists the signed-in user's Gmail threads, newest first, one page at a time, optionally only threads that have every given label. Returns thread IDs with message summaries, not full bodies; use get_thread with a thread ID for full messages. To filter by words, senders or dates, use search_threads.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", description: "Optional. Most threads to return. Default 20, maximum 50." },
        pageToken: { type: "string", description: "Optional. The nextPageToken from a previous call. Leave empty for the first page." },
        labelIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional. Only threads with all of these label IDs, at most 20. User label IDs come from list_labels; system label IDs are INBOX, SPAM, TRASH, UNREAD, STARRED, IMPORTANT, SENT, DRAFT and CHAT. Drafts are excluded unless DRAFT is given.",
        },
        includeTrash: { type: "boolean", description: "Optional. Include threads in Trash. Default false." },
        view: {
          type: "string",
          enum: [...THREAD_VIEWS],
          description: "Optional. THREAD_VIEW_MINIMAL (default) returns id, snippet, subject, sender, recipients, date and labels. THREAD_VIEW_METADATA_ONLY leaves out snippet and subject.",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        threads: {
          type: "array",
          description: "The threads on this page.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "The thread ID." },
              messages: { type: "array", items: messageSchema, description: "The thread's messages, oldest first." },
            },
          },
        },
        nextPageToken: { type: "string", description: "Pass as pageToken to get the next page. Present only when there are more results." },
        resultCountEstimate: { type: "string", description: "Estimated number of results; treat as a lower bound." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  whenTooLarge: "Ask for fewer threads with a smaller pageSize, then read single threads with get_thread.",
  async run(input, http) {
    const list = await http.send<GmailThreadList>(listThreadsToolRequest(input));
    return searchThreadsResult(list, await readThreads(threadIds(list), http), { view: input.view });
  },
});
