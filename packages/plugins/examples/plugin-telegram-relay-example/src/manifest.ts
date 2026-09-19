import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.telegram-relay-example";
const PLUGIN_VERSION = "0.1.0";

/**
 * Telegram Relay plugin manifest.
 *
 * This plugin polls Telegram for new messages on a 2-minute cron schedule
 * and posts each message as a comment on a designated "Inbound" issue.
 * The comment triggers an agent heartbeat, waking the assigned agent
 * to process the message.
 *
 * For near-instant delivery, use the companion `relay.mjs` long-polling
 * script instead of (or alongside) the cron job. See README.md for details.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Telegram Relay (Example)",
  description:
    "Bridges incoming Telegram messages to Paperclip issue comments, waking agents in real time.",
  author: "Paperclip",
  categories: ["connector", "automation"],

  capabilities: [
    "jobs.schedule",
    "http.outbound",
    "issues.read",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
  ],

  entrypoints: {
    worker: "./dist/worker.js",
  },

  instanceConfigSchema: {
    type: "object",
    properties: {
      telegramBotToken: {
        type: "string",
        description: "Telegram Bot API token (from @BotFather)",
      },
      telegramChatId: {
        type: "string",
        description: "Telegram chat ID to monitor",
      },
      relayIssueId: {
        type: "string",
        description:
          "Paperclip issue ID where incoming messages are posted as comments",
      },
      agentMention: {
        type: "string",
        description:
          "Optional @AgentName to include in comments so the agent gets a heartbeat trigger",
      },
    },
    required: ["telegramBotToken", "telegramChatId", "relayIssueId"],
  },

  jobs: [
    {
      jobKey: "poll-telegram",
      displayName: "Poll Telegram",
      description:
        "Polls Telegram getUpdates every 2 minutes for new messages (fallback for the real-time relay script)",
      schedule: "*/2 * * * *",
    },
  ],
};

export default manifest;
