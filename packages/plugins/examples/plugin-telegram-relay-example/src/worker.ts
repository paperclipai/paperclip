import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

interface TelegramConfig {
  telegramBotToken: string;
  telegramChatId: string;
  relayIssueId: string;
  agentMention?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { first_name?: string; last_name?: string; username?: string };
    chat?: { id: number };
    date: number;
    text?: string;
  };
}

const CURSOR_KEY = "telegram-update-cursor";

/**
 * Build a Paperclip comment body from a Telegram message.
 * Optionally prepends an @AgentName mention to trigger a heartbeat.
 */
function formatComment(
  sender: string,
  text: string,
  agentMention?: string,
): string {
  const mention = agentMention ? `${agentMention} ` : "";
  return `${mention}**Telegram from ${sender}:**\n\n${text}`;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Telegram Relay plugin starting");

    ctx.jobs.register("poll-telegram", async (job) => {
      ctx.logger.info("Polling Telegram for new messages", {
        runId: job.runId,
        trigger: job.trigger,
      });

      const config = (await ctx.config.get()) as TelegramConfig;

      if (
        !config.telegramBotToken ||
        !config.telegramChatId ||
        !config.relayIssueId
      ) {
        ctx.logger.error("Missing required config", {
          hasToken: !!config.telegramBotToken,
          hasChatId: !!config.telegramChatId,
          hasRelayIssue: !!config.relayIssueId,
        });
        return;
      }

      // Read cursor from plugin state
      const cursorState = await ctx.state.get({
        scopeKind: "instance",
        stateKey: CURSOR_KEY,
      });
      const cursor = cursorState ? Number(cursorState) : 0;

      // Poll Telegram getUpdates.
      // timeout=5 keeps the cron job short — relay.mjs uses timeout=30 for
      // true long-polling since it runs continuously.
      const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=${cursor}&timeout=5`;

      let updates: TelegramUpdate[];
      try {
        const resp = await ctx.http.fetch(url);
        const data = (await resp.json()) as {
          ok: boolean;
          result: TelegramUpdate[];
        };
        if (!data.ok) {
          ctx.logger.error("Telegram API error", { data });
          return;
        }
        updates = data.result;
      } catch (err) {
        ctx.logger.error("Failed to poll Telegram", {
          error: String(err),
        });
        return;
      }

      if (!updates || updates.length === 0) {
        ctx.logger.info("No new Telegram messages");
        return;
      }

      // Process updates in order. Only advance the cursor past messages
      // that were successfully posted — if a comment fails, stop so the
      // next cron run retries from the first failure.
      let lastSuccessId = cursor;

      for (const update of updates) {
        const msg = update.message;
        if (!msg?.text) {
          // Non-text updates (joins, edits, etc.) — skip but advance cursor
          lastSuccessId = update.update_id;
          continue;
        }

        // Only relay messages from the configured chat
        if (String(msg.chat?.id) !== config.telegramChatId) {
          lastSuccessId = update.update_id;
          continue;
        }

        const sender = msg.from
          ? [msg.from.first_name, msg.from.last_name]
              .filter(Boolean)
              .join(" ")
          : "Unknown";

        const commentBody = formatComment(
          sender,
          msg.text,
          config.agentMention,
        );

        try {
          await ctx.issues.createComment(config.relayIssueId, {
            body: commentBody,
          });
          ctx.logger.info("Posted Telegram message as comment", {
            messageId: msg.message_id,
            sender,
            relayIssueId: config.relayIssueId,
          });
          lastSuccessId = update.update_id;
        } catch (err) {
          ctx.logger.error("Failed to create comment — stopping batch so next run retries", {
            error: String(err),
            messageId: msg.message_id,
          });
          break;
        }
      }

      // Save cursor past the last successfully handled update
      if (lastSuccessId >= cursor) {
        await ctx.state.set(
          { scopeKind: "instance", stateKey: CURSOR_KEY },
          String(lastSuccessId + 1),
        );
      }

      ctx.logger.info("Telegram poll complete", {
        processedUpdates: updates.length,
        newCursor: lastSuccessId + 1,
      });
    });

    ctx.data.register("health", async () => ({
      status: "ok",
      description: "Telegram Relay is running",
    }));
  },

  async onHealth() {
    return { status: "ok", message: "Telegram Relay healthy" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
