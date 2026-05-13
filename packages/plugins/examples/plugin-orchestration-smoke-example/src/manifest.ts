import type { OdysseusPluginManifestV1 } from "@odysseus/plugin-sdk";

const manifest: OdysseusPluginManifestV1 = {
  id: "odysseus.plugin-orchestration-smoke-example",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Plugin Orchestration Smoke Example",
  description: "First-party smoke plugin that exercises Odysseus orchestration-grade plugin APIs.",
  author: "Odysseus",
  categories: ["automation", "ui"],
  capabilities: [
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "issues.read",
    "issues.create",
    "issues.wakeup",
    "issue.relations.read",
    "issue.relations.write",
    "issue.documents.read",
    "issue.documents.write",
    "issue.subtree.read",
    "issues.orchestration.read",
    "ui.dashboardWidget.register",
    "ui.detailTab.register",
    "instance.settings.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  database: {
    namespaceSlug: "orchestration_smoke",
    migrationsDir: "migrations",
    coreReadTables: ["issues"]
  },
  apiRoutes: [
    {
      routeKey: "initialize",
      method: "POST",
      path: "/issues/:issueId/smoke",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "required-for-agent-in-progress",
      companyResolution: { from: "issue", param: "issueId" }
    },
    {
      routeKey: "summary",
      method: "GET",
      path: "/issues/:issueId/smoke",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "issue", param: "issueId" }
    }
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Orchestration Smoke Health",
        exportName: "DashboardWidget"
      },
      {
        type: "taskDetailView",
        id: "issue-panel",
        displayName: "Orchestration Smoke",
        exportName: "IssuePanel",
        entityTypes: ["issue"]
      },
      {
        type: "settingsPage",
        id: "settings",
        displayName: "Orchestration Smoke",
        exportName: "SettingsPage"
      }
    ]
  }
};

export default manifest;
