import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-bookmarks-example";
export const BOOKMARKS_FOLDER_KEY = "bookmarks-root";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Bookmarks (Example)",
  description:
    "First-party example plugin: company-scoped bookmark library backed by a plugin database namespace and a local markdown folder. Demonstrates scoped API routes, local folders, dashboard widget, and a plugin page.",
  author: "Paperclip",
  categories: ["workspace", "ui"],
  capabilities: [
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "local.folders",
    "companies.read",
    "ui.dashboardWidget.register",
    "ui.page.register",
    "ui.sidebar.register",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "bookmarks",
    migrationsDir: "migrations",
  },
  localFolders: [
    {
      folderKey: BOOKMARKS_FOLDER_KEY,
      displayName: "Bookmarks root",
      description:
        "Company-scoped local folder that stores one markdown file per bookmark. Each file uses YAML frontmatter for url, title, tags, and notes.",
      access: "readWrite",
      requiredDirectories: ["bookmarks"],
    },
  ],
  apiRoutes: [
    {
      routeKey: "list",
      method: "GET",
      path: "/bookmarks",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "create",
      method: "POST",
      path: "/bookmarks",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "delete",
      method: "DELETE",
      path: "/bookmarks/:slug",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "bookmarks-page",
        displayName: "Bookmarks",
        exportName: "BookmarksPage",
        routePath: "bookmarks",
      },
      {
        type: "sidebar",
        id: "bookmarks-sidebar-link",
        displayName: "Bookmarks",
        exportName: "BookmarksSidebarLink",
      },
      {
        type: "dashboardWidget",
        id: "bookmarks-widget",
        displayName: "Bookmarks",
        exportName: "BookmarksDashboardWidget",
      },
      {
        type: "settingsPage",
        id: "bookmarks-settings",
        displayName: "Bookmarks",
        exportName: "BookmarksSettingsPage",
      },
    ],
  },
};

export default manifest;
