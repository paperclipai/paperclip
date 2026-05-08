import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-github-sync",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub Sync",
  description: "One-way Paperclip → GitHub issue mirror with goal-subtree filtering",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "http.outbound",
    "goals.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["repo", "secretRef"],
    properties: {
      repo: {
        type: "string",
        description: "GitHub repository in owner/repo format (e.g. acme/my-repo)",
        pattern: "^[^/]+/[^/]+$",
      },
      host: {
        type: "string",
        description: "GitHub host — github.com or a GitHub Enterprise hostname",
        default: "github.com",
      },
      secretRef: {
        type: "string",
        description: "Reference key for the GitHub token stored in Paperclip secrets",
      },
      syncedGoalIds: {
        type: "array",
        items: { type: "string" },
        description: "Goal IDs whose issue subtrees are eligible for sync. Empty array syncs all goals.",
        default: [],
      },
      dryRun: {
        type: "boolean",
        description: "When true, log sync actions without making any GitHub API calls",
        default: true,
      },
    },
    additionalProperties: false,
  },
};

export default manifest;
