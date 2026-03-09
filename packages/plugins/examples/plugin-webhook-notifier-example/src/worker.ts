import crypto from "node:crypto";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const METRIC_SENT = "webhook_notifications_sent";
const METRIC_FAILED = "webhook_notification_failures";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

interface PluginConfig {
  webhookRef: string;
  signingRef: string;
  allowlist: string[];
}

interface NotificationParams {
  text: (event: any) => string;
  title: string;
}

const TITLES: Record<string, string> = {
  "agent.run.started": "Agent Run Started",
  "agent.run.finished": "Agent Run Finished",
  "agent.run.failed": "Agent Run Failed",
  "agent.run.cancelled": "Agent Run Cancelled",
  "agent.status_changed": "Agent Status Changed",
  "issue.created": "Issue Created",
  "issue.comment.created": "New Comment",
  "approval.created": "Approval Requested",
  "approval.decided": "Approval Decided",
};

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

const plugin = definePlugin({
  async setup(ctx) {
    const getParsedConfig = async (): Promise<PluginConfig> => {
      const config = await ctx.config.get();
      return {
        webhookRef: asString(config.webhookSecretRef),
        signingRef: asString(config.signingSecretRef),
        allowlist: asStringArray(config.eventAllowlist),
      };
    };

    const sendWebhook = async (
      config: PluginConfig,
      payload: Record<string, unknown>
    ): Promise<boolean> => {
      if (!config.webhookRef) {
        ctx.logger.warn("Webhook notifier skipped: webhookSecretRef missing");
        return false;
      }

      try {
        const webhookUrl = await ctx.secrets.resolve(config.webhookRef);
        const body = JSON.stringify(payload);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "User-Agent": "Paperclip-Webhooks/1.0",
        };

        if (config.signingRef) {
          const secret = await ctx.secrets.resolve(config.signingRef);
          headers["X-Paperclip-Signature"] = `sha256=${sign(body, secret)}`;
        }

        const response = await ctx.http.fetch(webhookUrl, {
          method: "POST",
          headers,
          body,
        });

        if (!response.ok) {
          throw new Error(`Webhook endpoint responded with ${response.status}: ${await response.text()}`);
        }

        await ctx.metrics.write(METRIC_SENT, 1);
        return true;
      } catch (error) {
        await ctx.metrics.write(METRIC_FAILED, 1);
        ctx.logger.error("Webhook delivery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    };

    const handleEvent = (
      eventName: string,
      params: NotificationParams,
      afterSend?: (event: any) => Promise<void>
    ) => {
      ctx.events.on(eventName as any, async (event) => {
        const config = await getParsedConfig();

        if (config.allowlist.length > 0 && !config.allowlist.includes(event.eventType)) {
          return;
        }

        const payload = {
          event: event.eventType,
          title: params.title,
          companyId: event.companyId,
          timestamp: event.occurredAt,
          data: {
            entityId: event.entityId,
            message: params.text(event),
          },
        };

        const delivered = await sendWebhook(config, payload);
        if (!delivered) return;

        if (afterSend) {
          await afterSend(event);
        }
      });
    };

    // --- Register Event Handlers ---

    handleEvent("agent.run.started", {
      text: (e) => `Agent run started: ${e.entityId || "unknown"}`,
      title: TITLES["agent.run.started"],
    });

    handleEvent("agent.run.finished", {
      text: (e) => `Agent run finished: ${e.entityId || "unknown"}`,
      title: TITLES["agent.run.finished"],
    }, async (e) => {
      await ctx.activity.log({
        companyId: e.companyId,
        message: `Forwarded agent run completion (${e.entityId}) via webhook`,
        entityType: "run",
        entityId: e.entityId,
      });
    });

    handleEvent("agent.run.failed", {
      text: (e) => `Agent run failed: ${e.entityId || "unknown"}`,
      title: TITLES["agent.run.failed"],
    });

    handleEvent("agent.run.cancelled", {
      text: (e) => `Agent run cancelled: ${e.entityId || "unknown"}`,
      title: TITLES["agent.run.cancelled"],
    });

    handleEvent("agent.status_changed", {
      text: (e) => `Agent ${e.entityId || "unknown"} status changed`,
      title: TITLES["agent.status_changed"],
    });

    handleEvent("issue.created", {
      text: (e) => `New issue created: ${e.entityId || "unknown"}`,
      title: TITLES["issue.created"],
    });

    handleEvent("issue.comment.created", {
      text: (e) => `New comment on issue ${e.entityId || "unknown"}`,
      title: TITLES["issue.comment.created"],
    }, async (e) => {
      await ctx.state.set(
        { scopeKind: "issue", scopeId: e.entityId, stateKey: "last_webhook_event" },
        e.occurredAt
      );
    });

    handleEvent("approval.created", {
      text: () => "Approval requested for an action in Paperclip.",
      title: TITLES["approval.created"],
    });

    handleEvent("approval.decided", {
      text: () => "An approval decision has been recorded.",
      title: TITLES["approval.decided"],
    });
  },

  async onValidateConfig(config) {
    if (!asString(config.webhookSecretRef)) {
      return { ok: false, errors: ["webhookSecretRef is required"] };
    }
    return { ok: true };
  },

  async onHealth() {
    return { status: "ok", message: "Webhook notifier example plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
