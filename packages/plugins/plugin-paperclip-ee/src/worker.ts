import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { PAPERCLIP_EE_PLUGIN_ID } from "./manifest.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("availability", async ({ companyId }) => ({
      pluginId: PAPERCLIP_EE_PLUGIN_ID,
      companyId: typeof companyId === "string" ? companyId : null,
      status: "ready",
      checkedAt: new Date().toISOString(),
    }));
  },

  async onHealth() {
    return { status: "ok", message: "Paperclip EE skill policy editor is available" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
