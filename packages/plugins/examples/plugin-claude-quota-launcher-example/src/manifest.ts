import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.claude-quota-launcher-example";
const PLUGIN_VERSION = "0.1.0";

/**
 * Example manifest: toolbar launcher that opens a host-owned modal
 * showing Claude subscription quota usage (company cost summary + per-agent breakdown).
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Claude Quota (Example)",
  description: "Opens a modal with Claude subscription quota usage and company cost summary.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: ["ui.action.register", "http.outbound"],
  instanceConfigSchema: {
    type: "object",
    properties: {
      anthropicOAuthAccessToken: {
        type: "string",
        description: "OAuth access token for the Anthropic usage API (used to fetch 5hr and weekly quota). Get it from your Claude account; the plugin calls GET https://api.anthropic.com/api/oauth/usage.",
      },
    },
  },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    launchers: [
      {
        id: "claude-quota-modal",
        displayName: "Claude quota",
        description: "View Claude subscription quota and usage",
        placementZone: "toolbarButton",
        action: {
          type: "openModal",
          target: "ClaudeUsageModal",
        },
        render: {
          environment: "hostOverlay",
          bounds: "wide",
        },
      },
    ],
  },
};

export default manifest;
