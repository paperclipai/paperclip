import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { evaluateIssue, type RoutingDecisionClient } from "./routing.js";

export function createRoutingPlugin(client?: RoutingDecisionClient) {
  return definePlugin({
    async setup(ctx) {
      ctx.events.on("issue.created", async (event) => {
        if (!event.entityId) return;
        await evaluateIssue(ctx, event.entityId, event.companyId, client);
      });
    },
    async onHealth() {
      return { status: "ok", message: "TypeSafe routing pilot worker is ready" };
    },
  });
}

const plugin = createRoutingPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
