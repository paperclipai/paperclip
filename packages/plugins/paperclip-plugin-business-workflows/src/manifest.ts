import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EMAIL_TONES,
  EXPORT_NAMES,
  JOB_KEYS,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_KEYS,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Business Workflows",
  description: "Operator workflow automation plugin for meetings, email, CRM, content operations, focus planning, and mission-control orchestration.",
  author: "Paperclip",
  categories: ["automation", "ui", "connector"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "goals.read",
    "goals.create",
    "issue.documents.read",
    "issue.documents.write",
    "agents.read",
    "agents.invoke",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "webhooks.receive",
    "metrics.write",
    "ui.page.register",
    "ui.dashboardWidget.register",
    "agent.tools.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      defaultProjectId: {
        type: "string",
        title: "Default Project ID",
        default: DEFAULT_CONFIG.defaultProjectId,
      },
      autoCreateMeetingTasks: {
        type: "boolean",
        title: "Auto-create meeting tasks",
        default: DEFAULT_CONFIG.autoCreateMeetingTasks,
      },
      autoAttachProposalDraft: {
        type: "boolean",
        title: "Attach proposal drafts to meeting issues",
        default: DEFAULT_CONFIG.autoAttachProposalDraft,
      },
      autoCreateCalendarTasks: {
        type: "boolean",
        title: "Auto-create calendar follow-up tasks",
        default: DEFAULT_CONFIG.autoCreateCalendarTasks,
      },
      autoCreateLeadFollowUps: {
        type: "boolean",
        title: "Auto-create lead follow-up tasks",
        default: DEFAULT_CONFIG.autoCreateLeadFollowUps,
      },
      defaultEmailTone: {
        type: "string",
        title: "Default email draft tone",
        enum: [...EMAIL_TONES],
        default: DEFAULT_CONFIG.defaultEmailTone,
      },
      contentPlatforms: {
        type: "array",
        title: "Default content platforms",
        items: { type: "string" },
        default: [...DEFAULT_CONFIG.contentPlatforms],
      },
      missionControlLanes: {
        type: "array",
        title: "Default mission-control lanes",
        items: { type: "string" },
        default: [...DEFAULT_CONFIG.missionControlLanes],
      },
      maxStoredRecords: {
        type: "number",
        title: "Max stored workflow records",
        default: DEFAULT_CONFIG.maxStoredRecords,
      },
      dailyBriefIssueLimit: {
        type: "number",
        title: "Daily brief open issue limit",
        default: DEFAULT_CONFIG.dailyBriefIssueLimit,
      },
      focusBlockMinutes: {
        type: "number",
        title: "Focus block duration (minutes)",
        default: DEFAULT_CONFIG.focusBlockMinutes,
      },
      watchdogStaleIssueHours: {
        type: "number",
        title: "Stale issue threshold (hours)",
        default: DEFAULT_CONFIG.watchdogStaleIssueHours,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.dailyBrief,
      displayName: "Daily Brief",
      description: "Generates a company-level daily brief for every available company.",
      schedule: "0 8 * * *",
    },
    {
      jobKey: JOB_KEYS.pipelineWatchdog,
      displayName: "Pipeline Watchdog",
      description: "Scans companies for blocked work, stale issues, and due follow-ups.",
      schedule: "0 */4 * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.workflowIngest,
      displayName: "Business Workflow Ingest",
      description: "Accepts meeting, email, calendar, lead, content, and mission-control ingestion payloads.",
    },
  ],
  tools: [
    {
      name: TOOL_KEYS.proposalDraftFromNotes,
      displayName: "Proposal Draft From Notes",
      description: "Generate a markdown proposal draft from meeting notes.",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          notes: { type: "string" },
        },
        required: ["title", "notes"],
      },
    },
    {
      name: TOOL_KEYS.dailyBriefSummary,
      displayName: "Daily Brief Summary",
      description: "Generate a daily brief summary for the current company.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: TOOL_KEYS.emailReplyFromThread,
      displayName: "Email Reply From Thread",
      description: "Generate an email reply draft from an email thread.",
      parametersSchema: {
        type: "object",
        properties: {
          subject: { type: "string" },
          thread: { type: "string" },
          senderName: { type: "string" },
          desiredOutcome: { type: "string" },
        },
        required: ["subject", "thread"],
      },
    },
    {
      name: TOOL_KEYS.contentCampaignPack,
      displayName: "Content Campaign Pack",
      description: "Generate a multi-platform campaign draft from source material.",
      parametersSchema: {
        type: "object",
        properties: {
          campaignName: { type: "string" },
          sourceTitle: { type: "string" },
          sourceSummary: { type: "string" },
          angle: { type: "string" },
          callToAction: { type: "string" },
          platforms: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["campaignName", "sourceTitle", "sourceSummary"],
      },
    },
    {
      name: TOOL_KEYS.missionControlSnapshot,
      displayName: "Mission Control Snapshot",
      description: "Return the latest mission-control plan or generate a company operating snapshot.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Business Workflows",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Business Workflows",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
    ],
  },
};

export default manifest;