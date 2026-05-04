import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

interface CurrentTimeParams {
  timezone?: string;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.tools.register(
      "current_time",
      {
        displayName: "Get current time",
        description:
          "Return the host server's current time (ISO-8601). Use this when the user asks 'what time is it?' or needs an absolute reference time.",
        parametersSchema: {
          type: "object",
          properties: { timezone: { type: "string" } },
          additionalProperties: false,
        },
      },
      async (rawParams) => {
        const params = (rawParams ?? {}) as CurrentTimeParams;
        const now = new Date();
        const tz = params.timezone?.trim() || "UTC";
        let formatted: string;
        try {
          formatted = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            dateStyle: "full",
            timeStyle: "long",
          }).format(now);
        } catch {
          formatted = now.toUTCString();
        }
        return {
          content: `${formatted} (${tz})`,
          data: {
            iso: now.toISOString(),
            timezone: tz,
            epochMillis: now.getTime(),
          },
        };
      },
    );
    ctx.logger.info("builder-sample-example plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "builder-sample-example ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
