import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { createSlackConnection } from "./connection.js";
import { parseConfig } from "./config.js";
import { createRuntime, type Connect } from "./runtime.js";

export function slackConnection(ctx: PluginContext): Connect {
  return async (config, companyId) => {
    const [appToken, botToken] = await Promise.all([
      ctx.secrets.resolve(config.appToken, { companyId, configPath: "appToken" }),
      ctx.secrets.resolve(config.botToken, { companyId, configPath: "botToken" }),
    ]);
    return createSlackConnection(config, appToken, botToken, (message) => ctx.logger.warn(message));
  };
}

let runtime: ReturnType<typeof createRuntime>;
const plugin = definePlugin({
  async setup(ctx) { runtime = createRuntime(ctx, slackConnection(ctx)); },
  async onConfigChanged(config, scope) { await runtime.configure(config, scope?.companyId ?? null); },
  async onValidateConfig(config) {
    try { parseConfig(config); return { ok: true }; }
    catch { return { ok: false, errors: ["Use the documented workspace, user/project mappings and company secret references."] }; }
  },
  async onApiRequest(input) {
    if (input.routeKey !== "status") return { status: 404, body: { error: "Unknown route" } };
    if (input.actor.actorType !== "user" || !input.companyId) return { status: 403, body: { error: "An authenticated company operator is required." } };
    try { return { body: await runtime.status(input.companyId) }; }
    catch { return { status: 403, body: { error: "Company scope mismatch" } }; }
  },
  async onHealth() {
    const state = runtime.health();
    return { status: state === "error" ? "error" : state === "connecting" ? "degraded" : "ok", message: `Slack Control: ${state}` };
  },
  async onShutdown() { await runtime.shutdown(); },
});
export default plugin;
runWorker(plugin, import.meta.url);
