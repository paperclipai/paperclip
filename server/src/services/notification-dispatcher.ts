import { loadConfig } from "../config.js";
import { logger } from "../middleware/logger.js";

interface NotificationPayload {
  title: string;
  body: string;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  agentName?: string | null;
  url?: string;
}

async function postDiscord(webhookUrl: string, payload: NotificationPayload) {
  const embed = {
    title: payload.title,
    description: payload.body,
    color: 0xff6b6b, // red-ish for attention
    fields: [
      ...(payload.issueIdentifier
        ? [{ name: "Issue", value: payload.issueIdentifier, inline: true }]
        : []),
      ...(payload.agentName
        ? [{ name: "Agent", value: payload.agentName, inline: true }]
        : []),
    ],
    timestamp: new Date().toISOString(),
  };

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
}

async function postTelegram(botToken: string, chatId: string, payload: NotificationPayload) {
  const text = [
    `*${payload.title}*`,
    payload.body,
    payload.issueIdentifier ? `Issue: \`${payload.issueIdentifier}\`` : null,
    payload.agentName ? `Agent: ${payload.agentName}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

export async function dispatchNotification(payload: NotificationPayload): Promise<void> {
  const config = loadConfig();
  const promises: Promise<void>[] = [];

  if (config.notificationDiscordWebhookUrl) {
    promises.push(
      postDiscord(config.notificationDiscordWebhookUrl, payload).catch((err) =>
        logger.warn({ err }, "failed to send Discord notification"),
      ),
    );
  }

  if (config.notificationTelegramBotToken && config.notificationTelegramChatId) {
    promises.push(
      postTelegram(config.notificationTelegramBotToken, config.notificationTelegramChatId, payload).catch(
        (err) => logger.warn({ err }, "failed to send Telegram notification"),
      ),
    );
  }

  await Promise.allSettled(promises);
}
