import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip-issue-linker-example";
const TOOLBAR_SLOT_ID = "issue-linker-toolbar-button";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Issue Linker (Example)",
  description: "Adds a toolbar button to issue detail that lets you search for and link a related issue as a blocker.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: [
    "ui.action.register",
    "issues.read",
    "issue.relations.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "toolbarButton",
        id: TOOLBAR_SLOT_ID,
        displayName: "Link related issue",
        exportName: "IssueLinkerToolbarButton",
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
