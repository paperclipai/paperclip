import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  JOB_KEYS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  TOOL_NAMES,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Linear Sync",
  description:
    "Bidirectional sync between Linear (DAN-xxx issues) and Paperclip. " +
    "Polls Linear for open issues, creates Paperclip tasks for the CEO to dispatch, " +
    "and pushes status updates back when agents complete work.",
  author: "Dan Izhaky",
  categories: ["connector", "automation"],
  capabilities: [
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    "events.subscribe",
    "jobs.schedule",
    "webhooks.receive",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "agent.tools.register",
    "agents.read",
    "companies.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      linearApiKey: {
        type: "string",
        title: "Linear API Key (secret ref)",
        description: "Reference to the Linear API key secret",
        default: "env:LINEAR_API_KEY",
      },
      teamId: {
        type: "string",
        title: "Linear Team ID",
        default: "f741ad5a-88f7-4fa5-8adc-ff95d065fd3a",
      },
      syncIntervalMinutes: {
        type: "number",
        title: "Sync interval (minutes)",
        default: 10,
      },
      enableOutboundSync: {
        type: "boolean",
        title: "Push status changes back to Linear",
        default: true,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.inboundSync,
      displayName: "Linear Inbound Sync",
      description:
        "Polls Linear for new and updated issues in Dan's Projects team. " +
        "Creates or updates corresponding Paperclip issues.",
      schedule: "*/10 * * * *",
    },
    {
      jobKey: JOB_KEYS.outboundSync,
      displayName: "Linear Outbound Sync",
      description:
        "Pushes Paperclip issue status changes back to Linear.",
      schedule: "*/5 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.linearEvents,
      displayName: "Linear Events",
      description:
        "Receives webhook events from Linear (issue created, updated, etc.).",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.queryLinear,
      displayName: "Query Linear Issues",
      description:
        "Query open Linear issues in Dan's Projects team. " +
        "Returns issues with title, status, priority, labels, and assignee.",
      parametersSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by status: backlog, todo, in_progress, done",
          },
          label: {
            type: "string",
            description: "Filter by label name (e.g., Accounting, Infrastructure)",
          },
          limit: {
            type: "number",
            description: "Max issues to return (default 20)",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.updateLinear,
      displayName: "Update Linear Issue",
      description:
        "Update a Linear issue's status, add a comment, or change assignee.",
      parametersSchema: {
        type: "object",
        properties: {
          linearId: {
            type: "string",
            description: "Linear issue identifier (e.g., DAN-123)",
          },
          status: {
            type: "string",
            description: "New status: backlog, in_progress, done, cancelled",
          },
          comment: {
            type: "string",
            description: "Comment to add to the issue",
          },
        },
        required: ["linearId"],
      },
    },
  ],
};

export default manifest;
