import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.telegram-ingress";
const PLUGIN_VERSION = "0.1.0";

/**
 * Telegram mention-ingress plugin manifest.
 *
 * Polls the Telegram Bot API for new updates containing directed mentions
 * (private messages or @-mentions in groups). Each Telegram conversation
 * is mapped to a Paperclip issue with threaded comments. Every incoming
 * directed mention appends a comment with a literal @Director mention
 * to wake the Director agent.
 *
 * Inbound-only: does NOT send messages back to Telegram.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Telegram Mention Ingress",
  description:
    "Polls Telegram for directed bot mentions and creates threaded Paperclip issues. Inbound-only — no Telegram replies.",
  author: "DSpot",
  categories: ["automation", "connector"],

  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "issues.create",
    "issues.read",
    "issue.comments.create",
    "jobs.schedule",
    "agents.read",
    "activity.log.write",
  ],

  entrypoints: {
    worker: "./dist/worker.js",
  },

  instanceConfigSchema: {
    type: "object",
    properties: {
      botTokenSecretRef: {
        type: "string",
        title: "Bot Token Secret Reference",
        description:
          "Secret reference key for the Telegram Bot API token (e.g. TELEGRAM_BOT_TOKEN). Store the value via the board secrets API.",
      },
      targetCompanyId: {
        type: "string",
        title: "Target Company ID",
        description: "UUID of the company where ingress issues will be created.",
      },
      directorAgentId: {
        type: "string",
        title: "Director Agent ID",
        description:
          "UUID of the Director agent to @-mention in every ingress comment. Used to build the [@Director](agent://uuid) link that triggers heartbeat wakes.",
      },
      directorDisplayName: {
        type: "string",
        title: "Director Display Name",
        description:
          "Display name for the Director agent mention (e.g. 'Director'). Defaults to 'Director'.",
        default: "Director",
      },
      targetProjectId: {
        type: "string",
        title: "Target Project ID (optional)",
        description: "UUID of the project to assign ingress issues to. Optional.",
      },
      targetGoalId: {
        type: "string",
        title: "Target Goal ID (optional)",
        description: "UUID of the goal to associate ingress issues with. Optional.",
      },
    },
    required: ["botTokenSecretRef", "targetCompanyId", "directorAgentId"],
  },

  jobs: [
    {
      jobKey: "poll-telegram",
      displayName: "Poll Telegram Mentions",
      description:
        "Polls the Telegram Bot API getUpdates endpoint for new directed mentions and creates/updates Paperclip issues.",
      schedule: "*/1 * * * *",
    },
  ],
};

export default manifest;
