import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

import { DEFAULT_CONFIG, PLUGIN_ID } from "./constants.js";

/**
 * Worker stays deliberately thin. The approvals list is read via same-origin
 * board session from the UI side, so we only expose plugin config + health.
 */
const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_ID} setup complete`);

    ctx.data.register("plugin-config", async () => {
      const raw = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
      const config = {
        refreshIntervalSeconds:
          typeof raw.refreshIntervalSeconds === "number" && raw.refreshIntervalSeconds >= 0
            ? raw.refreshIntervalSeconds
            : DEFAULT_CONFIG.refreshIntervalSeconds,
        showBadge:
          raw.showBadge === undefined ? DEFAULT_CONFIG.showBadge : Boolean(raw.showBadge),
        listLimit:
          typeof raw.listLimit === "number" && raw.listLimit > 0
            ? Math.min(500, Math.floor(raw.listLimit))
            : DEFAULT_CONFIG.listLimit,
      };
      return config;
    });
  },

  async onHealth() {
    return { status: "ok", message: "Approvals Menu plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
