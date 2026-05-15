import {
  definePlugin,
  runWorker,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import { GbrainClient } from "./gbrain-client.js";
import { handleRunFinished, type Logger } from "./handlers.js";
import { DEFAULT_GBRAIN_MCP_URL } from "./manifest.js";

interface GbrainConfig {
  gbrainMcpUrl?: string;
  autoRetain?: boolean;
}

async function getConfig(ctx: PluginContext): Promise<GbrainConfig> {
  return ((await ctx.config.get()) ?? {}) as GbrainConfig;
}

function makeLogger(ctx: PluginContext): Logger {
  return {
    info: (msg, fields) => ctx.logger.info(msg, fields ?? {}),
    warn: (msg, fields) => ctx.logger.warn(msg, fields ?? {}),
    error: (msg, fields) => ctx.logger.error(msg, fields ?? {}),
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("gbrain plugin starting");

    ctx.events.on("agent.run.finished", async (event) => {
      const config = await getConfig(ctx);
      const client = new GbrainClient({
        url: config.gbrainMcpUrl ?? DEFAULT_GBRAIN_MCP_URL,
      });

      await handleRunFinished({
        event: {
          eventType: event.eventType,
          companyId: event.companyId,
          payload: event.payload as Record<string, unknown>,
        },
        client,
        logger: makeLogger(ctx),
        autoRetain: config.autoRetain !== false,
        lookupIssueIdentifier: async (issueId) => {
          const issue = await ctx.issues.get(issueId, event.companyId);
          return issue?.identifier ?? null;
        },
        lookupAgentName: async (agentId) => {
          const agent = await ctx.agents.get(agentId, event.companyId);
          return agent?.name ?? null;
        },
      });
    });

    ctx.logger.info("gbrain plugin ready");
  },
  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
