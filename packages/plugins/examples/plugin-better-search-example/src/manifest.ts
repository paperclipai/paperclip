import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip-better-search-example";
const SIDEBAR_SLOT_ID = "better-search-sidebar";
const PANEL_SLOT_ID = "better-search-panel";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Better Search (Example)",
  description:
    "Deep search across issue titles, descriptions, and comments with Human/AI author-type filtering.",
  author: "Paperclip",
  categories: ["workspace", "ui"],
  capabilities: [
    "ui.sidebar.register",
    "issues.read",
    "issue.comments.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: SIDEBAR_SLOT_ID,
        displayName: "Search",
        exportName: "BetterSearchSidebar",
      },
      {
        type: "sidebarPanel",
        id: PANEL_SLOT_ID,
        displayName: "Better Search",
        exportName: "BetterSearchPanel",
      },
    ],
  },
};

export default manifest;
