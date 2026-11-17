import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import { getMessageRequest, MESSAGE_FORMATS, messageDetail } from "./get-message.js";
import { readMessageBodies, toMcpMessage, type GmailRestMessage, type MessageBodies } from "./message.js";
import { mapLimited, unlessMissing } from "./parallel.js";
import { messageSchema } from "./schemas.js";
import { DEFAULT_PAGE_SIZE, effectiveQuery, MAX_PAGE_SIZE } from "./search-threads.js";

const args = z.object({
  pageSize: z.number().int().positive().optional(),
  pageToken: z.string().max(2048).optional(),
  query: z.string().max(4096).optional(),
  includeTrash: z.boolean().optional(),
  messageFormat: z.enum(MESSAGE_FORMATS).optional(),
});
export type SearchMessagesArgs = z.infer<typeof args>;

interface GmailMessageList {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export function searchMessageFormat(format: SearchMessagesArgs["messageFormat"]): Exclude<SearchMessagesArgs["messageFormat"], undefined> {
  return format === undefined || format === "MESSAGE_FORMAT_UNSPECIFIED" ? "MINIMAL" : format;
}

export function listMessagesRequest(input: SearchMessagesArgs): GoogleRequest {
  return {
    method: "GET",
    host: "gmail.googleapis.com",
    path: "/gmail/v1/users/me/messages",
    query: {
      q: effectiveQuery(input),
      maxResults: Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      pageToken: input.pageToken || undefined,
      includeSpamTrash: input.includeTrash ? true : undefined,
    },
  };
}

export function messageIds(list: GmailMessageList): string[] {
  return (list.messages ?? []).map((message) => message.id).filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id));
}

export function searchMessagesResult(
  list: GmailMessageList,
  messages: Array<GmailRestMessage | null>,
  input: SearchMessagesArgs,
  bodies: MessageBodies = new Map(),
): CallToolResult {
  const detail = messageDetail(searchMessageFormat(input.messageFormat));
  return structuredResult(compact({
    messages: messages
      .filter((message): message is GmailRestMessage => message !== null)
      .map((message) => toMcpMessage(message, detail, bodies.get(message.id ?? ""))),
    nextPageToken: list.nextPageToken || undefined,
    resultCountEstimate: typeof list.resultSizeEstimate === "number" ? String(list.resultSizeEstimate) : undefined,
  }));
}

async function readMessages(ids: string[], input: SearchMessagesArgs, http: GoogleHttp): Promise<Array<GmailRestMessage | null>> {
  const messageFormat = searchMessageFormat(input.messageFormat);
  return mapLimited(ids, (messageId) => unlessMissing(http.send<GmailRestMessage>(getMessageRequest({ messageId, messageFormat }))));
}

export const searchMessages = defineTool({
  definition: {
    name: "search_messages",
    description: "Lists the signed-in user's Gmail messages that match an optional Gmail search query, newest first, one page at a time. Returns message summaries by default; set messageFormat to FULL_CONTENT for bodies, or use get_message with a message ID.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", description: "Optional. Most messages to return. Default 20, maximum 50." },
        pageToken: { type: "string", description: "Optional. The nextPageToken from a previous call. Leave empty for the first page." },
        query: {
          type: "string",
          description: "Optional. A Gmail search query (for example `from:user@example.com newer_than:7d has:attachment`). Convert natural language to Gmail syntax first. `label:` takes a label name with spaces written as hyphens (for example `label:client-work`), not a label ID; list_labels lists the names. Without a query, all messages except spam and trash are listed. Drafts are excluded unless the query includes in:draft.",
        },
        includeTrash: { type: "boolean", description: "Optional. Include messages in Trash. Default false." },
        messageFormat: {
          type: "string",
          enum: [...MESSAGE_FORMATS],
          description: "Optional. How much of each message to return. MINIMAL (default): snippet and the Subject, From, To, Cc and Date headers. FULL_CONTENT: MINIMAL plus the bodies and attachments. METADATA_ONLY: no subject, snippet, body or attachment names.",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        messages: { type: "array", items: messageSchema, description: "Matching messages, newest first." },
        nextPageToken: { type: "string", description: "Pass as pageToken to get the next page. Present only when there are more results." },
        resultCountEstimate: { type: "string", description: "Estimated number of results; treat as a lower bound." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  async run(input, http) {
    const list = await http.send<GmailMessageList>(listMessagesRequest(input));
    const messages = await readMessages(messageIds(list), input, http);
    const full = messageDetail(searchMessageFormat(input.messageFormat)) === "full";
    const bodies = full ? await readMessageBodies(messages.filter((message): message is GmailRestMessage => message !== null), http) : undefined;
    return searchMessagesResult(list, messages, input, bodies);
  },
});
