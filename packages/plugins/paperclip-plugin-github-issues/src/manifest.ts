import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-github-issues",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub Issues",
  description:
    "Bridges GitHub issues, comments, PRs and CI runs into Paperclip tasks with idempotent dedup",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "webhooks.receive",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.create",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  webhooks: [
    {
      endpointKey: "github",
      displayName: "GitHub Issues / PRs / CI",
      description:
        "Receives issues, issue_comment, pull_request, workflow_run from GitHub",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    required: ["hmacSecret", "ceoAgentId", "companyId", "repoToProject"],
    properties: {
      hmacSecret: {
        type: "string",
        description: "GitHub webhook HMAC secret",
      },
      ceoAgentId: {
        type: "string",
        description: "Agent that receives newly opened issues",
      },
      labelGate: {
        type: "string",
        default: "agent-eligible",
      },
      repoToProject: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Map of org/repo -> Paperclip projectId",
      },
      companyId: {
        type: "string",
        description: "Paperclip company id for created issues",
      },
    },
  },
};

export default manifest;
