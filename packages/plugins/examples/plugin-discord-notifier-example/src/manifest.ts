import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.discord-notifier",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Discord Notifier (Example)",
  description: "Reference automation plugin that posts Paperclip events to Discord channels via webhook with rich embeds.",
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
        description: "Paperclip secret reference containing the Discord webhook URL."
      },
      username: {
        type: "string",
        description: "Optional display name override for the Discord webhook bot.",
        default: "Paperclip"
      },
      avatarUrl: {
        type: "string",
        description: "Optional avatar URL for the Discord webhook bot."
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
