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
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
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
    },
  },
};

export default manifest;
