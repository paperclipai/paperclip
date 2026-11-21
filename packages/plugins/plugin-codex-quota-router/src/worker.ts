import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { routeCodexConnection } from "./policy.js";

const plugin = definePlugin({
  async setup() {},
  async onRouteAiConnection(request) {
    return routeCodexConnection(request);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
