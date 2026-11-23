import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import { SUMMARY_HEADERS, toMcpMessage, type GmailRestMessage, type McpGmailMessage, type MessageDetail } from "./message.js";
import { messageSchema } from "./schemas.js";

export const THREAD_VIEWS = ["THREAD_VIEW_UNSPECIFIED", "THREAD_VIEW_MINIMAL", "THREAD_VIEW_METADATA_ONLY"] as const;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
const THREAD_FETCH_CONCURRENCY = 10;

const args = z.object({
  pageSize: z.number().int().positive().optional(),
  pageToken: z.string().max(2048).optional(),
  query: z.string().max(4096).optional(),
  includeTrash: z.boolean().optional(),
  view: z.enum(THREAD_VIEWS).optional(),
});
export type SearchThreadsArgs = z.infer<typeof args>;

export interface GmailThreadList {
  threads?: Array<{ id?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}
export interface GmailRestThread { id?: string; messages?: GmailRestMessage[] }

export function unquotedOperators(query: string): string {
  return query.replace(/"[^"]*"?/g, " ");
}

export function effectiveQuery(input: SearchThreadsArgs): string {
  const query = (input.query ?? "").trim();
  const operators = unquotedOperators(query);
  const added: string[] = [];
  if (!/(^|[\s({])-?(in|is):(drafts?|anywhere)\b/i.test(operators)) added.push("-in:draft");
  if (input.includeTrash && !/(^|[\s({])-?(in|is):(spam|anywhere)\b/i.test(operators)) added.push("-in:spam");
  if (!query) return added.join(" ");
  if (added.length === 0) return query;
  return [`(${query})`, ...added].join(" ");
}

export function threadDetail(view: SearchThreadsArgs["view"]): MessageDetail {
  return view === "THREAD_VIEW_METADATA_ONLY" ? "metadata_only" : "minimal";
}

export function listThreadsRequest(input: SearchThreadsArgs): GoogleRequest {
  return {
    method: "GET",
    host: "gmail.googleapis.com",
    path: "/gmail/v1/users/me/threads",
    query: {
      q: effectiveQuery(input),
      maxResults: Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      pageToken: input.pageToken || undefined,
      includeSpamTrash: input.includeTrash ? true : undefined,
    },
  };
}

export function threadIds(list: GmailThreadList): string[] {
  return (list.threads ?? []).map((thread) => thread.id).filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id));
}

export function getThreadRequest(threadId: string): GoogleRequest {
  return {
    method: "GET",
    host: "gmail.googleapis.com",
    path: `/gmail/v1/users/me/threads/${threadId}`,
    query: { format: "metadata", metadataHeaders: SUMMARY_HEADERS },
  };
}

export function searchThreadsResult(list: GmailThreadList, threads: Array<GmailRestThread | null>, input: SearchThreadsArgs): CallToolResult {
  const detail = threadDetail(input.view);
  const mapped = threads.filter((thread): thread is GmailRestThread => thread !== null).map((thread) => ({
    id: thread.id ?? "",
    messages: (thread.messages ?? []).map((message): McpGmailMessage => toMcpMessage(message, detail)),
  }));
  return structuredResult(compact({
    threads: mapped,
    nextPageToken: list.nextPageToken || undefined,
    resultCountEstimate: typeof list.resultSizeEstimate === "number" ? String(list.resultSizeEstimate) : undefined,
  }));
}

export async function readThreads(ids: string[], http: GoogleHttp): Promise<Array<GmailRestThread | null>> {
  const results: Array<GmailRestThread | null> = new Array(ids.length).fill(null);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < ids.length) {
      const index = next++;
      try {
        results[index] = await http.send<GmailRestThread>(getThreadRequest(ids[index]!));
      } catch (error) {
        if (error instanceof GoogleToolError && error.kind === "not_found") continue;
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(THREAD_FETCH_CONCURRENCY, ids.length) }, worker));
  return results;
}

export const searchThreads = defineTool({
  definition: {
    name: "search_threads",
    title: "Search threads",
    description: "Lists the signed-in user's Gmail threads that match an optional Gmail search query, one page at a time. Returns thread IDs with message summaries, not full bodies; use get_thread with a thread ID for full messages. A thread matches when any of its messages matches.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", description: "Optional. Most threads to return. Default 20, maximum 50." },
        pageToken: { type: "string", description: "Optional. The nextPageToken from a previous call. Leave empty for the first page." },
        query: {
          type: "string",
          description: "Optional. A Gmail search query (for example `from:user@example.com newer_than:7d has:attachment`). Convert natural language to Gmail syntax first. `label:` takes a label name with spaces written as hyphens (for example `label:client-work`), not a label ID; list_labels lists the names. Without a query, all threads except spam and trash are listed. Drafts are excluded unless the query includes in:draft.",
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
          description: "Matching threads.",
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
    const list = await http.send<GmailThreadList>(listThreadsRequest(input));
    return searchThreadsResult(list, await readThreads(threadIds(list), http), input);
  },
});
