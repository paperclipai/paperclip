import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.dark-factory-bridge-example",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Dark Factory Bridge Projection Example",
  description: "Mock bridge plugin that displays Dark Factory projection, cursor, provider health, and rehydrate receipts without becoming an authoritative execution record.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "issues.read",
    "ui.dashboardWidget.register",
    "ui.detailTab.register",
    "instance.settings.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  database: {
    namespaceSlug: "dark_factory_bridge_poc",
    migrationsDir: "migrations",
    coreReadTables: ["issues"]
  },
  apiRoutes: [
    {
      routeKey: "projection",
      method: "GET",
      path: "/issues/:issueId/dark-factory/projection",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "issue", param: "issueId" }
    },
    {
      routeKey: "journal-cursor",
      method: "GET",
      path: "/issues/:issueId/dark-factory/journal-cursor",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "issue", param: "issueId" }
    },
    {
      routeKey: "provider-health",
      method: "GET",
      path: "/issues/:issueId/dark-factory/provider-health",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "issue", param: "issueId" }
    },
    {
      routeKey: "rehydrate-request",
      method: "POST",
      path: "/issues/:issueId/dark-factory/rehydrate-request",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "issue", param: "issueId" }
    }
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "dark-factory-provider-health",
        displayName: "Dark Factory Provider Health",
        exportName: "DashboardWidget"
      },
      {
        type: "taskDetailView",
        id: "dark-factory-projection",
        displayName: "Dark Factory Projection",
        exportName: "IssuePanel",
        entityTypes: ["issue"]
      },
      {
        type: "settingsPage",
        id: "settings",
        displayName: "Dark Factory Bridge",
        exportName: "SettingsPage"
      }
    ]
  }
};

export default manifest;
