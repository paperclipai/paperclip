import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.telegram-notifier",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Telegram Notifier (Example)",
  description:
    "Reference automation plugin that posts agent and issue updates to a Telegram chat via Bot API.",
  author: "Paperclip",
  categories: ["automation", "connector"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.write",
    "activity.log.write",
    "metrics.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      botTokenRef: {
        type: "string",
        description:
          "Paperclip secret reference containing the Telegram Bot API token (from BotFather).",
      },
      chatId: {
        type: "string",
        description:
          "Telegram chat ID to send notifications to. Supports numeric IDs and @channel usernames.",
      },
      parseMode: {
        type: "string",
        enum: ["MarkdownV2", "HTML", "plain"],
        description:
          "Message formatting mode. Defaults to MarkdownV2 with plain text fallback.",
        default: "MarkdownV2",
      },
      eventAllowlist: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional list of event types to forward. Empty means all events.",
      },
    },
    required: ["botTokenRef", "chatId"],
  },
};

export default manifest;
