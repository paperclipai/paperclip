import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const PLUGIN_NAME = "i18n-example";

/**
 * Minimal worker for the i18n example plugin.
 * Matches the required definePlugin + runWorker pattern.
 */
const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup complete`);
  },
  async onHealth() {
    return { status: "ok", message: "i18n example plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
