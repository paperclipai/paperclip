import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.agent-token-monitor";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Agent Token Monitor",
  description:
    "Surfaces per-agent monthly token totals and a per-run cost view as a dashboard widget and a dedicated page.",
  author: "Paperclip",
  categories: ["ui", "automation"],
  capabilities: [
    "agents.read",
    "database.namespace.read",
    "api.routes.register",
    "ui.dashboardWidget.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    migrationsDir: "migrations",
    coreReadTables: ["cost_events", "heartbeat_runs", "agents"],
  },
  apiRoutes: [
    {
      routeKey: "token-totals",
      method: "GET",
      path: "/token-totals",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "runs",
      method: "GET",
      path: "/runs",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "token-totals-widget",
        displayName: "Agent Token Totals",
        exportName: "TokenTotalsWidget",
      },
      {
        type: "page",
        id: "runs-page",
        displayName: "Agent Runs",
        exportName: "RunsPage",
        routePath: "agent-runs",
      },
      {
        type: "sidebar",
        id: "runs-sidebar",
        displayName: "Agent Runs",
        exportName: "RunsSidebarLink",
      },
    ],
  },
};

export default manifest;
