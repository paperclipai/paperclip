import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kkroo.ccrotate";
export const PLUGIN_VERSION = "0.9.0";

// Slot + launcher constants. Kept here so manifest + UI exports stay in sync.
export const SLOT_IDS = {
  page: "ccrotate-page",
  sidebarPanel: "ccrotate-sidebar",
  settingsPage: "ccrotate-settings",
} as const;

export const EXPORT_NAMES = {
  page: "CcrotatePage",
  sidebarPanel: "CcrotateSidebarPanel",
  settingsPage: "CcrotateSettingsPage",
} as const;

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
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "ccrotate",
        exportName: EXPORT_NAMES.page,
      },
      {
        type: "sidebarPanel",
        id: SLOT_IDS.sidebarPanel,
        displayName: "ccrotate",
        exportName: EXPORT_NAMES.sidebarPanel,
      },
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "ccrotate",
        exportName: EXPORT_NAMES.settingsPage,
      },
    ],
    launchers: [
      {
        id: "ccrotate-nav",
        displayName: "ccrotate",
        description: "View the Claude / Codex account pool, refresh tier-cache, manage exports.",
        placementZone: "sidebar",
        action: {
          type: "navigate",
          target: `/plugins/${PLUGIN_ID}`,
        },
      },
    ],
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
    {
      routeKey: "switch",
      method: "POST",
      path: "/switch",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "set-session",
      method: "POST",
      path: "/set-session",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "clear-stale-tiers",
      method: "POST",
      path: "/clear-stale-tiers",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "refresh-one",
      method: "POST",
      path: "/refresh-one",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "codex-relogin",
      method: "POST",
      path: "/codex-relogin",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
};

export default manifest;
