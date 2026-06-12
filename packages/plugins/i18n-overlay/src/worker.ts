import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const HEALTH_MESSAGE = "i18n-overlay ready";

/**
 * Worker lifecycle hooks for the i18n-overlay plugin.
 *
 * This plugin is UI-only — all translation work happens client-side in the
 * sidebar mount. The worker exists so the host can register and health-check
 * the plugin like any other.
 */
const plugin = definePlugin({
  /**
   * Called when the host starts the plugin worker.
   */
  async setup(ctx) {
    ctx.logger.info(HEALTH_MESSAGE);
  },

  /**
   * Called by the host health probe endpoint.
   */
  async onHealth() {
    return { status: "ok", message: HEALTH_MESSAGE };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
