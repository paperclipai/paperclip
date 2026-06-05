import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION, JOB_KEYS, TOOL_NAMES } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GovBids Pipeline",
  description:
    "Automated government bid opportunity pipeline for ConsultAdd Public Services. Fetches, filters, and scores state & local contract opportunities from HigherGov, creates Paperclip issues for qualified bids, and pushes approved ones to HubSpot.",
  author: "ConsultAdd",
  categories: ["automation", "connector"],

  capabilities: [
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "issue.documents.read",
    "issue.documents.write",
    "agents.read",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "agent.tools.register",
    "activity.log.write",
    "metrics.write",
  ],

  entrypoints: {
    worker: "./dist/worker.js",
  },

  instanceConfigSchema: {
    type: "object",
    properties: {
      higherGovApiKeyRef: {
        type: "string",
        title: "HigherGov API Key (Secret Reference)",
        description: "Reference to the company secret containing the HigherGov API key",
      },
      claudeApiKeyRef: {
        type: "string",
        title: "Anthropic API Key (Secret Reference)",
        description: "Reference to the company secret containing the Claude API key for LLM scoring",
      },
      hubspotApiKeyRef: {
        type: "string",
        title: "HubSpot API Key (Secret Reference)",
        description: "Reference to the company secret containing the HubSpot API key",
      },
      minQualificationScore: {
        type: "number",
        title: "Minimum Qualification Score",
        description: "Opportunities below this score will not create issues (0-100)",
        default: 60,
      },
      dailyScanEnabled: {
        type: "boolean",
        title: "Enable Daily Scan",
        description: "Automatically scan for new opportunities daily at 6 AM",
        default: true,
      },
      projectId: {
        type: "string",
        title: "Project ID",
        description: "Paperclip project to create opportunity issues in",
      },
      parentIssueId: {
        type: "string",
        title: "Parent Issue ID",
        description: "Optional parent issue ID for organizing opportunity issues",
      },
    },
    required: ["higherGovApiKeyRef", "claudeApiKeyRef"],
  },

  jobs: [
    {
      jobKey: JOB_KEYS.dailyScan,
      displayName: "Daily Opportunity Scan",
      description:
        "Fetches new state & local government bid opportunities from HigherGov, scores them against ConsultAdd's capabilities, and creates Paperclip issues for qualified bids.",
      schedule: "0 6 * * *",
    },
  ],

  tools: [
    {
      name: TOOL_NAMES.searchOpportunities,
      displayName: "Search Government Opportunities",
      description:
        "Search HigherGov for state & local contract opportunities matching ConsultAdd's service areas.",
      parametersSchema: {
        type: "object",
        properties: {
          keywords: {
            type: "string",
            description: "Search keywords (e.g., 'cybersecurity', 'managed services')",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of results to return",
            default: 20,
          },
        },
        required: ["keywords"],
      },
    },
    {
      name: TOOL_NAMES.scoreOpportunity,
      displayName: "Score Government Opportunity",
      description:
        "Score a single opportunity against ConsultAdd's qualification rubric (0-100).",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Paperclip issue ID containing opportunity data to score",
          },
        },
        required: ["issueId"],
      },
    },
    {
      name: TOOL_NAMES.pushToHubspot,
      displayName: "Push Opportunity to HubSpot",
      description:
        "Push a qualified opportunity to HubSpot as a Deal in the Government Opportunities pipeline.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Paperclip issue ID containing the opportunity to push",
          },
        },
        required: ["issueId"],
      },
    },
    {
      name: TOOL_NAMES.getOpportunitySummary,
      displayName: "Get Opportunity Pipeline Summary",
      description:
        "Get a summary of recent pipeline runs, qualification stats, and current API quota usage.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
};

export default manifest;
