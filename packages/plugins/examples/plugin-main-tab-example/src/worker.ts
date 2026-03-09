import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("main-tab-example plugin setup complete");
  },
  async onHealth() {
    return { status: "ok", message: "Main tab example ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
