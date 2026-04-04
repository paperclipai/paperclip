import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_DARWIN_SERVER_ARGS,
  DEFAULT_DARWIN_SERVER_COMMAND,
  DEFAULT_SHARED_NAMESPACE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_UPSTASH_TOKEN_ENV_VAR,
  DEFAULT_UPSTASH_URL_ENV_VAR,
  PLUGIN_ID,
  PLUGIN_VERSION,
  TOOL_NAMES,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Darwin Brain Bridge",
  description: "Expose Darwin Brain semantic memory to Paperclip agents with tenant-aware defaults and promotion guardrails.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "agent.tools.register",
    "companies.read",
    "agents.read",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      darwinServerCommand: {
        type: "string",
        title: "Darwin MCP Command",
        default: DEFAULT_DARWIN_SERVER_COMMAND,
      },
      darwinServerArgsJson: {
        type: "string",
        title: "Darwin MCP Args JSON",
        default: DEFAULT_DARWIN_SERVER_ARGS,
        description: "JSON array of command args used to launch the Darwin MCP server.",
      },
      upstashUrlSecretRef: {
        type: "string",
        title: "Upstash URL Secret Ref",
        default: "",
        format: "secret-ref",
      },
      upstashTokenSecretRef: {
        type: "string",
        title: "Upstash Token Secret Ref",
        default: "",
        format: "secret-ref",
      },
      upstashUrlEnvVar: {
        type: "string",
        title: "Upstash URL Env Var",
        default: DEFAULT_UPSTASH_URL_ENV_VAR,
      },
      upstashTokenEnvVar: {
        type: "string",
        title: "Upstash Token Env Var",
        default: DEFAULT_UPSTASH_TOKEN_ENV_VAR,
      },
      sharedNamespace: {
        type: "string",
        title: "Shared Namespace",
        default: DEFAULT_SHARED_NAMESPACE,
      },
      timeoutMs: {
        type: "number",
        title: "MCP Timeout (ms)",
        default: DEFAULT_TIMEOUT_MS,
      },
      companyPoliciesJson: {
        type: "string",
        title: "Company Policies JSON",
        default: "[]",
        description: "JSON array of { companyId, namespace, accessMode } records.",
      },
      agentPoliciesJson: {
        type: "string",
        title: "Agent Policies JSON",
        default: "[]",
        description: "JSON array of { agentId, namespace?, accessMode? } records.",
      },
    },
  },
  tools: [
    {
      name: TOOL_NAMES.search,
      displayName: "Darwin Search",
      description: "Search Darwin Brain globally, optionally filtered by content type.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          topK: { type: "number" },
          type: { type: "string" },
          filter: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: TOOL_NAMES.searchTenant,
      displayName: "Darwin Tenant Search",
      description: "Search Darwin Brain inside the caller's configured tenant namespace.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          topK: { type: "number" },
          filter: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: TOOL_NAMES.store,
      displayName: "Darwin Store",
      description: "Store knowledge in the caller's Darwin tenant namespace or promote it to shared memory when allowed.",
      parametersSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          category: { type: "string" },
          topic: { type: "string" },
          industry: { type: "string" },
          promote: { type: "boolean" },
        },
        required: ["id", "text"],
      },
    },
    {
      name: TOOL_NAMES.info,
      displayName: "Darwin Info",
      description: "Check Darwin Brain health and namespace diagnostics.",
      parametersSchema: {
        type: "object",
        properties: {
          namespace: { type: "string" },
        },
      },
    },
  ],
};

export default manifest;
