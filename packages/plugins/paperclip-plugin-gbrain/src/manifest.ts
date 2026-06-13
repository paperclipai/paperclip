import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kkroo.gbrain";
export const PLUGIN_VERSION = "0.2.0";

// gbrain's admin-ui container natively serves the MCP at /mcp on 3130
// with Bearer auth required. This bypasses the supergateway bridge
// (gbrain-mcp-internal:3131/gbrain), which leaks memory ~150-300MB/min
// under load and has to be restarted every ~5-20min.
//
// The legacy bridge URL is still accepted as a config override for
// instances that haven't seeded the OAuth clients file.
export const DEFAULT_GBRAIN_MCP_URL =
  "http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/mcp";

export const LEGACY_BRIDGE_GBRAIN_MCP_URL =
  "http://gbrain-mcp-internal.paperclip.svc.cluster.local:3131/gbrain";

export const DEFAULT_GBRAIN_OAUTH_TOKEN_URL =
  "http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/token";

export const DEFAULT_GBRAIN_OAUTH_CLIENTS_PATH =
  "/etc/paperclip-plugin-gbrain/clients.json";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "gbrain",
  description:
    "Retain agent run output to gbrain (graph brain) as timeline entries on issue pages, identity-tagged with agentId/runId/companyId.",
  author: "kkroo",
  categories: ["automation", "connector"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "agents.read",
    "projects.read",
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  tools: [
    {
      name: "gbrain_recall_cache",
      displayName: "Recall gbrain Context (cached)",
      description:
        "Return the gbrain graph neighborhood that was prefetched at agent.run.started for this run's issue (depth=2 by default). Cheap read from plugin state — no MCP round-trip. Returns {status, fetchedAtIso, issuePageSlug, depth, graph?, note?}. status='ok' means a useful multi-node neighborhood was found; 'empty' and 'island' mean traversal found no reusable neighborhood; 'no-issue-page' means the issue has no gbrain page yet; 'skipped' means no issue-bearing run; 'error' means traversal/auth failed. Call this near the start of your work to get prior decisions, related agents, and recently-promoted facts for the issue you're working on.",
      parametersSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      gbrainMcpUrl: {
        type: "string",
        default: DEFAULT_GBRAIN_MCP_URL,
        description:
          "MCP Streamable-HTTP endpoint for gbrain. Defaults to the auth'd admin-ui path; set to the legacy bridge URL when oauthClientsPath is absent.",
      },
      gbrainOauthTokenUrl: {
        type: "string",
        default: DEFAULT_GBRAIN_OAUTH_TOKEN_URL,
        description:
          "OAuth client_credentials token endpoint. Only used when oauthClientsPath resolves.",
      },
      oauthClientsPath: {
        type: "string",
        default: DEFAULT_GBRAIN_OAUTH_CLIENTS_PATH,
        description:
          "Path to a JSON map of agentId → {client_id, client_secret}, typically mounted from a k8s Secret. If the file is absent the plugin falls back to anonymous (legacy bridge) calls.",
      },
      hindsightApiUrl: {
        type: "string",
        default: "http://hindsight-api.hindsight.svc.cluster.local:8888",
        description: "Hindsight API base URL for the fact-promotion bridge.",
      },
      autoRetain: {
        type: "boolean",
        default: true,
        description: "Append a timeline entry on every successful agent run.",
      },
      promoteFactsToPages: {
        type: "boolean",
        default: true,
        description: "Materialize hindsight memory_units as fact-<uuid> pages (wave 2).",
      },
      factPromotionDelaySec: {
        type: "integer",
        default: 180,
        description: "Seconds to wait after retain before querying hindsight for memory_units.",
      },
      prefetchRunContext: {
        type: "boolean",
        default: true,
        description:
          "Wave 2.2: on agent.run.started, fetch a depth-N graph traversal from the issue page and cache it under the run scope for the gbrain_recall_cache tool to read.",
      },
      recallEnrichmentFallback: {
        type: "boolean",
        default: true,
        description:
          "When issue-page traversal is missing, empty, or an island, also traverse known agent/project page hubs and cache the first useful merged graph.",
      },
      recallTraversalDepth: {
        type: "integer",
        default: 2,
        description: "Depth of the traverse_graph call used by wave 2.2 prefetch.",
      },
    },
  },
};

export default manifest;
