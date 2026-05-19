import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.atlassian";
export const PLUGIN_VERSION = "0.1.0";

export const TOOL_NAMES = {
  getIssue: "jira.getIssue",
  transition: "jira.transition",
  assignIssue: "jira.assignIssue",
  getTransitions: "jira.getTransitions",
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Atlassian Jira",
  description:
    "Connects Paperclip to Atlassian Jira — inspect issues, drive transitions, and assign work via Jira REST API v3.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "agent.tools.register",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["jiraBaseUrl", "jiraUserEmail", "jiraApiTokenRef"],
    properties: {
      jiraBaseUrl: {
        type: "string",
        title: "Jira Base URL",
        description: "Your Atlassian instance base URL, e.g. https://yourorg.atlassian.net",
      },
      jiraUserEmail: {
        type: "string",
        title: "Jira User Email",
        description: "Email address of the Jira user used for API authentication.",
      },
      jiraApiTokenRef: {
        type: "string",
        title: "Jira API Token (Secret Reference)",
        description: "Reference to the Paperclip secret that holds your Jira API token.",
      },
      transitionMapping: {
        type: "object",
        title: "Transition Name Mapping",
        description:
          "Map logical transition names to Jira workflow transition IDs. E.g. { \"done\": \"21\", \"ready-for-release\": \"31\" }",
        additionalProperties: { type: "string" },
        default: {},
      },
    },
  },
  tools: [
    {
      name: TOOL_NAMES.getIssue,
      displayName: "Get Jira Issue",
      description:
        "Fetch a Jira issue by key. Returns key, summary, status, assignee, and available transitions.",
      parametersSchema: {
        type: "object",
        required: ["key"],
        properties: {
          key: {
            type: "string",
            description: "Jira issue key, e.g. PD-123",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.transition,
      displayName: "Transition Jira Issue",
      description:
        "Move a Jira issue to a new workflow status. Accepts either a numeric transition ID or a logical name defined in transitionMapping.",
      parametersSchema: {
        type: "object",
        required: ["key", "transition"],
        properties: {
          key: {
            type: "string",
            description: "Jira issue key, e.g. PD-123",
          },
          transition: {
            type: "string",
            description:
              "Transition ID (e.g. \"21\") or logical name from transitionMapping (e.g. \"done\")",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.assignIssue,
      displayName: "Assign Jira Issue",
      description: "Assign a Jira issue to a specific user by Atlassian account ID.",
      parametersSchema: {
        type: "object",
        required: ["key", "accountId"],
        properties: {
          key: {
            type: "string",
            description: "Jira issue key, e.g. PD-123",
          },
          accountId: {
            type: "string",
            description:
              "Atlassian account ID of the assignee, or null to unassign.",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.getTransitions,
      displayName: "Get Jira Transitions",
      description: "List the available workflow transitions for a Jira issue.",
      parametersSchema: {
        type: "object",
        required: ["key"],
        properties: {
          key: {
            type: "string",
            description: "Jira issue key, e.g. PD-123",
          },
        },
      },
    },
  ],
};

export default manifest;
