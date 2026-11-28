import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "basicolabs.codex-quota-router",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Codex Quota Router",
  description: "Selects an authorized Codex account using its observed quota, with task pinning managed by Paperclip.",
  author: "BasicoLabs",
  categories: ["connector"],
  capabilities: ["ai.connections.route"],
  aiConnectionRouter: {
    name: "Codex quota pool",
    description: "Route new tasks between saved Codex subscriptions using a 10% reserve.",
  },
  entrypoints: { worker: "./dist/worker.js" },
};

export default manifest;
