import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.github-issues",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub Issues Sync (Example)",
  description: "Reference connector that syncs Paperclip issue lifecycle updates to a GitHub repository.",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "jobs.schedule",
    "agent.tools.register",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.write",
    "activity.log.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js"
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "GitHub owner/org." },
      repo: { type: "string", description: "GitHub repository name." },
      tokenSecretRef: { type: "string", description: "Paperclip secret reference for a GitHub token." },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Optional default labels applied to synced GitHub issues."
      }
    },
    required: ["owner", "repo", "tokenSecretRef"]
  },
  jobs: [
    {
      jobKey: "github-backfill",
      displayName: "GitHub Backfill",
      description: "Periodically backfills GitHub issue state into plugin-owned state records.",
      schedule: "*/30 * * * *"
    }
  ],
  tools: [
    {
      name: "lookup-github-issue",
      displayName: "Lookup GitHub Issue",
      description: "Look up an issue in the configured GitHub repository.",
      parametersSchema: {
        type: "object",
        properties: {
          issueNumber: { type: "number" }
        },
        required: ["issueNumber"]
      }
    }
  ]
};

export default manifest;
