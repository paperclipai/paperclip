import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  JOB_KEYS,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Linear Dashboard",
  description:
    "Surfaces Linear workspace data — issue velocity, cycle progress, project health, team activity — as dashboard KPIs and a dedicated page. Agents can query and create Linear issues.",
  author: "ValCtrl",
  categories: ["connector", "ui"],
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
    "metrics.write",
    "activity.log.write",
    "companies.read",
    "agent.tools.register",
    "webhooks.receive",
    "events.emit",
    "ui.dashboardWidget.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      linearApiKeyRef: {
        type: "string",
        title: "Linear API Key (Secret Reference)",
        description:
          "Paperclip secret reference for a Linear API key with read/write scope",
        default: DEFAULT_CONFIG.linearApiKeyRef,
      },
      teamFilter: {
        type: "array",
        items: { type: "string" },
        title: "Team Filter",
        description:
          "If non-empty, only these teams will be tracked. Leave empty to track all workspace teams.",
        default: DEFAULT_CONFIG.teamFilter,
      },
    },
    required: ["linearApiKeyRef"],
  },
  jobs: [
    {
      jobKey: JOB_KEYS.sync,
      displayName: "Linear Workspace Sync",
      description:
        "Polls the Linear API for issue, project, cycle, and team data and caches aggregated results in plugin state.",
      schedule: "*/10 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.events,
      displayName: "Linear Webhook Events",
      description:
        "Receives issue, project, and cycle change events from Linear webhooks.",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.stats,
      displayName: "Linear Workspace Stats",
      description:
        "Returns current snapshot for the connected Linear workspace: issue throughput, cycle progress, project health, team activity.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: TOOL_NAMES.issueList,
      displayName: "Linear Issue List",
      description:
        "Lists issues from the connected Linear workspace with optional filtering by team, assignee, state, and priority.",
      parametersSchema: {
        type: "object",
        properties: {
          team: {
            type: "string",
            description: "Filter to a specific team name or ID. Optional.",
          },
          assignee: {
            type: "string",
            description:
              "Filter to a specific assignee name or 'me'. Optional.",
          },
          state: {
            type: "string",
            description:
              "Filter by state name (e.g. 'In Progress', 'Done'). Optional.",
          },
          priority: {
            type: "number",
            description:
              "Filter by priority level (0=none, 1=urgent, 2=high, 3=medium, 4=low). Optional.",
          },
          limit: {
            type: "number",
            description: "Maximum number of issues to return. Defaults to 50.",
          },
        },
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Linear Dashboard",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Linear Dashboard",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
    ],
  },
};

export default manifest;
