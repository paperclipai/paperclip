import { and, eq } from "drizzle-orm";
import { companySecrets, companySecretVersions, type Db } from "@paperclipai/db";
import { getSecretProvider } from "../secrets/provider-registry.js";
import type { SecretProvider } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

const TELEGRAM_SECRET_NAME = "TELEGRAM_CHAT_ID";
const TELEGRAM_API_BASE = "https://api.telegram.org";

// Module-level singleton — initialized once at server startup via initNotifications(db).
let _instance: ReturnType<typeof createNotificationService> | null = null;

export function initNotifications(db: Db): void {
  _instance = createNotificationService(db);
}

export function getNotifications(): ReturnType<typeof createNotificationService> | null {
  return _instance;
}

function createNotificationService(db: Db) {
  const botToken = process.env.PAPERCLIP_TELEGRAM_BOT_TOKEN?.trim() ?? "";

  async function resolveChatId(companyId: string): Promise<string | null> {
    if (!botToken) return null;
    const secret = await db
      .select()
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.name, TELEGRAM_SECRET_NAME)))
      .then((rows) => rows[0] ?? null);
    if (!secret) return null;

    const version = await db
      .select()
      .from(companySecretVersions)
      .where(
        and(
          eq(companySecretVersions.secretId, secret.id),
          eq(companySecretVersions.version, secret.latestVersion),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!version) return null;

    try {
      const provider = getSecretProvider(secret.provider as SecretProvider);
      const value = await provider.resolveVersion({
        material: version.material as Record<string, unknown>,
        externalRef: secret.externalRef,
      });
      return value.trim() || null;
    } catch (err) {
      logger.warn({ err, companyId }, "Failed to resolve TELEGRAM_CHAT_ID secret");
      return null;
    }
  }

  async function send(chatId: string, text: string): Promise<void> {
    if (!botToken) return;
    try {
      const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logger.warn({ chatId, status: res.status, body }, "Telegram send failed");
      }
    } catch (err) {
      logger.warn({ err, chatId }, "Telegram send error");
    }
  }

  return {
    async notifyApprovalCreated(
      companyId: string,
      opts: {
        approvalId: string;
        type: string;
        title: string;
        requestedByAgentName?: string | null;
      },
    ): Promise<void> {
      const chatId = await resolveChatId(companyId);
      if (!chatId) return;
      const byLine = opts.requestedByAgentName
        ? `\nRequested by: <b>${opts.requestedByAgentName}</b>`
        : "";
      const text =
        `📋 <b>New Approval Required</b>\n\n` +
        `<b>${opts.title}</b>${byLine}\n` +
        `Type: <code>${opts.type}</code>\n` +
        `ID: <code>${opts.approvalId.slice(0, 8)}</code>\n\n` +
        `→ Open Paperclip to review`;
      await send(chatId, text);
    },

    async notifyBudgetExhausted(
      companyId: string,
      opts: { agentId: string; agentName: string },
    ): Promise<void> {
      const chatId = await resolveChatId(companyId);
      if (!chatId) return;
      const text =
        `🛑 <b>Agent Budget Exhausted</b>\n\n` +
        `<b>${opts.agentName}</b> has hit its monthly budget and been paused.\n` +
        `ID: <code>${opts.agentId.slice(0, 8)}</code>`;
      await send(chatId, text);
    },

    async notifyStuckRun(
      companyId: string,
      opts: {
        runId: string;
        agentId: string;
        agentName: string;
        staleForMs: number;
        reason: "queued_stale" | "running_no_progress";
        issueId?: string | null;
      },
    ): Promise<void> {
      const chatId = await resolveChatId(companyId);
      if (!chatId) return;
      const staleMinutes = Math.max(1, Math.round(opts.staleForMs / 60_000));
      const state =
        opts.reason === "queued_stale" ? "queued without starting" : "running without progress";
      const text =
        `⚠️ <b>Stuck Agent Run</b>\n\n` +
        `<b>${opts.agentName}</b> has been ${state} for <b>${staleMinutes}m</b>.\n` +
        `Run: <code>${opts.runId.slice(0, 8)}</code>` +
        (opts.issueId ? `\nIssue: <code>${opts.issueId.slice(0, 8)}</code>` : "");
      await send(chatId, text);
    },
  };
}
