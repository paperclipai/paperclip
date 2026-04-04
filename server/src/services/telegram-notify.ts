/**
 * Telegram notification client.
 *
 * Thin HTTP client that posts messages to the telegram-bot sidecar.
 * All sends are fire-and-forget — a failed Telegram push should never
 * block or crash the main server.
 */

import { logger } from "../middleware/logger.js";

const TELEGRAM_BOT_URL = process.env.TELEGRAM_BOT_URL ?? "http://localhost:8000";
const TELEGRAM_NOTIFY_ENABLED = process.env.TELEGRAM_NOTIFY_ENABLED !== "false";

interface SendPayload {
  text: string;
  chat_id?: number;
  parse_mode?: "HTML" | "MarkdownV2";
}

interface SendResult {
  ok: boolean;
  sent_to: number[];
}

async function send(payload: SendPayload): Promise<SendResult | null> {
  if (!TELEGRAM_NOTIFY_ENABLED) return null;

  try {
    const resp = await fetch(`${TELEGRAM_BOT_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      logger.warn({ status: resp.status, body }, "telegram-notify: send failed");
      return null;
    }

    return (await resp.json()) as SendResult;
  } catch (err) {
    logger.warn({ err }, "telegram-notify: request error (bot may be offline)");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Domain-specific notification helpers
// ---------------------------------------------------------------------------

export const telegramNotify = {
  /** Raw send — escape hatch for custom messages. */
  send,

  /** Notify when an approval is requested (agent hire, strategy, etc.). */
  async approvalRequested(input: {
    companyName: string;
    approvalType: string;
    title: string;
    url?: string;
  }) {
    const link = input.url ? `\n${input.url}` : "";
    await send({
      text: `🔔 Approval requested\n${input.companyName} — ${input.approvalType}\n${input.title}${link}`,
    });
  },

  /** Notify when an issue transitions to a notable status. */
  async issueStatusChanged(input: {
    identifier: string;
    title: string;
    status: string;
    agentName?: string;
    url?: string;
  }) {
    const emoji: Record<string, string> = {
      done: "✅",
      in_review: "👀",
      blocked: "🚫",
      cancelled: "❌",
    };
    const icon = emoji[input.status] ?? "📋";
    const agent = input.agentName ? ` (${input.agentName})` : "";
    const link = input.url ? `\n${input.url}` : "";
    await send({
      text: `${icon} [${input.identifier}] ${input.title}\nStatus → ${input.status}${agent}${link}`,
    });
  },

  /** Notify when an agent's budget is exhausted. */
  async budgetExhausted(input: {
    companyName: string;
    agentName: string;
    budgetUsedPct: number;
  }) {
    await send({
      text: `⚠️ Budget exhausted\n${input.companyName} — ${input.agentName}\nUsed: ${input.budgetUsedPct.toFixed(0)}%`,
    });
  },

  /** Notify on heartbeat run completion (success or failure). */
  async heartbeatCompleted(input: {
    agentName: string;
    routineName?: string;
    success: boolean;
    summary?: string;
  }) {
    const icon = input.success ? "💚" : "💔";
    const routine = input.routineName ? ` (${input.routineName})` : "";
    const summary = input.summary ? `\n${input.summary.slice(0, 200)}` : "";
    await send({
      text: `${icon} Heartbeat${routine} — ${input.agentName}\n${input.success ? "Completed" : "Failed"}${summary}`,
    });
  },

  /** Generic notification for anything else. */
  async info(text: string) {
    await send({ text });
  },
} as const;
