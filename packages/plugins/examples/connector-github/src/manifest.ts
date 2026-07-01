import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { EXPORT_NAMES, PLUGIN_ID, PLUGIN_VERSION, SLOT_IDS, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GitHub Connector",
  description: "Bidirectional sync between GitHub issues/PRs and Paperclip issues, with webhook-triggered agent wakeups on PR reviews and pushes.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "webhooks.receive",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    "goals.read",
    "goals.create",
    "goals.update",
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "agents.invoke",
    "plugin.state.read",
    "plugin.state.write",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["webhookSecret", "owner", "repo"],
    properties: {
      webhookSecret: {
        type: "string",
        title: "Webhook Secret",
        description: "The secret used to sign GitHub webhook deliveries (X-Hub-Signature-256). Required.",
      },
      githubTokenRef: {
        type: "string",
        title: "GitHub Token Secret Reference",
        description: "Secret reference for a GitHub personal access token or app token used for outbound API calls.",
      },
      owner: {
        type: "string",
        title: "Repository Owner",
        description: "GitHub organisation or user name (e.g. 'acme-corp').",
      },
      repo: {
        type: "string",
        title: "Repository Name",
        description: "GitHub repository name (e.g. 'my-project').",
      },
      defaultProjectId: {
        type: "string",
        title: "Default Paperclip Project ID",
        description: "Paperclip project to create issues in when no project can be inferred from context.",
      },
      triggerAgentIds: {
        type: "array",
        title: "Trigger Agent IDs",
        description: "Agents to wake on pull_request_review and push events.",
        items: { type: "string" },
        default: [],
      },
      watchedRepos: {
        type: "array",
        title: "Watched Repositories",
        description: "Filter: only handle events from these repos (owner/repo). Empty = handle all configured repo.",
        items: { type: "string" },
        default: [],
      },
      prCreatesIssue: {
        type: "boolean",
        title: "PR creates Paperclip issue",
        description: "When true, a pull_request:opened event with no 'Fixes #N' link creates a new Paperclip issue. Default: false.",
        default: false,
      },
    },
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.github,
      displayName: "GitHub Events",
      description: "Receives issues, pull_request, issue_comment, milestone, pull_request_review, and push events from GitHub.",
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "GitHub Connector Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
    ],
  },
};

export default manifest;
