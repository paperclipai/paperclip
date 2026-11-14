import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-ai-connection-router",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Reference AI connection router",
  description: "Open-source reference router for AI connection pools: round robin, usage threshold and learned provider-quota cool-downs.",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: ["ai.connections.route", "events.subscribe", "plugin.state.read", "plugin.state.write"],
  aiConnectionRouter: {
    name: "AI connection pool (reference)",
    description: "Rotate new tasks across saved AI accounts, skip accounts near or at their usage limits, and keep each task on its pinned account.",
  },
  entrypoints: { worker: "./dist/worker.js" },
};

export default manifest;
