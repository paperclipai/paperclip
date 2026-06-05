import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("decision-status-widget plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Decision Status Widget ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
