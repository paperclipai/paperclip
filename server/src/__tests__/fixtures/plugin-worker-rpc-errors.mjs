import { definePlugin, startWorkerRpcHost } from "@paperclipai/plugin-sdk";

startWorkerRpcHost({
  plugin: definePlugin({
    async setup(ctx) {
      // Let the SDK carry the host refusal back through either worker handler.
      const readHostConfig = async () => ctx.config.get();
      ctx.actions.register("host-config", readHostConfig);
      ctx.data.register("host-config", readHostConfig);
    },
  }),
});
