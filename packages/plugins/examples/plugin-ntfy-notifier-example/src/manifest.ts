import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Manifest for the ntfy.sh Notifier Example Plugin.
 * 
 * This manifest defines the plugin's metadata, capabilities, and configuration schema.
 * It demonstrates how to subscribe to events, perform outbound HTTP requests, 
 * and resolve secrets for authentication.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.ntfy-notifier",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "ntfy.sh Notifier (Example)",
  description: "Reference automation plugin that posts agent and issue updates to ntfy.sh or self-hosted ntfy servers.",
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
      topic: {
        type: "string",
        description: "The ntfy topic name to publish notifications to."
      },
      serverUrl: {
        type: "string",
        description: "Optional custom ntfy server URL. Defaults to 'https://ntfy.sh'.",
        default: "https://ntfy.sh"
      },
      tokenSecretRef: {
        type: "string",
        description: "Optional Paperclip secret reference containing an access token for protected ntfy topics."
      },
      defaultPriority: {
        type: "integer",
        description: "Default priority for ntfy notifications (1=min, 5=urgent). Defaults to 3 (default).",
        minimum: 1,
        maximum: 5,
        default: 3
      },
      defaultTags: {
        type: "array",
        items: { type: "string" },
        description: "Default tags to include in every ntfy notification.",
        default: ["paperclip"]
      },
      eventAllowlist: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of event types that should be forwarded."
      }
    },
    required: ["topic"]
  }
};

export default manifest;
