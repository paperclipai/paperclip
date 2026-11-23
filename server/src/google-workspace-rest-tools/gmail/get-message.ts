import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { defineTool, structuredResult } from "../tool.js";
import {
  gmailId,
  readMessageBodies,
  SUMMARY_HEADERS,
  toMcpMessage,
  type GmailRestMessage,
  type MessageDetail,
} from "./message.js";
import { messageSchema } from "./schemas.js";

export const MESSAGE_FORMATS =["MESSAGE_FORMAT_UNSPECIFIED", "MINIMAL", "FULL_CONTENT", "METADATA_ONLY"] as const;

const args = z.object({
  messageId: gmailId,
  messageFormat: z.enum(MESSAGE_FORMATS).optional(),
});
export type GetMessageArgs = z.infer<typeof args>;

export function messageDetail(format: GetMessageArgs["messageFormat"]): MessageDetail {
  if (format === "MINIMAL") return "minimal";
  if (format === "METADATA_ONLY") return "metadata_only";
  return "full";
}

export function getMessageRequest(input: GetMessageArgs): GoogleRequest {
  const detail = messageDetail(input.messageFormat);
  return {
    method: "GET",
    host: "gmail.googleapis.com",
    path: `/gmail/v1/users/me/messages/${input.messageId}`,
    query: detail === "full" ? { format: "full" } : { format: "metadata", metadataHeaders: SUMMARY_HEADERS },
  };
}

export function getMessageResult(
  message: GmailRestMessage,
  input: GetMessageArgs,
  externalBodies?: ReadonlyMap<string, string>,
): CallToolResult {
  return structuredResult(toMcpMessage(message, messageDetail(input.messageFormat), externalBodies));
}

async function readExternalBodies(message: GmailRestMessage, input: GetMessageArgs, http: GoogleHttp): Promise<ReadonlyMap<string, string> | undefined> {
  if (messageDetail(input.messageFormat) !== "full") return undefined;
  const bodies = await readMessageBodies([{ ...message, id: input.messageId }], http);
  return bodies.get(input.messageId);
}

export const getMessage = defineTool({
  definition: {
    name: "get_message",
    title: "Read a message",
    description: "Gets one email message from the signed-in user's Gmail by message ID.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Required. The ID of the message to get." },
        messageFormat: {
          type: "string",
          enum: [...MESSAGE_FORMATS],
          description: "Optional. How much of the message to return. MINIMAL: snippet and the Subject, From, To, Cc and Date headers. FULL_CONTENT (default): MINIMAL plus the body and attachments. METADATA_ONLY: no subject, snippet, body or attachment names.",
        },
      },
      required: ["messageId"],
    },
    outputSchema: messageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  whenTooLarge: "Read it with messageFormat METADATA_ONLY or MINIMAL, which leave out the bodies.",
  async run(input, http) {
    const message = await http.send<GmailRestMessage>(getMessageRequest(input));
    return getMessageResult(message, input, await readExternalBodies(message, input, http));
  },
});
