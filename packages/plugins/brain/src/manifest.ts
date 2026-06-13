import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "whitestag.brain";
const PLUGIN_VERSION = "0.2.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Obsidian Brain",
  description:
    "Exposes one or more Obsidian vaults as a semantically searchable knowledge base, one Brain MCP endpoint per Paperclip company. Per-agent ACLs, default-deny, full audit log.",
  author: "WHITESTAG",
  categories: ["connector"],
  capabilities: ["agent.tools.register", "instance.settings.register"],
  instanceConfigSchema: {
    type: "object",
    properties: {
      companies: {
        type: "object",
        title: "Brain endpoints per company",
        description:
          "Map Paperclip companyId → Brain MCP endpoint. Each company can target a different vault / Brain server.",
        additionalProperties: {
          type: "object",
          properties: {
            mcpEndpoint: {
              type: "string",
              title: "Brain MCP endpoint",
              description: "URL of the Brain MCP server for this company.",
            },
            bearerToken: {
              type: "string",
              title: "Bearer token (paperclip)",
              description:
                "Token configured as BRAIN_PAPERCLIP_TOKEN in this company's Brain MCP launchd plist.",
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
          required: ["mcpEndpoint", "bearerToken"],
        },
        default: {},
      },
      defaultCompanyId: {
        type: "string",
        title: "Default companyId",
        description:
          "Fallback companyId to use when a tool call arrives without a runContext.companyId. Optional.",
      },
    },
    required: ["companies"],
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
        "Semantic search across the company's Obsidian vault. Returns top hits with score, heading path and excerpt. ACL-enforced per agent.",
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
