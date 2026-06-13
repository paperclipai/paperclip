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
import {
  buildCacheEntry,
  prefetchRunContext,
  RECALL_STATE_KEY,
  DEFAULT_RECALL_DEPTH,
  type CachedRecall,
} from "./recall.js";

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
  prefetchRunContext?: boolean;
  recallEnrichmentFallback?: boolean;
  recallTraversalDepth?: number;
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

    // Wave 2.2: prefetch graph context on run start + register the
    // gbrain_recall_cache tool so agents can read the cached snapshot.
    ctx.tools.register(
      "gbrain_recall_cache",
      {
        displayName: "Recall gbrain Context (cached)",
        description:
          "Return the gbrain graph neighborhood prefetched at agent.run.started for this run's issue.",
        parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      async (_params, runCtx) => {
        const cached = (await ctx.state.get({
          scopeKind: "run",
          scopeId: runCtx.runId,
          stateKey: RECALL_STATE_KEY,
        })) as CachedRecall | null;
        if (!cached) {
          return {
            data: {
              status: "skipped",
              note: "prefetch did not run for this run (no agent.run.started event or feature disabled)",
            },
          };
        }
        return { data: cached, content: JSON.stringify(cached) };
      },
    );

    ctx.events.on("agent.run.started", async (event) => {
      const config = await getConfig(ctx);
      if (config.prefetchRunContext === false) return;
      const p = event.payload as Record<string, unknown>;
      const runId = typeof p.runId === "string" ? p.runId : null;
      const agentId = typeof p.agentId === "string" ? p.agentId : null;
      const issueId = typeof p.issueId === "string" ? p.issueId : null;
      if (!runId || !agentId) return;

      const gbrainUrl = config.gbrainMcpUrl ?? defaultGbrainUrl;
      const depth = config.recallTraversalDepth ?? DEFAULT_RECALL_DEPTH;

      let issueIdentifier: string | null = null;
      let projectId: string | null = null;
      let projectNameOrKey: string | null = null;
      if (issueId) {
        try {
          const issue = await ctx.issues.get(issueId, event.companyId);
          issueIdentifier = issue?.identifier ?? null;
          projectId = issue?.projectId ?? null;
          projectNameOrKey = issue?.project?.urlKey ?? issue?.project?.name ?? null;
        } catch {
          // ignore — prefetch falls through with no identifier
        }
      }

      let agentName: string | null = null;
      try {
        const agent = await ctx.agents.get(agentId, event.companyId);
        agentName = agent?.name ?? null;
      } catch {
        // ignore — issue-page traversal still works without enrichment labels
      }

      if (projectId && !projectNameOrKey) {
        try {
          const project = await ctx.projects.get(projectId, event.companyId);
          projectNameOrKey = project?.urlKey ?? project?.name ?? null;
        } catch {
          // ignore — ID-based project fallback remains available
        }
      }

      const client = buildClient(gbrainUrl, agentId);
      const result = await prefetchRunContext({
        client,
        issueIdentifier,
        companyId: event.companyId,
        agentId,
        agentName,
        projectId,
        projectNameOrKey,
        depth,
        enrichmentFallback: config.recallEnrichmentFallback !== false,
      });
      const entry = buildCacheEntry({ result, depth });
      await ctx.state.set(
        { scopeKind: "run", scopeId: runId, stateKey: RECALL_STATE_KEY },
        entry,
      );

      ctx.logger.info("gbrain prefetch complete", {
        runId,
        status: entry.status,
        issuePageSlug: entry.issuePageSlug,
        hasGraph: entry.graph !== null,
      });
    });

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
