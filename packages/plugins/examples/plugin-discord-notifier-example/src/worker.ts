import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const METRIC_SENT = "discord_notifications_sent";
const METRIC_FAILED = "discord_notification_failures";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

interface PluginConfig {
  webhookRef: string;
  username: string;
  avatarUrl: string;
  allowlist: string[];
}

interface EmbedParams {
  title: string;
  color: number;
  text: (event: any) => string;
  fields?: (event: any) => Array<{ name: string; value: string; inline: boolean }>;
}

// Discord embed color codes
const COLORS = {
  GREEN: 0x2ecc71,
  RED: 0xe74c3c,
  GRAY: 0x95a5a6,
  BLUE: 0x3498db,
  YELLOW: 0xf1c40f,
};

const plugin = definePlugin({
  async setup(ctx) {
    const getParsedConfig = async (): Promise<PluginConfig> => {
      const config = await ctx.config.get();
      return {
        webhookRef: asString(config.webhookSecretRef),
        username: asString(config.username) || "Paperclip",
        avatarUrl: asString(config.avatarUrl),
        allowlist: asStringArray(config.eventAllowlist),
      };
    };

    const sendDiscordEmbed = async (
      config: PluginConfig,
      embed: Record<string, unknown>
    ): Promise<boolean> => {
      if (!config.webhookRef) {
        ctx.logger.warn("Discord notifier skipped: webhookSecretRef missing");
        return false;
      }

      try {
        const webhookUrl = await ctx.secrets.resolve(config.webhookRef);

        const body: Record<string, unknown> = { embeds: [embed] };
        if (config.username) body.username = config.username;
        if (config.avatarUrl) body.avatar_url = config.avatarUrl;

        const response = await ctx.http.fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          throw new Error(`Discord webhook responded with ${response.status}: ${await response.text()}`);
        }

        await ctx.metrics.write(METRIC_SENT, 1);
        return true;
      } catch (error) {
        await ctx.metrics.write(METRIC_FAILED, 1);
        ctx.logger.error("Discord notification delivery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    };

    const handleEvent = (
      eventName: string,
      params: EmbedParams,
      afterSend?: (event: any) => Promise<void>
    ) => {
      ctx.events.on(eventName as any, async (event) => {
        const config = await getParsedConfig();

        if (config.allowlist.length > 0 && !config.allowlist.includes(event.eventType)) {
          return;
        }

        const fields = params.fields
          ? params.fields(event)
          : [{ name: "Entity", value: event.entityId || "unknown", inline: true }];

        const embed = {
          title: params.title,
          description: params.text(event),
          color: params.color,
          fields,
          timestamp: event.occurredAt,
          footer: { text: "Paperclip" },
        };

        const delivered = await sendDiscordEmbed(config, embed);
        if (!delivered) return;

        if (afterSend) {
          await afterSend(event);
        }
      });
    };

    // --- Register Event Handlers ---

    handleEvent("agent.run.started", {
      title: "Agent Run Started",
      color: COLORS.BLUE,
      text: (e) => `Agent run \`${e.entityId || "unknown"}\` has started.`,
    });

    handleEvent("agent.run.finished", {
      title: "Agent Run Finished",
      color: COLORS.GREEN,
      text: (e) => `Agent run \`${e.entityId || "unknown"}\` completed successfully.`,
    }, async (e) => {
      await ctx.activity.log({
        companyId: e.companyId,
        message: `Forwarded agent run completion (${e.entityId}) to Discord`,
        entityType: "run",
        entityId: e.entityId,
      });
    });

    handleEvent("agent.run.failed", {
      title: "Agent Run Failed",
      color: COLORS.RED,
      text: (e) => `Agent run \`${e.entityId || "unknown"}\` has failed.`,
    });

    handleEvent("agent.run.cancelled", {
      title: "Agent Run Cancelled",
      color: COLORS.GRAY,
      text: (e) => `Agent run \`${e.entityId || "unknown"}\` was cancelled.`,
    });

    handleEvent("agent.status_changed", {
      title: "Agent Status Changed",
      color: COLORS.BLUE,
      text: (e) => `Agent \`${e.entityId || "unknown"}\` status has changed.`,
    });

    handleEvent("issue.created", {
      title: "Issue Created",
      color: COLORS.BLUE,
      text: (e) => `A new issue has been created: \`${e.entityId || "unknown"}\`.`,
    });

    handleEvent("issue.comment.created", {
      title: "New Comment",
      color: COLORS.BLUE,
      text: (e) => `New comment on issue \`${e.entityId || "unknown"}\`.`,
    }, async (e) => {
      await ctx.state.set(
        { scopeKind: "issue", scopeId: e.entityId, stateKey: "last_discord_event" },
        e.occurredAt
      );
    });

    handleEvent("approval.created", {
      title: "Approval Requested",
      color: COLORS.YELLOW,
      text: () => "An action in Paperclip requires approval.",
    });

    handleEvent("approval.decided", {
      title: "Approval Decided",
      color: COLORS.YELLOW,
      text: () => "An approval decision has been recorded.",
    });
  },

  async onValidateConfig(config) {
    if (!asString(config.webhookSecretRef)) {
      return { ok: false, errors: ["webhookSecretRef is required"] };
    }
    return { ok: true };
  },

  async onHealth() {
    return { status: "ok", message: "Discord notifier example plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
