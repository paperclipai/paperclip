import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.nylas-mailbox";
export const FINANCE_GRANT_ID = "29eb5cbe-1129-42b9-93c9-53061483bb8c";
export const DEFAULT_MAX_ATTACHMENT_BYTES = 1_000_000;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Nylas Finance Mailbox",
  description: "Read-only search, message, thread, and attachment access to one configured Nylas mailbox for finance workflows.",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: [
    "agent.tools.register",
    "http.outbound",
    "secrets.read-ref",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      apiKey: {
        type: "object",
        format: "secret-ref",
        title: "Nylas API key",
        description: "Optional company-specific secret reference. When omitted, the plugin uses the server-side PAPERCLIP_NYLAS environment variable.",
      },
      grantId: {
        type: "string",
        title: "Finance mailbox grant ID",
        description: "The only Nylas grant this plugin may access. Agents cannot override it.",
        pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        default: FINANCE_GRANT_ID,
      },
      apiRegion: {
        type: "string",
        title: "Nylas API region",
        enum: ["us", "eu"],
        default: "us",
      },
      maxAttachmentBytes: {
        type: "integer",
        title: "Maximum attachment download size",
        description: "Maximum raw bytes returned by the attachment download tool. Downloaded content is returned as base64.",
        minimum: 1,
        maximum: 5_000_000,
        default: DEFAULT_MAX_ATTACHMENT_BYTES,
      },
    },
    additionalProperties: false,
  },
  tools: [
    {
      name: "nylas_search_messages",
      displayName: "Search Finance Mailbox",
      description: "Search messages in the configured finance mailbox. This tool cannot access another Nylas grant.",
      parametersSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 20, description: "Messages to return. Defaults to 20." },
          pageToken: { type: "string", maxLength: 2_000, description: "Pagination token from a previous result." },
          subject: { type: "string", maxLength: 500 },
          anyEmail: { type: "string", maxLength: 2_000, description: "Comma-separated email addresses matched across sender and recipients." },
          fromEmail: { type: "string", maxLength: 320 },
          toEmail: { type: "string", maxLength: 320 },
          unread: { type: "boolean" },
          hasAttachment: { type: "boolean" },
          receivedAfter: { type: "integer", minimum: 0, description: "Unix timestamp in seconds." },
          receivedBefore: { type: "integer", minimum: 0, description: "Unix timestamp in seconds." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "nylas_get_message",
      displayName: "Read Finance Message",
      description: "Read one message, including its body and attachment metadata, from the configured finance mailbox.",
      parametersSchema: {
        type: "object",
        properties: {
          messageId: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        required: ["messageId"],
        additionalProperties: false,
      },
    },
    {
      name: "nylas_read_thread",
      displayName: "Read Finance Thread",
      description: "Read a thread and its messages from the configured finance mailbox.",
      parametersSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", minLength: 1, maxLength: 2_000 },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Messages to return. Defaults to 50." },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
    },
    {
      name: "nylas_list_attachments",
      displayName: "List Finance Message Attachments",
      description: "List attachment metadata for one message in the configured finance mailbox.",
      parametersSchema: {
        type: "object",
        properties: {
          messageId: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        required: ["messageId"],
        additionalProperties: false,
      },
    },
    {
      name: "nylas_download_attachment",
      displayName: "Download Finance Attachment",
      description: "Download a size-capped attachment from one message in the configured finance mailbox and return it as base64.",
      parametersSchema: {
        type: "object",
        properties: {
          messageId: { type: "string", minLength: 1, maxLength: 2_000 },
          attachmentId: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        required: ["messageId", "attachmentId"],
        additionalProperties: false,
      },
    },
  ],
};

export default manifest;
