export const LIST_CHAT_ATTACHMENTS_TOOL_NAME = "list_chat_attachments";
export const REUSE_CHAT_ATTACHMENT_TOOL_NAME = "reuse_chat_attachment";

export const LIST_CHAT_ATTACHMENTS_TOOL_DEFINITION = Object.freeze({
  name: LIST_CHAT_ATTACHMENTS_TOOL_NAME,
  description:
    "List metadata for files already received or delivered in this same external-chat conversation. Call with {} for the latest page (default 20), or set limit to an integer from 1 through 50. Page through nextCursor to find older files, or filter by an exact sourceCommentId when known. File bytes and private storage locations are never returned.",
  inputSchema: {
    type: "object",
    properties: {
      sourceCommentId: {
        type: ["string", "null"],
        description:
          "Optional exact sourceCommentId returned by this tool on an earlier page.",
      },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      cursor: {
        type: ["string", "null"],
        maxLength: 1024,
        description: "Opaque nextCursor from the immediately preceding page.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: {
    semanticContract: "paperclip.server-chat-attachment-reuse.v1",
    operationId: LIST_CHAT_ATTACHMENTS_TOOL_NAME,
    version: 1,
    exposure: "run_scoped",
    requiredClaims: [],
  },
});

export const REUSE_CHAT_ATTACHMENT_TOOL_DEFINITION = Object.freeze({
  name: REUSE_CHAT_ATTACHMENT_TOOL_NAME,
  description:
    "Prepare one exact file previously received or delivered in this same external-chat conversation for the current response. All four arguments are required: copy sourceCommentId and attachmentId from list_chat_attachments, provide a nonempty title, and choose a nonempty idempotencyKey of at most 200 characters once for this reuse; send that same key unchanged on every retry. This queues a verified copy for final publication; it does not confirm provider delivery.",
  inputSchema: {
    type: "object",
    properties: {
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      sourceCommentId: { type: "string", format: "uuid" },
      attachmentId: { type: "string", format: "uuid" },
      title: { type: "string", minLength: 1, maxLength: 500 },
    },
    required: ["idempotencyKey", "sourceCommentId", "attachmentId", "title"],
    additionalProperties: false,
  },
  annotations: {
    semanticContract: "paperclip.server-chat-attachment-reuse.v1",
    operationId: REUSE_CHAT_ATTACHMENT_TOOL_NAME,
    version: 1,
    exposure: "run_scoped",
    requiredClaims: [],
  },
});
