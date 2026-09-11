import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  PAGE_ROUTE,
  PAGE_SLOT_ID,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SIDEBAR_SLOT_ID,
} from "./constants.js";

/**
 * Adds an "Approvals" entry to the application sidebar (next to Inbox) and a
 * pending-approvals list page at `/:companyPrefix/approvals-menu`.
 *
 * Read capabilities are intentionally minimal: the UI reads approvals through
 * the same-origin board session, so the worker only exposes plugin config and
 * health. No approve/deny mutations in this iteration — users click through to
 * the core approval detail page.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Approvals Menu (Example)",
  description:
    "Adds an Approvals entry to the sidebar with a pending-count badge and a dedicated list page, similar to Inbox.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: [
    "companies.read",
    "plugin.state.read",
    "ui.sidebar.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      refreshIntervalSeconds: {
        type: "number",
        title: "Refresh Interval (seconds)",
        description:
          "How often the sidebar badge and list auto-refresh. 0 disables polling.",
        default: DEFAULT_CONFIG.refreshIntervalSeconds,
        minimum: 0,
        maximum: 3600,
      },
      showBadge: {
        type: "boolean",
        title: "Show Pending Count Badge",
        default: DEFAULT_CONFIG.showBadge,
      },
      listLimit: {
        type: "number",
        title: "List Row Limit",
        description:
          "Maximum pending approvals shown on the list page. The host approvals API does not accept a limit parameter, so this cap is applied client-side after the response.",
        default: DEFAULT_CONFIG.listLimit,
        minimum: 1,
        maximum: 500,
      },
    },
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: SIDEBAR_SLOT_ID,
        displayName: "Approvals",
        exportName: EXPORT_NAMES.sidebar,
        order: 20,
      },
      {
        type: "page",
        id: PAGE_SLOT_ID,
        displayName: "Approvals",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
    ],
  },
};

export default manifest;
