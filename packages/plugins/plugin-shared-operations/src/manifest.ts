import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-shared-operations";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Shared Operations",
  description: "Central instructions, sourced memory, bounded decisions and controlled policy improvement.",
  author: "Community",
  categories: ["automation", "ui"],
  capabilities: [
    "api.routes.register", "database.namespace.migrate", "database.namespace.read",
    "database.namespace.write", "issues.read", "agents.read", "ui.page.register",
    "ui.sidebar.register", "activity.log.write",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "shared_operations", migrationsDir: "migrations", coreReadTables: ["companies", "issues"] },
  apiRoutes: [
    { routeKey: "overview", method: "GET", path: "/overview", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "command", method: "POST", path: "/commands", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "instructions", method: "GET", path: "/instructions", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "task-head", method: "GET", path: "/tasks/:taskId/context-head", auth: "board-or-agent", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
  ],
  ui: { slots: [
    { type: "sidebar", id: "operations-sidebar", displayName: "Shared Operations", exportName: "SidebarLink", order: 36 },
    { type: "page", id: "operations-page", displayName: "Shared Operations", exportName: "ControlPage", routePath: "shared-operations" },
  ] },
};

export default manifest;
