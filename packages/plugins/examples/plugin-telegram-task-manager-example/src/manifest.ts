import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "telegram-task-manager",
  apiVersion: 1,
  displayName: "Telegram Task Manager",
  version: "1.5.3",
  description: "Manage Paperclip tasks through Telegram",
  author: "lkosoj",
  categories: ["connector"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  capabilities: [
    "instance.settings.register",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "agents.read",
    "projects.read",
    "agent.tools.register",
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      language: {
        type: "string",
        title: "Language",
        description: "Bot interface language",
        enum: ["ru", "en", "de"],
        default: "ru",
      },
      telegramBotToken: {
        type: "string",
        title: "Telegram Bot Token",
        description: "Bot token from @BotFather",
        minLength: 1,
        format: "password",
      },
      telegramChatId: {
        type: "string",
        title: "Telegram Chat ID",
        description: "Chat ID for notifications. If empty, the first authorized /start chat will be used",
      },
      allowedTelegramUserId: {
        type: "string",
        title: "Allowed Telegram User ID",
        description: "If set, the bot will respond only to this Telegram user ID",
      },
    },
    required: ["telegramBotToken"],
    additionalProperties: false,
  },
  tools: [
    {
      name: "send-telegram-message",
      displayName: "Send Telegram Message",
      description: "Send a message to the Telegram chat linked to the plugin",
      parametersSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Message text",
          },
          chatId: {
            type: "string",
            description: "Chat ID (optional)",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
    },
    {
      name: "create-task-from-telegram",
      displayName: "Create Task from Telegram",
      description: "Create a task in Paperclip and optionally notify Telegram",
      parametersSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Task title",
          },
          description: {
            type: "string",
            description: "Task description",
          },
          agentId: {
            type: "string",
            description: "Agent ID",
          },
          projectId: {
            type: "string",
            description: "Project ID",
          },
          priority: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
            description: "Task priority",
          },
        },
        required: ["title", "agentId"],
        additionalProperties: false,
      },
    },
  ],
};

export default manifest;
