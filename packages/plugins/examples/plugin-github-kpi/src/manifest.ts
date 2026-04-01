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
  displayName: "GitHub Org KPI Tracker",
  description:
    "Tracks GitHub organisation-wide metrics — commit velocity, PR cycle times, issue throughput, contributor activity across all repos — and surfaces them as dashboard KPIs.",
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
    "ui.sidebar.register",
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
      orgName: {
        type: "string",
        title: "GitHub Organisation",
        description: "GitHub organisation handle (e.g. 'paperclipai')",
        default: DEFAULT_CONFIG.orgName,
      },
      githubTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "GitHub Token",
        description:
          "GitHub Personal Access Token with org + repo read scope",
        default: DEFAULT_CONFIG.githubTokenRef,
      },
      repoFilter: {
        type: "array",
        items: { type: "string" },
        title: "Repository Allow-list",
        description:
          "If non-empty, only these repos will be tracked. Leave empty to track all org repos.",
        default: DEFAULT_CONFIG.repoFilter,
      },
      repoExclude: {
        type: "array",
        items: { type: "string" },
        title: "Repository Deny-list",
        description:
          "Repos to exclude from tracking (e.g. forks, archived, internal tooling).",
        default: DEFAULT_CONFIG.repoExclude,
      },
    },
    required: ["orgName"],
  },
  jobs: [
    {
      jobKey: JOB_KEYS.sync,
      displayName: "GitHub Org Sync",
      description:
        "Polls the GitHub REST API across all organisation repos for commit, PR, issue, and contributor stats and caches aggregated results in plugin state.",
      schedule: "*/15 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.events,
      displayName: "GitHub Webhook Events",
      description:
        "Receives push, pull_request, issues, and release events from GitHub organisation webhooks.",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.stats,
      displayName: "GitHub Org Stats",
      description:
        "Returns current KPI snapshot for the configured GitHub organisation: aggregate commit velocity, PR metrics, issue counts, top contributors, and per-repo breakdown.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: TOOL_NAMES.prList,
      displayName: "GitHub Org Open PRs",
      description:
        "Lists currently open pull requests across all organisation repos with author, repo, title, age, review status, and CI status.",
      parametersSchema: {
        type: "object",
        properties: {
          state: {
            type: "string",
            enum: ["open", "closed", "all"],
            description: "PR state filter. Defaults to 'open'.",
          },
          limit: {
            type: "number",
            description: "Maximum number of PRs to return. Defaults to 30.",
          },
          repo: {
            type: "string",
            description: "Filter to a specific repo within the org. Optional.",
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
        displayName: "GitHub Org KPIs",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "GitHub Org KPIs",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "GitHub KPIs",
        exportName: EXPORT_NAMES.sidebar,
      },
    ],
  },
};

export default manifest;
