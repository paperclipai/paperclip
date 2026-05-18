import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kkroo.ccrotate";
export const PLUGIN_VERSION = "0.4.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "ccrotate",
  description:
    "Visualize Claude Code and Codex accounts snapped by ccrotate. Persists the latest export to plugin state so Job pods can re-import it on preRun.",
  author: "kkroo",
  categories: ["automation", "connector"],
  capabilities: [
    "api.routes.register",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  apiRoutes: [
    {
      routeKey: "snapshot",
      method: "GET",
      path: "/snapshot",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "refresh",
      method: "POST",
      path: "/refresh",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "state-get",
      method: "GET",
      path: "/state",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "state-put",
      method: "POST",
      path: "/state",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "import",
      method: "POST",
      path: "/import",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
};

export default manifest;
