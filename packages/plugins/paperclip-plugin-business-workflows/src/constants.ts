export const PLUGIN_ID = "paperclipai.business-workflows";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "business-workflows";

export const SLOT_IDS = {
  page: "business-workflows-page",
  dashboardWidget: "business-workflows-widget",
} as const;

export const EXPORT_NAMES = {
  page: "BusinessWorkflowsPage",
  dashboardWidget: "BusinessWorkflowsDashboardWidget",
} as const;

export const DATA_KEYS = {
  overview: "overview",
} as const;

export const LEAD_STAGES = ["new", "qualified", "nurture", "proposal", "negotiation", "won", "lost"] as const;
export const EMAIL_TONES = ["helpful", "direct", "warm"] as const;
export const DEFAULT_MISSION_CONTROL_LANES = ["Revenue", "Content", "Operations", "Product"] as const;

export const ACTION_KEYS = {
  ingestMeetingTranscript: "ingest-meeting-transcript",
  generateProposalDraft: "generate-proposal-draft",
  ingestLead: "ingest-lead",
  queueContentRepurpose: "queue-content-repurpose",
  generateDailyBrief: "generate-daily-brief",
  ingestEmailThread: "ingest-email-thread",
  generateEmailReply: "generate-email-reply",
  ingestCalendarEvent: "ingest-calendar-event",
  planFocusBlocks: "plan-focus-blocks",
  updateLeadPipeline: "update-lead-pipeline",
  generateContentCampaign: "generate-content-campaign",
  launchMissionControl: "launch-mission-control",
  runPipelineWatchdog: "run-pipeline-watchdog",
} as const;

export const TOOL_KEYS = {
  proposalDraftFromNotes: "proposal-draft-from-notes",
  dailyBriefSummary: "daily-brief-summary",
  emailReplyFromThread: "email-reply-from-thread",
  contentCampaignPack: "content-campaign-pack",
  missionControlSnapshot: "mission-control-snapshot",
} as const;

export const JOB_KEYS = {
  dailyBrief: "daily-brief",
  pipelineWatchdog: "pipeline-watchdog",
} as const;

export const WEBHOOK_KEYS = {
  workflowIngest: "workflow-ingest",
} as const;

export const STATE_KEYS = {
  records: "workflow-records",
  latestDailyBrief: "latest-daily-brief",
  latestProposalDraft: "latest-proposal-draft",
  latestEmailReply: "latest-email-reply",
  latestFocusPlan: "latest-focus-plan",
  latestMissionControlPlan: "latest-mission-control-plan",
  latestContentCampaign: "latest-content-campaign",
  latestWatchdogReport: "latest-watchdog-report",
  leadPipeline: "lead-pipeline",
} as const;

export const DOCUMENT_KEYS = {
  meetingTranscript: "meeting-transcript",
  proposalDraft: "proposal-draft",
  leadNotes: "lead-notes",
  leadPipeline: "lead-pipeline",
  emailThread: "email-thread",
  emailReply: "email-reply",
  calendarEvent: "calendar-event",
  focusPlan: "focus-plan",
  missionControlPlan: "mission-control-plan",
  contentCampaign: "content-campaign",
} as const;

export const DEFAULT_CONFIG = {
  defaultProjectId: "",
  autoCreateMeetingTasks: true,
  autoAttachProposalDraft: true,
  autoCreateCalendarTasks: true,
  autoCreateLeadFollowUps: true,
  defaultEmailTone: EMAIL_TONES[0],
  contentPlatforms: ["x", "linkedin", "newsletter"],
  missionControlLanes: [...DEFAULT_MISSION_CONTROL_LANES],
  maxStoredRecords: 40,
  dailyBriefIssueLimit: 20,
  focusBlockMinutes: 90,
  watchdogStaleIssueHours: 48,
} as const;