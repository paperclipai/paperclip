import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { defineTool, structuredResult } from "../tool.js";
import {
  bodyAttachmentRequest,
  externalBodyIds,
  gmailId,
  SUMMARY_HEADERS,
  toMcpMessage,
  type GmailRestAttachment,
  type GmailRestMessage,
  type MessageDetail,
} from "./message.js";
import { messageSchema } from "./schemas.js";

const MESSAGE_FORMATS = ["MESSAGE_FORMAT_UNSPECIFIED", "MINIMAL", "FULL_CONTENT", "METADATA_ONLY"] as const;

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

async function readExternalBodies(message: GmailRestMessage, input: GetMessageArgs, http: GoogleHttp): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  if (messageDetail(input.messageFormat) !== "full") return bodies;
  for (const attachmentId of externalBodyIds(message.payload)) {
    let answer: GmailRestAttachment;
    try {
      answer = await http.send<GmailRestAttachment>(bodyAttachmentRequest(input.messageId, attachmentId));
    } catch (error) {
      if (error instanceof GoogleToolError) {
        throw new GoogleToolError("incomplete", `Could not read the full body of this message. ${error.message}`, error.httpStatus);
      }
      throw error;
    }
    if (typeof answer.data !== "string") throw new GoogleToolError("incomplete", "Could not read the full body of this message.");
    bodies.set(attachmentId, answer.data);
  }
  return bodies;
}

export const getMessage = defineTool({
  definition: {
    name: "get_message",
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
  async run(input, http) {
    const message = await http.send<GmailRestMessage>(getMessageRequest(input));
    return getMessageResult(message, input, await readExternalBodies(message, input, http));
  },
});
