import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "openclaw-notify",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "OpenClaw Notify",
  description:
    "Fires the OpenClaw webhook on meaningful Paperclip events (status changes, new comments, blocks, review requests). Replaces polling with push so Scotty wakes up immediately when something matters.",
  author: "Scotty",
  categories: ["automation", "connector"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "issues.read",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["webhookUrl", "webhookToken"],
    properties: {
      webhookUrl: {
        type: "string",
        title: "OpenClaw Webhook URL",
        description: "The /hooks/wake endpoint on the local OpenClaw gateway.",
        default: "http://100.109.87.122:18789/hooks/wake",
      },
      webhookToken: {
        type: "string",
        title: "OpenClaw Webhook Token",
        description: "Bearer token from openclaw.json hooks.token field.",
        default: "",
      },
      notifyOnStatusChange: {
        type: "boolean",
        title: "Notify on status change",
        default: true,
      },
      notifyOnComment: {
        type: "boolean",
        title: "Notify on comments needing attention",
        default: true,
      },
      notifyOnBlock: {
        type: "boolean",
        title: "Notify immediately when issue is blocked",
        default: true,
      },
      dedupeWindowSeconds: {
        type: "number",
        title: "Dedupe window (seconds)",
        description: "Suppress duplicate notifications for the same issue within this window.",
        default: 30,
      },
    },
  },
};

export default manifest;
