import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { JOB_KEYS, PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMES } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Telegram Notifier",
  description:
    "Pushes Paperclip approvals, issue assignments, comments, and agent failures to a Telegram chat with action buttons. Pair once via a Telegram deep-link — no manual chat ID lookup required.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "events.subscribe",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    "agents.read",
    "companies.read",
    "agent.tools.register",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "telegram-notifier-settings",
        displayName: "Telegram Notifier",
        exportName: "TelegramNotifierSettings",
      },
    ],
  },
  instanceConfigSchema: {
    type: "object",
    required: ["botToken"],
    properties: {
      botToken: {
        type: "string",
        format: "secret-ref",
        title: "Telegram bot token",
        description:
          "Bot API token from @BotFather. Either the literal token (e.g. `1234567890:AAAA…`) or the name of a Paperclip secret that holds it. The plugin treats real-looking tokens as literals automatically. After saving, the value is masked — click the eye icon to reveal.",
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip dashboard base URL",
        description:
          "Used to build deep links into the dashboard from notifications, e.g. `http://localhost:3100`.",
        default: "http://localhost:3100",
      },
      notifyOn: {
        type: "object",
        title: "Notification triggers",
        description: "Toggle each event class on or off. All default on.",
        properties: {
          approvals: { type: "boolean", default: true },
          assignedToYou: { type: "boolean", default: true },
          comments: { type: "boolean", default: true },
          runFailures: { type: "boolean", default: true },
          budgetIncidents: { type: "boolean", default: true },
          wakeRequests: { type: "boolean", default: true },
        },
      },
      morningDigest: {
        type: "object",
        title: "Morning digest",
        description:
          "Send a daily summary of what was completed yesterday and what is in progress / todo today. Requires Default company and Operate-as user.",
        properties: {
          enabled: { type: "boolean", title: "Enabled", default: false },
          hour: {
            type: "integer",
            title: "Hour of day (0–23, server local time)",
            minimum: 0,
            maximum: 23,
            default: 8,
          },
          weekdaysOnly: {
            type: "boolean",
            title: "Weekdays only (Mon–Fri)",
            default: true,
          },
        },
      },
      silent: {
        type: "boolean",
        title: "Silent push (no sound)",
        default: false,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.pollUpdates,
      displayName: "Poll Telegram updates",
      description:
        "Fetches messages and callback queries from the Telegram Bot API. Handles pairing, slash commands, and inline-button presses.",
      schedule: "* * * * *",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.getStatus,
      displayName: "Telegram pairing status",
      description:
        "Returns whether a chat is paired, or the current handshake stage if pairing is in progress.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: TOOL_NAMES.startPairing,
      displayName: "Start Telegram pairing",
      description:
        "Begins a fresh pairing handshake. After running this, send any message to the bot in Telegram — the bot will reply with a verification code that you paste into the Confirm pairing form.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: TOOL_NAMES.confirmPairing,
      displayName: "Confirm Telegram pairing",
      description:
        "Completes pairing by validating the code the bot sent in Telegram. Requires the operator to control both Telegram and Paperclip.",
      parametersSchema: {
        type: "object",
        required: ["code"],
        properties: {
          code: {
            type: "string",
            title: "Verification code",
            description:
              "6-character code the bot sent in Telegram after you started pairing.",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.unpair,
      displayName: "Unpair Telegram chat",
      description:
        "Disconnects the currently paired chat. Notifications stop until pairing is run again.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: TOOL_NAMES.sendTest,
      displayName: "Send Telegram test notification",
      description:
        "Sends a sample notification to the paired chat to verify the integration end-to-end.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: TOOL_NAMES.getApprovalConfig,
      displayName: "Get plan-approval config",
      description:
        "Returns the configured approver and whether the calling agent must gate plans before acting. Pass `agentId` for caller-specific resolution.",
      parametersSchema: {
        type: "object",
        required: ["companyId"],
        properties: {
          companyId: { type: "string" },
          agentId: { type: "string" },
        },
      },
    },
  ],
};

export default manifest;
