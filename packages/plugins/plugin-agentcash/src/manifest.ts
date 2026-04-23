import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMES } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "AgentCash",
  description:
    "Gives agents access to paid APIs via x402 micropayments and SIWX authentication using a shared USDC wallet.",
  author: "AgentCash",
  categories: ["connector"],
  capabilities: [
    "agent.tools.register",
    "http.outbound",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  tools: [
    {
      name: TOOL_NAMES.fetch,
      displayName: "AgentCash Fetch",
      description:
        "HTTP fetch with automatic x402 payment and SIWX authentication. Call agentcash-check-schema first for unfamiliar endpoints.",
      parametersSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The endpoint URL" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
            description: "HTTP method. Defaults to GET.",
          },
          body: {
            description: "Request body — string or JSON object.",
          },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Additional headers as key-value pairs.",
          },
          maxAmount: {
            type: "number",
            description:
              "Maximum USD to pay per request. Aborts if endpoint costs more. Default $5.",
          },
        },
        required: ["url"],
      },
    },
    {
      name: TOOL_NAMES.discover,
      displayName: "AgentCash Discover Endpoints",
      description:
        "List available endpoints at an API origin with descriptions and auth modes (paid or SIWX).",
      parametersSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The origin URL to discover endpoints on (e.g. https://stableenrich.dev)",
          },
          includeGuidance: {
            type: "boolean",
            description:
              "Include full usage guidance from the API provider. Useful when composing multiple endpoints.",
          },
        },
        required: ["url"],
      },
    },
    {
      name: TOOL_NAMES.checkSchema,
      displayName: "AgentCash Check Endpoint Schema",
      description:
        "Get the input/output schema, auth mode, and pricing for a single endpoint. Call before fetch to avoid 400 errors.",
      parametersSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The endpoint URL" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
            description: "HTTP method to check. Omit for all methods.",
          },
          body: {
            description:
              "Optional sample body to probe for exact pricing (no payment made).",
          },
        },
        required: ["url"],
      },
    },
    {
      name: TOOL_NAMES.getBalance,
      displayName: "AgentCash Get Balance",
      description:
        "Get total USDC wallet balance across all supported networks. Call before paid API requests.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
};

export default manifest;
