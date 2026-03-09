import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.slack-notifier",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Slack Notifier (Example)",
  description: "Reference automation plugin that posts agent and issue updates to Slack.",
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
        description: "Paperclip secret reference containing the Slack incoming webhook URL."
      },
      channel: {
        type: "string",
        description: "Optional channel override for incoming webhook payloads."
      },
      eventAllowlist: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of event types that should be forwarded."
      }
    },
    required: ["webhookSecretRef"]
  }
};

export default manifest;
