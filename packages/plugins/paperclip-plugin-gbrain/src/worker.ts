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
import {
  DEFAULT_GBRAIN_MCP_URL,
  LEGACY_BRIDGE_GBRAIN_MCP_URL,
  DEFAULT_GBRAIN_OAUTH_TOKEN_URL,
  DEFAULT_GBRAIN_OAUTH_CLIENTS_PATH,
} from "./manifest.js";
import {
  OAuthClientManager,
  loadClientsFromFile,
} from "./oauth-client-manager.js";

const DEFAULT_HINDSIGHT_API_URL = "http://hindsight-api.hindsight.svc.cluster.local:8888";
const DEFAULT_FACT_PROMOTION_DELAY_SEC = 180;

interface GbrainConfig {
  gbrainMcpUrl?: string;
  gbrainOauthTokenUrl?: string;
  oauthClientsPath?: string;
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

    // Load the OAuth client map once at plugin startup. Falls back to
    // anonymous (legacy bridge) calls when the file is absent. The
    // file path comes from instance config so operators can move the
    // mount around without rebuilding the plugin.
    const bootConfig = await getConfig(ctx);
    const clientsPath = bootConfig.oauthClientsPath ?? DEFAULT_GBRAIN_OAUTH_CLIENTS_PATH;
    const tokenUrl = bootConfig.gbrainOauthTokenUrl ?? DEFAULT_GBRAIN_OAUTH_TOKEN_URL;
    const clients = await loadClientsFromFile(clientsPath);

    let oauth: OAuthClientManager | null = null;
    if (clients) {
      oauth = new OAuthClientManager({ tokenUrl, clients });
      ctx.logger.info("gbrain OAuth client manager loaded", {
        agentCount: oauth.agentCount(),
        clientsPath,
        tokenUrl,
      });
    } else {
      ctx.logger.info("gbrain OAuth disabled — falling back to anonymous calls", {
        clientsPath,
      });
    }

    function buildClient(gbrainUrl: string, agentId: string): GbrainClient {
      if (oauth && oauth.hasAgent(agentId)) {
        return new GbrainClient({
          url: gbrainUrl,
          authProvider: () => oauth!.getToken(agentId),
          onAuthFailure: () => oauth!.invalidate(agentId),
        });
      }
      // No OAuth entry for this agent — fall back to anonymous.
      // Helpful when adding a new agent before its OAuth client is seeded.
      return new GbrainClient({ url: gbrainUrl });
    }

    // Pick the gbrain URL based on whether OAuth is available. The
    // admin-ui endpoint requires Bearer auth (401 otherwise), so if
    // OAuth isn't configured we have to use the legacy supergateway-
    // bridge URL which accepts anonymous calls. An explicit
    // `gbrainMcpUrl` in instance config always wins over this default.
    const defaultGbrainUrl = oauth ? DEFAULT_GBRAIN_MCP_URL : LEGACY_BRIDGE_GBRAIN_MCP_URL;
    if (!oauth) {
      ctx.logger.info(
        "gbrain plugin using legacy bridge URL — seed the OAuth clients file to switch to admin-ui",
        { gbrainUrl: defaultGbrainUrl },
      );
    }

    ctx.events.on("agent.run.finished", async (event) => {
      const config = await getConfig(ctx);
      const gbrainUrl = config.gbrainMcpUrl ?? defaultGbrainUrl;
      const hindsightUrl = config.hindsightApiUrl ?? DEFAULT_HINDSIGHT_API_URL;

      const result = await handleRunFinished({
        event: {
          eventType: event.eventType,
          companyId: event.companyId,
          payload: event.payload as Record<string, unknown>,
        },
        makeClient: (agentId) => buildClient(gbrainUrl, agentId),
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
        const promoteClient = buildClient(gbrainUrl, result.agentId);
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
