import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Cost Clipper",
  description:
    "Anomaly-aware cost watchdog: watches the cost-event stream, flags runaway spend per agent/model, and leaves a breadcrumb on the offending issue. The Cost lens of the Ops Command Center.",
  author: "Paperclip Ops Command Center",
  categories: ["automation", "ui"],
  capabilities: [
    "events.subscribe",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "metrics.write",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      minSamples: {
        type: "integer",
        title: "Minimum samples before z-score fires",
        description: "Cost events required for an agent before the statistical spike rule activates.",
        minimum: 2,
        default: DEFAULT_CONFIG.minSamples,
      },
      zThreshold: {
        type: "number",
        title: "Z-score threshold",
        description: "Standard deviations above an agent's rolling mean that count as a spike.",
        minimum: 1,
        default: DEFAULT_CONFIG.zThreshold,
      },
      absoluteCentsCeiling: {
        type: "integer",
        title: "Absolute single-event ceiling (cents)",
        description: "Any single cost event at or above this trips an anomaly regardless of history.",
        minimum: 1,
        default: DEFAULT_CONFIG.absoluteCentsCeiling,
      },
      commentOnAnomaly: {
        type: "boolean",
        title: "Comment on offending issue",
        description: "Post an attribution comment on the issue a spiking cost event belongs to.",
        default: DEFAULT_CONFIG.commentOnAnomaly,
      },
    },
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Cost Clipper",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
    ],
  },
};

export default manifest;
