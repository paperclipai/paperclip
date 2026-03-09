import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const METRIC_SENT = "telegram_notifications_sent";
const METRIC_FAILED = "telegram_notification_failures";

// --- Utilities ---

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// --- Config ---

interface PluginConfig {
  botTokenRef: string;
  chatId: string;
  parseMode: "MarkdownV2" | "HTML" | "plain";
  allowlist: string[];
}

// --- Formatting ---

const MARKDOWNV2_ESCAPE_RE = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWNV2_ESCAPE_RE, "\\$1");
}

const EVENT_LABELS: Record<string, string> = {
  "agent.run.started": "Agent Run Started",
  "agent.run.finished": "Agent Run Finished",
  "agent.run.failed": "Agent Run Failed",
  "agent.run.cancelled": "Agent Run Cancelled",
  "agent.status_changed": "Agent Status Changed",
  "approval.created": "Approval Requested",
  "approval.decided": "Approval Decided",
  "issue.created": "Issue Created",
  "issue.updated": "Issue Updated",
  "issue.comment.created": "New Comment",
  "cost_event.created": "Cost Event",
};

const EVENT_EMOJI: Record<string, string> = {
  "agent.run.started": "\u25B6\uFE0F",
  "agent.run.finished": "\u2705",
  "agent.run.failed": "\u274C",
  "agent.run.cancelled": "\u23F9\uFE0F",
  "agent.status_changed": "\uD83D\uDD04",
  "approval.created": "\u23F3",
  "approval.decided": "\u270B",
  "issue.created": "\uD83D\uDCCB",
  "issue.updated": "\uD83D\uDCDD",
  "issue.comment.created": "\uD83D\uDCAC",
  "cost_event.created": "\uD83D\uDCB0",
};

interface EventLike {
  eventType: string;
  entityId?: string;
  companyId: string;
  occurredAt?: string;
}

function formatMarkdownV2(event: EventLike): string {
  const emoji = EVENT_EMOJI[event.eventType] ?? "\uD83D\uDD14";
  const title = EVENT_LABELS[event.eventType] ?? event.eventType;
  const entity = event.entityId ?? "unknown";

  return [
    `${emoji} *${escapeMarkdownV2(title)}*`,
    "",
    `*Entity:* ${escapeMarkdownV2(entity)}`,
  ].join("\n");
}

function escapeHTML(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatHTML(event: EventLike): string {
  const emoji = EVENT_EMOJI[event.eventType] ?? "\uD83D\uDD14";
  const title = EVENT_LABELS[event.eventType] ?? event.eventType;
  const entity = event.entityId ?? "unknown";

  return [
    `${emoji} <b>${escapeHTML(title)}</b>`,
    "",
    `<b>Entity:</b> ${escapeHTML(entity)}`,
  ].join("\n");
}

function formatPlainText(event: EventLike): string {
  const title = EVENT_LABELS[event.eventType] ?? event.eventType;
  const entity = event.entityId ?? "unknown";
  return `${title}\nEntity: ${entity}`;
}

// --- Plugin ---

const plugin = definePlugin({
  async setup(ctx) {
    const getParsedConfig = async (): Promise<PluginConfig> => {
      const config = await ctx.config.get();
      return {
        botTokenRef: asString(config.botTokenRef),
        chatId: asString(config.chatId),
        parseMode:
          (config.parseMode as PluginConfig["parseMode"]) || "MarkdownV2",
        allowlist: asStringArray(config.eventAllowlist),
      };
    };

    const sendTelegram = async (
      botToken: string,
      chatId: string,
      text: string,
      parseMode?: string,
    ): Promise<boolean> => {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (parseMode && parseMode !== "plain") {
        body.parse_mode = parseMode;
      }

      const response = await ctx.http.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      return response.ok;
    };

    const sendNotification = async (
      config: PluginConfig,
      event: EventLike,
    ): Promise<boolean> => {
      if (!config.botTokenRef || !config.chatId) {
        ctx.logger.warn(
          "telegram notifier skipped: missing botTokenRef or chatId",
        );
        return false;
      }

      try {
        const botToken = await ctx.secrets.resolve(config.botTokenRef);

        // Format and send with preferred parse mode
        let text: string;
        let mode: string | undefined;

        if (config.parseMode === "MarkdownV2") {
          text = formatMarkdownV2(event);
          mode = "MarkdownV2";
        } else if (config.parseMode === "HTML") {
          text = formatHTML(event);
          mode = "HTML";
        } else {
          text = formatPlainText(event);
        }

        let sent = await sendTelegram(botToken, config.chatId, text, mode);

        // Fall back to plain text if formatted mode was rejected
        if (!sent && mode) {
          sent = await sendTelegram(
            botToken,
            config.chatId,
            formatPlainText(event),
          );
        }

        if (!sent) {
          throw new Error("Telegram API rejected the message");
        }

        await ctx.metrics.write(METRIC_SENT, 1);
        return true;
      } catch (error) {
        await ctx.metrics.write(METRIC_FAILED, 1);
        ctx.logger.error("telegram notifier delivery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    };

    const handleEvent = (
      eventName: string,
      afterSend?: (event: EventLike, config: PluginConfig) => Promise<void>,
    ) => {
      ctx.events.on(eventName as any, async (event) => {
        const config = await getParsedConfig();

        if (
          config.allowlist.length > 0 &&
          !config.allowlist.includes(event.eventType)
        ) {
          return;
        }

        const delivered = await sendNotification(config, event);
        if (delivered && afterSend) {
          await afterSend(event, config);
        }
      });
    };

    // --- Register Event Handlers ---

    handleEvent("agent.run.started");

    handleEvent("agent.run.finished", async (e) => {
      await ctx.activity.log({
        companyId: e.companyId,
        message: `Forwarded agent run completion (${e.entityId}) to Telegram`,
        entityType: "run",
        entityId: e.entityId,
      });
    });

    handleEvent("agent.run.failed");
    handleEvent("agent.run.cancelled");
    handleEvent("agent.status_changed");
    handleEvent("issue.created");
    handleEvent("issue.updated");

    handleEvent("issue.comment.created", async (e) => {
      if (!e.entityId) return;
      await ctx.state.set(
        {
          scopeKind: "issue",
          scopeId: e.entityId,
          stateKey: "last_telegram_notified_at",
        },
        e.occurredAt ?? new Date().toISOString(),
      );
    });

    handleEvent("approval.created");
    handleEvent("approval.decided");
    handleEvent("cost_event.created");
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    if (!asString(config.botTokenRef)) errors.push("botTokenRef is required");
    if (!asString(config.chatId)) errors.push("chatId is required");
    const mode = asString(config.parseMode);
    if (mode && !["MarkdownV2", "HTML", "plain"].includes(mode)) {
      errors.push("parseMode must be MarkdownV2, HTML, or plain");
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },

  async onHealth() {
    return { status: "ok", message: "Telegram notifier plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
