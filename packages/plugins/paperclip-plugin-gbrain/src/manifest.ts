import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kkroo.gbrain";
export const PLUGIN_VERSION = "0.1.0";

export const DEFAULT_GBRAIN_MCP_URL =
  "http://gbrain-mcp-internal.paperclip.svc.cluster.local:3131/gbrain";

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
        description: "MCP Streamable-HTTP endpoint for gbrain.",
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
