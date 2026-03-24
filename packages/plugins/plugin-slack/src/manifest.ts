import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  EXPORT_NAMES,
  JOB_KEYS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Slack",
  description:
    "Two-way Slack integration. Each Paperclip agent gets their own Slack bot — they post updates to channels, respond in threads, and take feedback (issues and comments) from Slack, all synced with your org chart, projects, goals, and issues.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "agents.read",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "jobs.schedule",
    "webhooks.receive",
    "http.outbound",
    "secrets.read-ref",
    "instance.settings.register",
    "ui.detailTab.register",
    "ui.commentAnnotation.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      signingSecret: {
        type: "string",
        title: "Slack Signing Secret",
        description:
          "The signing secret from your Slack app's Basic Information page. Used to verify inbound webhook payloads.",
      },
      appToken: {
        type: "string",
        title: "App-Level Token (xapp-…) — Socket Mode",
        description:
          "Generate under your Slack app → Settings → Basic Information → App-Level Tokens. Required for Socket Mode (local/Docker dev). Leave blank to use the Events API webhook (production).",
      },
      defaultAgentId: {
        type: "string",
        title: "Default Agent ID",
        description:
          "Paperclip agent ID used as fallback when a Slack message cannot be attributed to a specific agent.",
      },
      agents: {
        type: "array",
        title: "Agent Bot Tokens",
        description:
          "One entry per Paperclip agent. Each entry maps the agent's Paperclip ID to their Slack bot credentials.",
        items: {
          type: "object",
          properties: {
            agentId: {
              type: "string",
              title: "Paperclip Agent ID",
            },
            botToken: {
              type: "string",
              title: "Bot Token (xoxb-…)",
            },
            botUserId: {
              type: "string",
              title: "Bot User ID (U…)",
              description:
                "The Slack user ID for this bot (find via auth.test). Used for echo prevention.",
            },
            displayName: {
              type: "string",
              title: "Display Name",
              description: "Human-readable name shown in Paperclip UI.",
            },
            signingSecret: {
              type: "string",
              title: "Signing Secret",
              description: "Slack app signing secret (for Events API webhook verification).",
            },
          },
          required: ["agentId", "botToken"],
        },
      },
      channelMappings: {
        type: "array",
        title: "Channel → Project Mappings",
        description:
          "Map Slack channels to Paperclip projects. Issues created from channel mentions will be placed in the mapped project.",
        items: {
          type: "object",
          properties: {
            slackChannelId: {
              type: "string",
              title: "Slack Channel ID (C…)",
            },
            channelName: {
              type: "string",
              title: "Channel Name",
              description: "Human-readable label (e.g. #product).",
            },
            paperclipProjectId: {
              type: "string",
              title: "Paperclip Project ID",
            },
          },
          required: ["slackChannelId", "paperclipProjectId"],
        },
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.TOKEN_HEALTH,
      displayName: "Token Health Check",
      description:
        "Calls auth.test for every configured bot token and logs the result. Alerts on expired or revoked tokens.",
      schedule: "0 * * * *",
    },
    {
      jobKey: JOB_KEYS.CHANNEL_SYNC,
      displayName: "Channel List Sync",
      description:
        "Refreshes the cached list of Slack channels using the first configured bot token.",
      schedule: "0 0 * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.SLACK_EVENTS,
      displayName: "Slack Events",
      description:
        "Receives events from the Slack Events API. Route POST /api/plugins/plugin-slack/webhooks/slack-events to this endpoint in your Slack app configuration.",
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Slack Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
      {
        type: "detailTab",
        id: SLOT_IDS.issueTab,
        displayName: "Slack Thread",
        exportName: EXPORT_NAMES.issueTab,
        entityTypes: ["issue"],
      },
      {
        type: "commentAnnotation",
        id: SLOT_IDS.commentAnnotation,
        displayName: "Posted to Slack",
        exportName: EXPORT_NAMES.commentAnnotation,
        entityTypes: ["comment"],
      },
    ],
  },
};

export default manifest;
