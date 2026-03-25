import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, PLUGIN_ID, PLUGIN_VERSION, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GitHub",
  description:
    "GitHub integration for Paperclip. Phase 1: receives GitHub Actions webhook events (workflow_run, check_run) and creates Paperclip issues on CI failures. Phase 2: bidirectional issue sync, status bridging, and agent tools for searching and linking GitHub issues.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "webhooks.receive",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "agents.read",
    "agents.invoke",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      webhookSecret: {
        type: "string",
        title: "GitHub Webhook Secret",
        description:
          "Shared secret for HMAC-SHA256 signature verification of incoming GitHub webhooks.",
        default: DEFAULT_CONFIG.webhookSecret,
      },
      companyId: {
        type: "string",
        title: "Company ID",
        description: "Paperclip company ID where failure issues are created.",
        default: DEFAULT_CONFIG.companyId,
      },
      goalId: {
        type: "string",
        title: "Goal ID",
        description: "Goal to associate CI failure issues with.",
        default: DEFAULT_CONFIG.goalId,
      },
      defaultAssigneeAgentId: {
        type: "string",
        title: "Default Assignee Agent ID",
        description:
          "Agent to assign CI failure issues to when the committing agent cannot be determined.",
        default: DEFAULT_CONFIG.defaultAssigneeAgentId,
      },
      defaultRepo: {
        type: "string",
        title: "Default Repository",
        description:
          "Default GitHub repository in owner/repo format for agent tools and issue references.",
        default: DEFAULT_CONFIG.defaultRepo,
      },
      githubTokenRef: {
        type: "string",
        title: "GitHub Token Secret Ref",
        description:
          "Paperclip secret reference name (or ID) for a GitHub Personal Access Token with repo scope. Required for GitHub API calls (search, sync, agent tools).",
        default: DEFAULT_CONFIG.githubTokenRef,
      },
      syncDirection: {
        type: "string",
        title: "Sync Direction",
        enum: ["bidirectional", "github-to-paperclip", "paperclip-to-github"],
        description:
          "Direction of issue state synchronisation when a GitHub link is active.",
        default: DEFAULT_CONFIG.syncDirection,
      },
      syncComments: {
        type: "boolean",
        title: "Sync Comments",
        description: "When enabled, new GitHub comments are mirrored to linked Paperclip issues.",
        default: DEFAULT_CONFIG.syncComments,
      },
      skipSignatureVerification: {
        type: "boolean",
        title: "Skip Signature Verification",
        description: "Development only — skip GitHub webhook HMAC verification.",
        default: DEFAULT_CONFIG.skipSignatureVerification,
      },
    },
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.github,
      displayName: "GitHub Events",
      description:
        "Receives workflow_run and check_run events from GitHub. Configure your GitHub repo webhook to POST to this endpoint.",
    },
  ],
};

export default manifest;
