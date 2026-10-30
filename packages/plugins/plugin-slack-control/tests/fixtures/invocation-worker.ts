import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { createRuntime } from "../../src/runtime.js";

let runtime: ReturnType<typeof createRuntime>;
let release: (() => void) | undefined;
let body: unknown;
let expiredInvocationCode: unknown = null;
let replies = 0;
const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    runtime = createRuntime(ctx, async (_config, companyId) => ({
      isConnected: () => true,
      async start(receive) {
        const pending = new Promise<void>((resolve) => { release = resolve; });
        // Like Socket Mode, this continuation inherits configChanged's context
        // but executes only after that host invocation has returned.
        void pending.then(async () => {
          try { await ctx.access.members.list({ companyId }); }
          catch (error) { expiredInvocationCode = (error as { code?: unknown }).code; }
          await receive(body, async () => {});
        });
      },
      async stop() {},
      async verifyDirectMessage() { return true; },
      async reply() { replies++; },
    }));
  },
  async onConfigChanged(config, scope) { await runtime.configure(config, scope?.companyId ?? null); },
  async onApiRequest(input) {
    if (input.routeKey === "release") { body = input.body; release?.(); return { body: {} }; }
    return { body: { ...await runtime.status(input.companyId!), expiredInvocationCode, replies } };
  },
  async onShutdown() { await runtime.shutdown(); },
});
runWorker(plugin, import.meta.url);
