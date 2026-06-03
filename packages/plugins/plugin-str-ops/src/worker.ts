import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("health", async () => ({ status: "ok", plugin: "str-ops" }));
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
