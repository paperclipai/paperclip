import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.webhook-notifier",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Webhook Notifier (Example)",
  description: "Reference automation plugin that delivers Paperclip events to arbitrary webhook endpoints with optional HMAC signing.",
  author: "Paperclip",
  categories: ["automation", "connector"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.write",
    "activity.log.write",
    "metrics.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js"
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      webhookSecretRef: {
        type: "string",
        description: "Paperclip secret reference containing the webhook endpoint URL."
      },
      signingSecretRef: {
        type: "string",
        description: "Optional Paperclip secret reference for HMAC-SHA256 signing. When set, each request includes an X-Paperclip-Signature header."
      },
      eventAllowlist: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of event types that should be forwarded. Empty means all events."
      }
    },
    required: ["webhookSecretRef"]
  }
};

export default manifest;
