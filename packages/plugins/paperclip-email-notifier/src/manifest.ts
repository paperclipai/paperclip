import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.email-notifier",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Email Notifier",
  description:
    "Sends Paperclip event notifications via email using Resend or SendGrid.",
  author: "Paperclip",
  categories: ["automation", "connector"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write",
    "metrics.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: ["resend", "sendgrid"],
        description: "Email API provider.",
        default: "resend",
      },
      apiKeySecretRef: {
        type: "string",
        description:
          "Paperclip secret reference containing the provider API key.",
      },
      fromAddress: {
        type: "string",
        description:
          "Sender email address. Must be verified with your provider.",
      },
      fromName: {
        type: "string",
        description: "Sender display name.",
        default: "Paperclip",
      },
      toAddresses: {
        type: "array",
        items: { type: "string" },
        description: "Recipient email addresses (max 20).",
        minItems: 1,
        maxItems: 20,
      },
      subjectPrefix: {
        type: "string",
        description: "Prefix for email subject lines.",
        default: "[Paperclip]",
      },
      eventAllowlist: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional list of event types to forward. Empty means all events.",
      },
    },
    required: ["provider", "apiKeySecretRef", "fromAddress", "toAddresses"],
  },
};

export default manifest;
