import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const METRIC_SENT = "slack_notifications_sent";
const METRIC_FAILED = "slack_notification_failures";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const plugin = definePlugin({
  async setup(ctx) {
    const readConfig = async () => {
      const config = await ctx.config.get();
      return {
        webhookRef: asString(config.webhookSecretRef),
        channel: asString(config.channel),
        allowlist: asStringArray(config.eventAllowlist),
      };
    };

    const sendSlackMessage = async (text: string): Promise<boolean> => {
      const { webhookRef, channel } = await readConfig();
      if (!webhookRef) {
        ctx.logger.warn("Slack notifier skipped message: webhookSecretRef missing");
        return false;
      }

      try {
        const webhookUrl = await ctx.secrets.resolve(webhookRef);
        const response = await ctx.http.fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text,
            ...(channel ? { channel } : {})
          }),
        });
        if (!response.ok) {
          throw new Error(`Slack webhook responded with ${response.status}: ${await response.text()}`);
        }

        await ctx.metrics.write(METRIC_SENT, 1);
        return true;
      } catch (error) {
        await ctx.metrics.write(METRIC_FAILED, 1);
        ctx.logger.error("Slack notifier delivery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    };

    const isAllowedEvent = async (eventType: string) => {
      const { allowlist } = await readConfig();
      return allowlist.length === 0 || allowlist.includes(eventType);
    };

    ctx.events.on("agent.run.finished", async (event) => {
      if (!await isAllowedEvent(event.eventType)) return;
      const runId = asString(event.entityId) || "unknown-run";
      const delivered = await sendSlackMessage(`Agent run finished: ${runId}`);
      if (!delivered) return;
      await ctx.activity.log({
        companyId: event.companyId,
        message: "[slack-notifier-example] forwarded agent.run.finished",
        entityType: "run",
        entityId: runId
      });
    });

    ctx.events.on("issue.comment.created", async (event) => {
      if (!await isAllowedEvent(event.eventType)) return;
      const issueId = asString(event.entityId) || "unknown-issue";
      const delivered = await sendSlackMessage(`New issue comment on ${issueId}`);
      if (!delivered) return;
      await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: "last_slack_comment_event" }, event.occurredAt);
    });

    ctx.events.on("approval.decided", async (event) => {
      if (!await isAllowedEvent(event.eventType)) return;
      await sendSlackMessage("An approval decision was recorded in Paperclip.");
    });
  },

  async onValidateConfig(config) {
    if (!asString(config.webhookSecretRef)) {
      return { ok: false, errors: ["webhookSecretRef is required"] };
    }
    return { ok: true };
  },

  async onHealth() {
    return { status: "ok", message: "Slack notifier example plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
