import {
  definePlugin,
  runWorker,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import { GbrainClient } from "./gbrain-client.js";
import { handleRunFinished, type Logger } from "./handlers.js";
import {
  deriveHindsightBankId,
  makeHindsightFetch,
  promoteFactsForRun,
} from "./fact-promotion.js";
import { DEFAULT_GBRAIN_MCP_URL } from "./manifest.js";

const DEFAULT_HINDSIGHT_API_URL = "http://hindsight-api.hindsight.svc.cluster.local:8888";
const DEFAULT_FACT_PROMOTION_DELAY_SEC = 180;

interface GbrainConfig {
  gbrainMcpUrl?: string;
  hindsightApiUrl?: string;
  autoRetain?: boolean;
  promoteFactsToPages?: boolean;
  factPromotionDelaySec?: number;
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
      const gbrainUrl = config.gbrainMcpUrl ?? DEFAULT_GBRAIN_MCP_URL;
      const hindsightUrl = config.hindsightApiUrl ?? DEFAULT_HINDSIGHT_API_URL;
      const client = new GbrainClient({ url: gbrainUrl });

      const result = await handleRunFinished({
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

      if (
        result.ok &&
        config.promoteFactsToPages !== false &&
        event.companyId
      ) {
        const delaySec = config.factPromotionDelaySec ?? DEFAULT_FACT_PROMOTION_DELAY_SEC;
        const bankId = deriveHindsightBankId(event.companyId, result.agentId);
        const promoteClient = new GbrainClient({ url: gbrainUrl });
        const hindsightFetch = makeHindsightFetch(hindsightUrl);
        // One-shot setTimeout. Durability tradeoff: if the pod restarts
        // within the delay window the per-fact pages for in-flight runs
        // are lost, but the timeline_entry on the issue + the memory_units
        // in hindsight still exist. Acceptable for wave 2 v1.
        setTimeout(async () => {
          try {
            const promotion = await promoteFactsForRun({
              client: promoteClient,
              hindsightFetch,
              bankId,
              runId: result.runId,
              issuePageSlug: result.issuePageSlug,
              agentPageSlug: result.agentPageSlug,
            });
            ctx.logger.info("gbrain fact-promotion complete", {
              runId: result.runId,
              ...promotion,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.logger.warn(`gbrain fact-promotion failed (non-fatal): ${msg}`, {
              runId: result.runId,
            });
          }
        }, delaySec * 1000);
      }
    });

    ctx.logger.info("gbrain plugin ready");
  },
  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
