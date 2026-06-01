import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.event-waker";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Event Waker",
  description:
    "Wakes the assignee whenever an issue transitions to an actionable state. Replaces the external bash poller.",
  author: "Paperclip community",
  categories: ["automation"],
  capabilities: ["events.subscribe", "issues.read", "issues.wakeup"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      wakeOnTransitions: {
        type: "array",
        description:
          "Pairs of (prev, curr) status to wake on. Use '*' for any side. Default covers todo|in_progress|in_review|blocked starts and reassignments.",
        items: { type: "string" },
        default: [
          "*:todo",
          "*:in_progress",
          "*:in_review",
          "*:blocked",
          "blocked:todo",
          "blocked:in_progress",
        ],
      },
      debounceMs: {
        type: "integer",
        description:
          "Coalesce multiple state changes on the same issue within this window before waking. Defaults to 500ms.",
        default: 500,
        minimum: 0,
      },
      optOutAgentIds: {
        type: "array",
        description:
          "Agent IDs that should never be auto-woken by this plugin (e.g. agents on long backoff).",
        items: { type: "string" },
        default: [],
      },
    },
  },
};

export default manifest;
