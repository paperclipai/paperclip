import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Issue Links",
  description: "Adds a local filesystem path and a GitHub PR URL field to every issue, visible inline in the issue detail view.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: [
    "issues.read",
    "plugin.state.read",
    "plugin.state.write",
    "instance.settings.register",
    "agent.tools.register",
    "ui.action.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      openWith: {
        type: "string",
        title: "Open local path with",
        enum: ["vscode", "finder"],
        default: DEFAULT_CONFIG.openWith,
        description: "Controls what happens when a local path is clicked. 'vscode' opens with VS Code, 'finder' opens with Finder.",
      },
    },
  },
  tools: [
    {
      name: TOOL_NAMES.setLocalPath,
      displayName: "Set Issue Local Path",
      description: "Set the local filesystem path for an issue. Use an absolute path such as /Users/me/projects/repo. Pass an empty string to clear the field.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The ID of the issue to update." },
          value: { type: "string", description: "Absolute local filesystem path, or empty string to clear." },
        },
        required: ["issueId", "value"],
      },
    },
    {
      name: TOOL_NAMES.setGithubPrUrl,
      displayName: "Set Issue GitHub PR URL",
      description: "Set the GitHub PR URL for an issue. Pass a full URL such as https://github.com/org/repo/pull/123. Pass an empty string to clear the field.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The ID of the issue to update." },
          value: { type: "string", description: "Full GitHub PR URL, or empty string to clear." },
        },
        required: ["issueId", "value"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "taskDetailView",
        id: SLOT_IDS.issueLinksView,
        displayName: "Issue Links",
        exportName: EXPORT_NAMES.issueLinksView,
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
