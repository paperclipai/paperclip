import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Paperclip Mobile Notification Plugin
 *
 * Delivers real-time push notifications to iOS and Android devices via the
 * Pushover API (https://pushover.net) whenever key Paperclip events occur
 * — issues created, blocked, completed, agent failures, and budget alerts.
 *
 * Configuration (set via the Settings page in the Paperclip board UI):
 *   - pushoverToken:  Your Pushover application API token
 *   - pushoverUser:   Your Pushover user/group key
 *   - notifyOnEvents: Comma-separated list of event types to notify on
 *                     (defaults to all supported types when empty)
 *   - titlePrefix:    Optional prefix prepended to each notification title
 */
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-notifications",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Mobile Push Notifications",
  description:
    "Sends real-time push notifications to your phone via Pushover whenever " +
    "Paperclip issues are created, blocked, completed, or when agents fail " +
    "and budget limits are hit. Works on iOS and Android.",
  author: "Paperclip",
  categories: ["automation", "connector"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
    "ui.settingsPage.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["pushoverToken", "pushoverUser"],
    properties: {
      pushoverToken: {
        type: "string",
        title: "Pushover Application Token",
        description:
          "Your Pushover application API token. Create one at https://pushover.net/apps/build",
        minLength: 1,
      },
      pushoverUser: {
        type: "string",
        title: "Pushover User / Group Key",
        description:
          "Your Pushover user key or group key found at https://pushover.net",
        minLength: 1,
      },
      notifyOnEvents: {
        type: "string",
        title: "Events to notify on",
        description:
          "Comma-separated event types. Leave blank to receive all notifications. " +
          "Supported: issue.created, issue.updated, issue.blocked, issue.done, " +
          "agent.run.failed, budget.incident.opened",
        default: "",
      },
      titlePrefix: {
        type: "string",
        title: "Notification title prefix",
        description:
          "Optional prefix added to every notification title, e.g. '[Paperclip]'",
        default: "[Paperclip]",
      },
    },
    additionalProperties: false,
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "notification-status-widget",
        displayName: "Notification Status",
        exportName: "NotificationStatusWidget",
      },
      {
        type: "settingsPage",
        id: "notification-settings",
        displayName: "Push Notifications",
        exportName: "NotificationSettingsPage",
      },
    ],
  },
};

export default manifest;
