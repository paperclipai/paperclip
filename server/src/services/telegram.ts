import type { LiveEvent } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { subscribeAllLiveEvents } from "./live-events.js";

const TELEGRAM_API = "https://api.telegram.org";

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

function getConfig(): TelegramConfig | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

async function sendMessage(config: TelegramConfig, text: string): Promise<void> {
  const url = `${TELEGRAM_API}/bot${config.botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body }, "Telegram sendMessage failed");
    }
  } catch (err) {
    logger.warn({ err }, "Telegram sendMessage request error");
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

type ActivityPayload = {
  action?: string;
  actorType?: string;
  actorId?: string;
  agentId?: string | null;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown> | null;
};

function handleActivityLogged(event: LiveEvent, config: TelegramConfig): void {
  const p = event.payload as unknown as ActivityPayload;
  const action = p.action;
  if (!action) return;

  const details = p.details ?? {};
  const identifier = (details.identifier as string) ?? p.entityId ?? "";

  if (action === "issue.comment_added") {
    const bodySnippet = (details.bodySnippet as string) ?? "";
    const issueTitle = (details.issueTitle as string) ?? "";
    const hasMention = /\B@[^\s@,!?.]+/.test(bodySnippet);
    // Always notify on comments — they indicate activity worth seeing.
    const mentionTag = hasMention ? " (has @mention)" : "";
    const actorLabel = p.agentId ?? p.actorId ?? "someone";
    const lines = [
      `\u{1F4AC} <b>Comment on ${escapeHtml(identifier)}</b>${mentionTag}`,
      escapeHtml(truncate(bodySnippet, 200)),
    ];
    if (issueTitle) lines.push(`<i>${escapeHtml(truncate(issueTitle, 100))}</i>`);
    lines.push(`by ${escapeHtml(actorLabel)}`);
    void sendMessage(config, lines.join("\n"));
    return;
  }

  if (action === "issue.updated") {
    const newStatus = details.status as string | undefined;
    if (newStatus === "blocked" || newStatus === "in_review") {
      const issueTitle = (details.issueTitle as string) ?? (details.title as string) ?? "";
      const lines = [
        `\u{1F514} <b>${escapeHtml(identifier)} is now ${escapeHtml(newStatus)}</b>`,
      ];
      if (issueTitle) lines.push(`<i>${escapeHtml(truncate(issueTitle, 100))}</i>`);
      void sendMessage(config, lines.join("\n"));
    }
    return;
  }

  if (action === "approval.created") {
    const approvalType = (details.type as string) ?? "unknown";
    const lines = [
      `\u{2705} <b>Approval requested</b>`,
      `Type: ${escapeHtml(approvalType)}`,
      `Entity: ${escapeHtml(p.entityId ?? "")}`,
    ];
    if (p.agentId) lines.push(`Requested by agent: ${escapeHtml(p.agentId)}`);
    void sendMessage(config, lines.join("\n"));
    return;
  }

  if (action === "approval.comment_added") {
    const lines = [
      `\u{1F4AC} <b>Comment on approval ${escapeHtml(p.entityId ?? "")}</b>`,
    ];
    if (p.agentId) lines.push(`by agent: ${escapeHtml(p.agentId)}`);
    void sendMessage(config, lines.join("\n"));
    return;
  }
}

function handleHeartbeatRunStatus(event: LiveEvent, config: TelegramConfig): void {
  const p = event.payload as Record<string, unknown>;
  const status = p.status as string | undefined;
  if (status !== "failed") return;

  const agentId = (p.agentId as string) ?? "unknown";
  const runId = (p.runId as string) ?? "";
  const error = (p.error as string) ?? "";
  const errorCode = (p.errorCode as string) ?? "";

  const lines = [
    `\u{274C} <b>Run failed</b>`,
    `Agent: ${escapeHtml(agentId)}`,
    `Run: ${escapeHtml(runId.slice(0, 8))}`,
  ];
  if (errorCode) lines.push(`Code: ${escapeHtml(errorCode)}`);
  if (error) lines.push(`Error: ${escapeHtml(truncate(error, 200))}`);
  void sendMessage(config, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initTelegramNotifications(): boolean {
  const config = getConfig();
  if (!config) {
    logger.info("Telegram notifications disabled (TELEGRAM_BOT_TOKEN not set)");
    return false;
  }

  subscribeAllLiveEvents((event: LiveEvent) => {
    try {
      switch (event.type) {
        case "activity.logged":
          handleActivityLogged(event, config);
          break;
        case "heartbeat.run.status":
          handleHeartbeatRunStatus(event, config);
          break;
        // Other event types (heartbeat.run.queued, heartbeat.run.event,
        // heartbeat.run.log, agent.status) are high-frequency or low-value
        // for Telegram — skip them.
        default:
          break;
      }
    } catch (err) {
      logger.warn({ err, eventType: event.type }, "Telegram event handler error");
    }
  });

  logger.info("Telegram notifications enabled");
  void sendMessage(config, "\u{1F7E2} Paperclip server started — Telegram notifications active");
  return true;
}
