import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMES } from "./constants.js";

const querySchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    topK: { type: "number", minimum: 1, maximum: 50 },
    workspaceId: { type: "string" },
  },
  required: ["query"],
} as const;

const searchSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    limit: { type: "number", minimum: 1, maximum: 50 },
    sourceType: { type: "string" },
    nodeType: { type: "string" },
    workspaceId: { type: "string" },
  },
  required: ["query"],
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "OpenCrab Ontology Pack",
  description:
    "Exposes OpenCrab ontology evidence as read-only Paperclip agent tools with secret-redacted configuration and approval-gated ingest separation.",
  author: "FMG / Paperclip",
  categories: ["connector", "automation"],
  capabilities: ["agent.tools.register", "http.outbound", "secrets.read-ref"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      endpoint: {
        type: "string",
        title: "OpenCrab MCP Endpoint",
        description: "Sensitive endpoint. Prefer a secret reference when the host supports one. UI/logs must redact this value.",
      },
      endpointRef: {
        type: "string",
        title: "OpenCrab MCP Endpoint Secret Ref",
        description: "Secret reference containing the OpenCrab MCP endpoint.",
      },
      workspaceId: {
        type: "string",
        title: "Default OpenCrab Workspace ID",
      },
      defaultLimit: {
        type: "number",
        title: "Default Result Limit",
        default: 10,
        minimum: 1,
        maximum: 50,
      },
      maxLimit: {
        type: "number",
        title: "Maximum Result Limit",
        default: 50,
        minimum: 1,
        maximum: 50,
      },
      ingestEnabled: {
        type: "boolean",
        title: "Enable OpenCrab Ingest",
        default: false,
        description: "Read-only by default. Enable only after explicit knowledge-mutation approval.",
      },
    },
  },
  tools: [
    {
      name: TOOL_NAMES.status,
      displayName: "OpenCrab Status",
      description: "Checks OpenCrab availability and discovered ontology capability status.",
      parametersSchema: { type: "object", properties: {} },
    },
    {
      name: TOOL_NAMES.query,
      displayName: "OpenCrab Query",
      description: "Answers broad research or decision-support questions using OpenCrab ontology evidence.",
      parametersSchema: querySchema,
    },
    {
      name: TOOL_NAMES.searchDocuments,
      displayName: "OpenCrab Search Documents",
      description: "Finds document evidence chunks in OpenCrab for citations or grounding.",
      parametersSchema: searchSchema,
    },
    {
      name: TOOL_NAMES.searchNodes,
      displayName: "OpenCrab Search Nodes",
      description: "Finds ontology graph nodes for concepts, entities, repositories, products, and relationships.",
      parametersSchema: searchSchema,
    },
    {
      name: TOOL_NAMES.getNodeContext,
      displayName: "OpenCrab Get Node Context",
      description: "Inspects neighboring ontology relationships for a selected OpenCrab node.",
      parametersSchema: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 50 },
          workspaceId: { type: "string" },
        },
        required: ["nodeId"],
      },
    },
    {
      name: TOOL_NAMES.searchPacks,
      displayName: "OpenCrab Search Packs",
      description: "Searches OpenCrab ontology packs or marketplace metadata for relevant knowledge packs.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          category: { type: "string" },
          licenseScope: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 50 },
          workspaceId: { type: "string" },
        },
      },
    },
  ],
};

export default manifest;
