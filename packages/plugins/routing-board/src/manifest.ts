import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  EXPORT_NAMES,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Routing Board (nideas)",
  description:
    "Choose a routing (orchestrator x model: cc, cc-ds, cc-bridge, cc-or, oc-ds, oc-or, oc-nim, oc-qw, oc-free) when creating tasks or running agent heartbeats, with an additive routing registry and per-agent defaults.",
  author: "nideas",
  categories: ["ui", "automation"],
  capabilities: [
    "companies.read",
    "agents.read",
    "agents.pause",
    "agents.resume",
    "agents.invoke",
    "issues.create",
    "issues.update",
    "plugin.state.read",
    "plugin.state.write",
    "agent.tools.register",
    "ui.page.register",
    "ui.sidebar.register",
    "api.routes.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      showSidebarEntry: {
        type: "boolean",
        title: "Show Routing entry in the sidebar",
        default: true,
      },
      defaultRouting: {
        type: "string",
        title: "Default routing id applied when none is set on an agent",
        enum: ["cc", "cc-ds", "cc-bridge", "cc-or", "oc-ds", "oc-or", "oc-nim", "oc-qw", "oc-free"],
        default: "oc-ds",
      },
      freeLanesOnly: {
        type: "boolean",
        title: "Enforce free lanes only (no claude quota)",
        description:
          "When enabled, claude-backed routings (cc, cc-bridge, cc-or, cc-ds) are marked unavailable regardless of keys.",
        default: true,
      },
    },
  },
  tools: [
    {
      name: TOOL_NAMES.listRoutings,
      displayName: "Routing — list",
      description: "List all registered routings with availability and per-agent defaults.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string", title: "Company ID" },
        },
      },
    },
    {
      name: TOOL_NAMES.getRouting,
      displayName: "Routing — get",
      description: "Get one routing's config (orchestrator, model, command, env template, badges).",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string", title: "Company ID" },
          routingId: { type: "string", title: "Routing id (e.g. oc-ds)" },
        },
        required: ["routingId"],
      },
    },
    {
      name: TOOL_NAMES.setDefaultRouting,
      displayName: "Routing — set default (record)",
      description:
        "Set an agent's default routing and apply it to the agent's adapter config. FREE LANES ONLY policy is enforced.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string", title: "Company ID" },
          agentId: { type: "string", title: "Agent ID" },
          routingId: { type: "string", title: "Routing id (e.g. oc-ds)" },
        },
        required: ["agentId", "routingId"],
      },
    },
    {
      name: TOOL_NAMES.createRouting,
      displayName: "Routing — create",
      description: "Add a new routing to the additive registry.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string", title: "Company ID" },
          id: { type: "string", title: "Routing id (e.g. oc-gemini)" },
          label: { type: "string", title: "Human label" },
          orchestrator: { type: "string", enum: ["claude_code", "opencode"] },
          adapterType: { type: "string", enum: ["claude_local", "opencode_local"] },
          model: { type: "string", title: "model, provider/model for opencode" },
          command: { type: "string", title: "claude | ccb | opencode" },
          env: { type: "object", additionalProperties: { type: "string" } },
          badges: { type: "array", items: { type: "string" } },
        },
        required: ["id", "label", "adapterType"],
      },
    },
    {
      name: TOOL_NAMES.deleteRouting,
      displayName: "Routing — delete",
      description: "Remove a non-builtin routing from the registry.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string", title: "Company ID" },
          routingId: { type: "string", title: "Routing id" },
        },
        required: ["routingId"],
      },
    },
    {
      name: TOOL_NAMES.invokeHeartbeatWithRouting,
      displayName: "Routing — heartbeat (record intent)",
      description:
        "Invoke an agent heartbeat with an explicit routing override (applies the routing's adapter config for this run).",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string", title: "Company ID" },
          agentId: { type: "string", title: "Agent ID" },
          routingId: { type: "string", title: "Routing id override" },
        },
        required: ["agentId", "routingId"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Routing",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
        order: 10,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "Routing",
        exportName: EXPORT_NAMES.sidebar,
        order: 30,
      },
    ],
  },
  apiRoutes: [
    {
      routeKey: "set-agent-routing",
      method: "POST",
      path: "/agents/:agentId/routing",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
};

export default manifest;
