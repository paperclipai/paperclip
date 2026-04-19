import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
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
  displayName: "Sentry",
  description:
    "Sentry error tracking integration. Provides agent tools for querying production errors and a UI dashboard for the board to visualize captured issues.",
  author: "Paperclip",
  categories: ["connector", "ui"],
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "agent.tools.register",
    "instance.settings.register",
    "ui.sidebar.register",
    "ui.page.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      authToken: {
        type: "string",
        title: "Sentry Auth Token",
        description: "Scoped API token from Sentry (org:read, project:read, event:read).",
        default: DEFAULT_CONFIG.authToken,
      },
      organizationSlug: {
        type: "string",
        title: "Organization Slug",
        description: "Your Sentry organization slug.",
        default: DEFAULT_CONFIG.organizationSlug,
      },
      projectSlug: {
        type: "string",
        title: "Project Slug",
        description: "Your Sentry project slug. Leave empty to query across all org projects.",
        default: DEFAULT_CONFIG.projectSlug,
      },
      sentryBaseUrl: {
        type: "string",
        title: "Sentry Base URL",
        description: "Base URL for Sentry API (self-hosted instances).",
        default: DEFAULT_CONFIG.sentryBaseUrl,
      },
    },
    required: ["authToken", "organizationSlug"],
  },
  tools: [
    {
      name: TOOL_NAMES.listIssues,
      displayName: "List Sentry Issues",
      description:
        "List recent Sentry issues filtered by project, level (error/warning/fatal), and status (resolved/unresolved).",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Sentry search query (e.g. 'is:unresolved level:error').",
          },
          project: {
            type: "string",
            description: "Project slug to filter by. Uses configured default if omitted.",
          },
          limit: {
            type: "number",
            description: "Max issues to return (default 25, max 100).",
          },
          sort: {
            type: "string",
            enum: ["date", "new", "freq", "priority"],
            description: "Sort order (default: date).",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.getIssue,
      displayName: "Get Sentry Issue Detail",
      description: "Get detailed information about a Sentry issue including stacktrace, recent events, and tags.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Sentry issue ID.",
          },
        },
        required: ["issueId"],
      },
    },
    {
      name: TOOL_NAMES.search,
      displayName: "Search Sentry Errors",
      description: "Search Sentry errors by query string (message, tag, fingerprint, etc.).",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Free-text search query.",
          },
          level: {
            type: "string",
            enum: ["fatal", "error", "warning", "info", "debug"],
            description: "Filter by error level.",
          },
          dateRange: {
            type: "string",
            description: "Time range (e.g. '24h', '7d', '30d'). Default: 24h.",
          },
          limit: {
            type: "number",
            description: "Max results (default 25, max 100).",
          },
        },
        required: ["query"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Sentry Errors",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Sentry Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Sentry Errors",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "Sentry",
        exportName: EXPORT_NAMES.sidebar,
      },
    ],
  },
};

export default manifest;
