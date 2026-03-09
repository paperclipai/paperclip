import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("entity-tabs-example plugin setup complete");
  },
  async onHealth() {
    return { status: "ok", message: "Entity tabs example ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
