import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("page-example plugin setup complete");
  },
  async onHealth() {
    return { status: "ok", message: "Page example ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
