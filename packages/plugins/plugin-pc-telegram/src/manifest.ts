import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  COMPANY_SETTINGS_EXPORT,
  COMPANY_SETTINGS_ROUTE,
  COMPANY_SETTINGS_SLOT_ID,
  INBOX_NAV_EXPORT,
  INBOX_NAV_SLOT_ID,
  INBOX_PAGE_EXPORT,
  INBOX_PAGE_ROUTE,
  INBOX_PAGE_SLOT_ID,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_ID,
  PLUGIN_VERSION,
  TOOL_SEND_TEXT,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: PLUGIN_DISPLAY_NAME,
  description: "Connect personal Telegram accounts with QR login, turn inbound DMs into issues, and let the assigned agent reply in the same chat.",
  author: "Paperclip",
  categories: ["connector", "automation", "ui"],
  capabilities: [
    "companies.read",
    "agents.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.read",
    "issue.comments.create",
    "issue.attachments.write",
    "events.subscribe",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "secrets.write",
    "agent.tools.register",
    "instance.settings.register",
    "ui.sidebar.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["apiId", "apiHash"],
    properties: {
      apiId: {
        type: "string",
        format: "secret-ref",
        title: "Telegram api_id",
        description: "Telegram application api_id. Paste a value or pick a Paperclip secret. Saved values become company secrets and are never written into issues or prompts.",
      },
      apiHash: {
        type: "string",
        format: "secret-ref",
        title: "Telegram api_hash",
        description: "Telegram application api_hash paired with api_id.",
      },
    },
  },
  tools: [
    {
      name: TOOL_SEND_TEXT,
      displayName: "Send Telegram text",
      description: "Send a text message back to the Telegram chat bound to the current issue. Only the answering agent assigned on that Telegram connection can use this tool.",
      parametersSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Message text to send." },
          accountId: { type: "string", description: "Telegram user id of the connected account. Inferred from the issue when omitted." },
          peerId: { type: "string", description: "Telegram user id of the chat peer. Inferred from the issue when omitted." },
          issueId: { type: "string", description: "Issue that owns this Telegram dialog." },
        },
        required: ["text", "issueId"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: INBOX_PAGE_SLOT_ID,
        displayName: "Telegram",
        exportName: INBOX_PAGE_EXPORT,
        routePath: INBOX_PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: INBOX_NAV_SLOT_ID,
        displayName: "Telegram",
        exportName: INBOX_NAV_EXPORT,
      },
      {
        type: "companySettingsPage",
        id: COMPANY_SETTINGS_SLOT_ID,
        displayName: "Telegram",
        exportName: COMPANY_SETTINGS_EXPORT,
        routePath: COMPANY_SETTINGS_ROUTE,
      },
    ],
  },
};

export default manifest;
