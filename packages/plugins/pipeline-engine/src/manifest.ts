import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.pipeline-engine",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Pipeline Engine",
  description: "Deterministic pipeline engine for orchestrating agent work.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "events.emit",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.relations.read",
    "issue.relations.write",
    "issue.documents.read",
    "issue.documents.write",
    "issue.subtree.read",
    "issue.comments.read",
    "issue.comments.create",
    "issues.wakeup",
    "issues.orchestration.read",
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "plugin.state.read",
    "plugin.state.write",
    "agents.read",
    "ui.page.register",
    "ui.detailTab.register",
    "ui.sidebar.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      role_mapping: {
        type: "object",
        title: "Role to Agent Mapping",
        description: "Maps agent roles to agent UUIDs",
        additionalProperties: { type: "string" },
      },
      trigger_labels: {
        type: "object",
        title: "Trigger Label Mapping",
        description: "Maps label names to pipeline definition names",
        additionalProperties: { type: "string" },
      },
    },
    required: ["trigger_labels"],
  },
  apiRoutes: [
    { routeKey: "run-status", method: "GET", path: "/runs/:runId", auth: "board-or-agent", capability: "api.routes.register" },
    { routeKey: "pipelines", method: "GET", path: "/pipelines", auth: "board-or-agent", capability: "api.routes.register" },
  ],
  database: {
    namespaceSlug: "pipeline_engine",
    migrationsDir: "migrations",
    coreReadTables: ["issues"],
  },
  ui: {
    slots: [
      { type: "page", id: "pipelines-page", displayName: "Pipelines", exportName: "PipelinesPage", routePath: "pipelines" },
      { type: "detailTab", id: "pipeline-runs-tab", displayName: "Pipeline Runs", exportName: "PipelineRunsTab", entityTypes: ["issue"] },
      { type: "sidebar", id: "pipelines-sidebar", displayName: "Pipelines", exportName: "PipelinesSidebar" },
      { type: "dashboardWidget", id: "pipeline-health", displayName: "Pipeline Health", exportName: "PipelineHealthWidget" },
    ],
  },
};

export default manifest;
