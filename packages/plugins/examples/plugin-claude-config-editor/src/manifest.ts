import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-claude-config-editor",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Claude Config Editor",
  description:
    "Allows instance admins to edit Claude Code configuration files (.claude.json and .credentials.json) through the Paperclip settings UI.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: ["instance.settings.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "claude-config-settings-page",
        displayName: "Claude Config",
        exportName: "ClaudeConfigSettingsPage",
      },
    ],
  },
};

export default manifest;
