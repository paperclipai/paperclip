import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Portuguese (BR) language pack worker started");
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
