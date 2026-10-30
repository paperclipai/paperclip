import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.workspace-diff";
const CHANGES_TAB_SLOT_ID = "workspace-changes-tab";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Workspace Changes",
  description: "Adds a Changes tab to execution and project workspaces using plugin-local Git diff computation and @pierre/diffs.",
  author: "Paperclip",
  categories: ["workspace", "ui"],
  capabilities: [
    "ui.detailTab.register",
    "execution.workspaces.read",
    "project.workspaces.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "detailTab",
        id: CHANGES_TAB_SLOT_ID,
        displayName: "Changes",
        exportName: "ChangesTab",
        entityTypes: ["execution_workspace", "project_workspace"],
        order: 25,
      },
    ],
  },
};

export default manifest;
