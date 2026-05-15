import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-clarifier-example",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Clarifier",
  description:
    "Tier-0 structural pre-filter that decides whether an issue is eligible for clarification. " +
    "Subscribes to issue comments, status changes, and run completions; persists eligibility verdicts " +
    "to the plugin namespace for the LLM tier to consume.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issue.comments.read",
    "issue.relations.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "clarifier",
    migrationsDir: "migrations",
    coreReadTables: ["issues", "issue_comments"],
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Clarifier Health",
        exportName: "DashboardWidget",
      },
    ],
  },
};

export default manifest;
