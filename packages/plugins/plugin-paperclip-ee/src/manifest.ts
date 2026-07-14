import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PAPERCLIP_EE_PLUGIN_ID = "paperclipai.paperclip-ee";

const manifest: PaperclipPluginManifestV1 = {
  id: PAPERCLIP_EE_PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Paperclip EE",
  description: "Enterprise administration for detailed company skill policy management.",
  author: "Paperclip",
  categories: ["ui", "automation"],
  capabilities: [
    "companies.read",
    "ui.page.register",
    "plugin.state.read",
    "plugin.state.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "page",
        id: "skill-policy-editor",
        displayName: "Paperclip EE",
        exportName: "SkillPolicyEditorPage",
        routePath: "paperclip-ee"
      }
    ]
  }
};

export default manifest;
