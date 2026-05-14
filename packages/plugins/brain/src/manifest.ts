import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "whitestag.brain";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Obsidian Brain",
  description:
    "Exposes Walter's Obsidian vault as a semantically searchable knowledge base. Per-agent ACLs, default-deny, full audit log.",
  author: "WHITESTAG",
  categories: ["connector"],
  capabilities: ["agent.tools.register", "instance.settings.register"],
  instanceConfigSchema: {
    type: "object",
    properties: {
      mcpEndpoint: {
        type: "string",
        title: "Brain MCP endpoint",
        description: "URL of the Brain MCP server (default http://localhost:7777)",
        default: "http://localhost:7777",
      },
      bearerToken: {
        type: "string",
        title: "Bearer token (paperclip)",
        description:
          "Token configured as BRAIN_PAPERCLIP_TOKEN in the Brain MCP launchd plist. Required.",
      },
      agentMap: {
        type: "object",
        title: "Agent UUID → ACL key",
        description:
          "Map Paperclip agent UUIDs to Brain ACL keys (e.g. 'CEO'). Unmapped agents fall back to their UUID.",
        additionalProperties: { type: "string" },
        default: {},
      },
    },
    required: ["bearerToken"],
  },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "brain-settings",
        displayName: "Obsidian Brain",
        exportName: "BrainSettingsPage",
      },
    ],
  },
  tools: [
    {
      name: "vault.search",
      displayName: "Search vault",
      description:
        "Semantic search across the Obsidian vault. Returns top hits with score, heading path and excerpt. ACL-enforced per agent.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language query" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 8 },
          folderFilter: {
            type: "array",
            items: { type: "string" },
            description: "Restrict search to these folders (must already be in agent ACL)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "vault.get_note",
      displayName: "Get note",
      description: "Return full body of a vault note by path. ACL-enforced.",
      parametersSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative note path" },
        },
        required: ["path"],
      },
    },
    {
      name: "vault.list_scope",
      displayName: "List scope",
      description: "List folders the current agent may access and total reachable note count.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
};

export default manifest;
