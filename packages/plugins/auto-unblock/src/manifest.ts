import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.auto-unblock";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Auto-Unblock (Child Done \u2192 Unblock Parent)",
  description:
    "Automatically unblocks a parent issue when all its child issues are resolved (done or cancelled).",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issues.update",
    "issue.comments.create",
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {},
  },
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
