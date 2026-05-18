/**
 * Phase 4A-S4 (LET-392): HTTP transport for `TelegramCapNotifier`.
 *
 * Gated on `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OPERATOR_CHAT_ID`. When either env
 * var is missing the factory returns `null`, and the caller wires a
 * `NoopCapNotifier` instead so default deployments incur no external side
 * effects.
 *
 * The transport never logs or echoes the bot token; only HTTP status + the
 * Telegram API's own error body propagate on failure.
 */

import type { Logger } from "pino";
import type { TelegramTransport } from "./notifier.js";

export interface TelegramFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

export interface TelegramFetcher {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<TelegramFetchResponse>;
}

export interface CreateTelegramHttpTransportOptions {
  botToken?: string | null;
  chatId?: string | null;
  /** Defaults to global `fetch`. */
  fetcher?: TelegramFetcher;
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

export function createTelegramHttpTransport(
  opts: CreateTelegramHttpTransportOptions,
): TelegramTransport | null {
  const botToken = opts.botToken?.trim();
  const chatId = opts.chatId?.trim();
  if (!botToken || !chatId) return null;
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as TelegramFetcher | undefined);
  if (typeof fetcher !== "function") {
    opts.logger?.warn(
      "TelegramCapNotifier wiring requested but global fetch is unavailable; returning no-op",
    );
    return null;
  }
  return {
    async sendPage(message: string): Promise<void> {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const res = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Telegram sendMessage failed (${res.status} ${res.statusText}): ${body.slice(0, 256)}`,
        );
      }
    },
  };
}
