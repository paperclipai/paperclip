import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "telegram",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Telegram Bot",
  description:
    "Telegram-интеграция для ARTI Holding: текст и голос → агенты, команды переключения, push-уведомления.",
  author: "ARTI Holding",
  categories: ["connector", "automation"],
  capabilities: [
    "agents.read",
    "issues.read",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    "events.subscribe",
    "webhooks.receive",
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      botToken: {
        type: "string",
        title: "Telegram Bot Token",
        description: "Токен от @BotFather (например: 123456789:ABC-DEF...)",
      },
      personalChatId: {
        type: "string",
        title: "Personal Chat ID",
        description:
          "Ваш Telegram chat_id — сообщения по умолчанию идут в Personal Assistant. Узнать: напишите @userinfobot.",
      },
      companyId: {
        type: "string",
        title: "Company ID",
        description: "ARTI Holding company ID",
        default: "752d12a0-c30a-45c0-ad18-a285ae5acf7a",
      },
      personalAssistantAgentId: {
        type: "string",
        title: "Personal Assistant Agent ID",
        default: "6fbe7253-4746-4b0b-b371-3218e9c03ea6",
      },
      ceoAgentId: {
        type: "string",
        title: "Holding CEO Agent ID",
        default: "76cf0ea1-d736-4245-8959-388faa5513ad",
      },
      groqApiKey: {
        type: "string",
        title: "Groq API Key (бесплатно)",
        description: "Для транскрипции голосовых сообщений через Whisper-large-v3. Бесплатно на console.groq.com.",
      },
      notifyChatId: {
        type: "string",
        title: "Notification Chat ID",
        description:
          "Куда отправлять push-уведомления от агентов (ваш personal chat_id или группа). Оставьте пустым для отключения.",
      },
      enableNotifications: {
        type: "boolean",
        title: "Включить push-уведомления",
        description: "Пушить комментарии агентов в Telegram",
        default: true,
      },
    },
    required: [
      "botToken",
      "personalChatId",
      "companyId",
      "personalAssistantAgentId",
      "ceoAgentId",
    ],
  },
  webhooks: [
    {
      endpointKey: "telegram-update",
      displayName: "Telegram Updates",
      description: "Принимает webhook-апдейты от Telegram Bot API",
    },
  ],
};

export default manifest;
