import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const PLUGIN_NAME = "hello-world-example";
const HEALTH_MESSAGE = "Hello World example plugin ready";

/**
 * Worker lifecycle hooks for the Hello World reference plugin.
 * This stays intentionally small so new authors can copy the shape quickly.
 */
const plugin = definePlugin({
  /**
   * Called when the host starts the plugin worker.
   */
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup complete`);
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
