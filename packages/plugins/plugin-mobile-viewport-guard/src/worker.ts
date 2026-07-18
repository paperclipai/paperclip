import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./constants.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Mobile Viewport Guard plugin registered", {
      pluginId: PLUGIN_ID,
      mode: "same-origin-ui-guard",
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Mobile Viewport Guard plugin is ready",
      details: {
        guard: "viewport meta, mobile form-control sizing, and selector keyboard suppression",
      },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
