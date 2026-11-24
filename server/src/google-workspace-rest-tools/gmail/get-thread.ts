import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleRequest } from "../google-http.js";
import { defineTool, structuredResult } from "../tool.js";
import { MESSAGE_FORMATS, messageDetail } from "./get-message.js";
import { gmailId, readMessageBodies, SUMMARY_HEADERS, toMcpMessage, type GmailRestMessage, type MessageBodies } from "./message.js";
import { messageSchema } from "./schemas.js";

const args = z.object({
  threadId: gmailId,
  messageFormat: z.enum(MESSAGE_FORMATS).optional(),
});
export type GetThreadArgs = z.infer<typeof args>;

export interface GmailRestFullThread { id?: string; messages?: GmailRestMessage[] }

export function readThreadRequest(input: GetThreadArgs): GoogleRequest {
  const detail = messageDetail(input.messageFormat);
  return {
    method: "GET",
    host: "gmail.googleapis.com",
    path: `/gmail/v1/users/me/threads/${input.threadId}`,
    query: detail === "full" ? { format: "full" } : { format: "metadata", metadataHeaders: SUMMARY_HEADERS },
  };
}

export function getThreadResult(thread: GmailRestFullThread, input: GetThreadArgs, bodies: MessageBodies = new Map()): CallToolResult {
  const detail = messageDetail(input.messageFormat);
  return structuredResult({
    id: thread.id ?? input.threadId,
    messages: (thread.messages ?? []).map((message) => toMcpMessage(message, detail, bodies.get(message.id ?? ""))),
  });
}

export const getThread = defineTool({
  definition: {
    name: "get_thread",
    title: "Read a thread",
    description: "Gets one email thread from the signed-in user's Gmail by thread ID, with its messages oldest first.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Required. The ID of the thread to get." },
        messageFormat: {
          type: "string",
          enum: [...MESSAGE_FORMATS],
          description: "Optional. How much of each message to return. MINIMAL: snippet and the Subject, From, To, Cc and Date headers. FULL_CONTENT (default): MINIMAL plus the bodies and attachments. METADATA_ONLY: no subject, snippet, body or attachment names.",
        },
      },
      required: ["threadId"],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The thread ID." },
        messages: { type: "array", items: messageSchema, description: "The thread's messages, oldest first." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  whenTooLarge: "Read it with messageFormat METADATA_ONLY or MINIMAL, which leave out the bodies, then read single messages with get_message.",
  async run(input, http) {
    const thread = await http.send<GmailRestFullThread>(readThreadRequest(input));
    const bodies = messageDetail(input.messageFormat) === "full" ? await readMessageBodies(thread.messages ?? [], http) : undefined;
    return getThreadResult(thread, input, bodies);
  },
});
