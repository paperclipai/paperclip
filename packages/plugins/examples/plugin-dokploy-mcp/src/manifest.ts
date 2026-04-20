import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, EXPORT_NAMES, PLUGIN_ID, PLUGIN_VERSION, SLOT_IDS, TOOL_NAMES } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Dokploy MCP",
  description:
    "Wraps the Dokploy MCP server to expose infrastructure management tools to agents — view logs, list applications, check status, redeploy, and get resource stats.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "agent.tools.register",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      dokployMcpUrl: {
        type: "string",
        title: "Dokploy MCP URL",
        description: "HTTP endpoint for the Dokploy MCP server (e.g. http://dokploy-mcp:3001/mcp)",
        default: DEFAULT_CONFIG.dokployMcpUrl,
      },
    },
  },
  tools: [
    {
      name: TOOL_NAMES.getLogs,
      displayName: "Dokploy: Get Application Logs",
      description: "Retrieve container logs for a Dokploy application by its application ID.",
      parametersSchema: {
        type: "object",
        properties: {
          applicationId: {
            type: "string",
            description: "The Dokploy application ID.",
          },
        },
        required: ["applicationId"],
      },
    },
    {
      name: TOOL_NAMES.listApplications,
      displayName: "Dokploy: List Applications",
      description: "List all applications managed by Dokploy.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: TOOL_NAMES.getApplicationStatus,
      displayName: "Dokploy: Get Application Status",
      description: "Get the current deployment status of a Dokploy application.",
      parametersSchema: {
        type: "object",
        properties: {
          applicationId: {
            type: "string",
            description: "The Dokploy application ID.",
          },
        },
        required: ["applicationId"],
      },
    },
    {
      name: TOOL_NAMES.redeploy,
      displayName: "Dokploy: Redeploy Application",
      description: "Trigger a redeployment of a Dokploy application. This is a mutating action and will be logged.",
      parametersSchema: {
        type: "object",
        properties: {
          applicationId: {
            type: "string",
            description: "The Dokploy application ID to redeploy.",
          },
        },
        required: ["applicationId"],
      },
    },
    {
      name: TOOL_NAMES.getApplicationStats,
      displayName: "Dokploy: Get Application Stats",
      description: "Get resource usage statistics (CPU, memory, etc.) for a Dokploy application.",
      parametersSchema: {
        type: "object",
        properties: {
          applicationId: {
            type: "string",
            description: "The Dokploy application ID.",
          },
        },
        required: ["applicationId"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Dokploy MCP Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
    ],
  },
};

export default manifest;
