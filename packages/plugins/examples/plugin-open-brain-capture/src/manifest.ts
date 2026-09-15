import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.open-brain-capture";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Open Brain Capture",
  description:
    "Automatically captures thoughts to open-brain when issues transition to key lifecycle states (done, blocked, delegated).",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issue.comments.read",
    "agents.read",
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      openBrainEndpoint: {
        type: "string",
        title: "Open Brain Endpoint",
        description: "Base URL of the open-brain MCP server (e.g. http://127.0.0.1:3010).",
      },
      openBrainApiKey: {
        type: "string",
        title: "Open Brain API Key",
        description: "Optional API key for authenticating with the open-brain endpoint.",
      },
      captureOnDone: {
        type: "boolean",
        title: "Capture on Done",
        description: "Capture a thought when an issue transitions to done.",
        default: true,
      },
      captureOnBlocked: {
        type: "boolean",
        title: "Capture on Blocked",
        description: "Capture a thought when an issue transitions to blocked.",
        default: true,
      },
      captureOnDelegation: {
        type: "boolean",
        title: "Capture on Delegation",
        description: "Capture a thought when a subtask is created with an assignee (delegation).",
        default: true,
      },
    },
  },
};

export default manifest;
