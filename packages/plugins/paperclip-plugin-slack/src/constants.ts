import type { SlackPluginConfig } from "./types.js";

export const PLUGIN_ID = "paperclip-plugin-slack";
export const PLUGIN_VERSION = "2.3.0";

export const ESCALATION_NEEDS_HUMAN_DECISION_EVENT =
  "issue.escalation.needs_human_decision" as const;

export const WEBHOOK_KEYS = {
  slackEvents: "slack-events",
  slashCommand: "slash-command",
  interactivity: "slack-interactivity",
} as const;

export const SLOT_IDS = {
  settingsPage: "slack-settings-page",
} as const;

export const EXPORT_NAMES = {
  settingsPage: "SlackSettingsPage",
} as const;

export const STATE_KEYS = {
  escalationRecord: (id: string) => `escalation-record-${id}`,
  escalationTs: (id: string) => `escalation-ts-${id}`,
  escalationChannel: (id: string) => `escalation-channel-${id}`,
  sessionRegistry: (ch: string, ts: string) => `sessions_${ch}_${ts}`,
  outputQueue: (ch: string, ts: string) => `output-queue_${ch}_${ts}`,
  msgAgent: (ch: string, ts: string) => `msg-agent-${ch}-${ts}`,
  activeDiscussion: (ch: string, ts: string) => `active-discussion-${ch}-${ts}`,
  discussion: (id: string) => `discussion_${id}`,
  handoff: (id: string) => `handoff-${id}`,
  slackChannel: "slack-channel",
  threadIssue: (id: string) => `thread-issue-${id}`,
  dailyCost: (date: string) => `daily-cost-${date}`,
  dailyAgentCosts: (date: string) => `daily-agent-costs-${date}`,
  firstRunNotified: (id: string) => `first-run-notified-${id}`,
  budgetAlert: (id: string, bucket: number) => `budget-alert-${id}-${bucket}`,
  humanDecisionEscalation: (issueId: string) =>
    `human-decision-escalation-${issueId}`,
  watchRegistry: (ch: string, ts: string) => `watches_${ch}_${ts}`,
  commandRegistry: "custom-commands",
  slackUser: (paperclipUserId: string) => `slack-user-${paperclipUserId}`,
  assigneeDmSent: (issueId: string, paperclipUserId: string) =>
    `assignee-dm-sent-${issueId}-${paperclipUserId}`,
  // Approval interaction (Phase 1): forward + reverse maps between a posted
  // approval card and its approval id, plus a one-shot resolution lock.
  approvalMessage: (approvalId: string) => `approval-msg-${approvalId}`,
  approvalByTs: (channel: string, ts: string) =>
    `approval-by-ts-${channel}-${ts}`,
  approvalResolved: (approvalId: string) => `approval-resolved-${approvalId}`,
  // Two-phase reaction resolve (BLO-8861): a reaction stages a *pending*
  // decision that is not committed to the host until the undo grace window
  // elapses. The index lets the every-minute commit job enumerate pending
  // decisions without a state prefix scan (mirrors escalation-records-index).
  approvalPending: (approvalId: string) => `approval-pending-${approvalId}`,
  approvalPendingIndex: "approval-pending-index",
} as const;

export const DEFAULT_CONFIG: SlackPluginConfig = {
  slackTokenRef: "",
  slackSigningSecretRef: "",
  slackUserTokenRef: "",
  companyId: "",
  defaultChannelId: "",
  approvalsChannelId: "",
  errorsChannelId: "",
  pipelineChannelId: "",
  escalationChatId: "",
  notifyOnIssueCreated: true,
  notifyOnIssueDone: true,
  notifyOnApprovalCreated: true,
  notifyOnAgentError: true,
  notifyOnAgentConnected: true,
  notifyOnBudgetThreshold: true,
  notifyAssigneeOnAssignment: true,
  enableDailyDigest: false,
  escalationTimeoutMs: 900000,
  escalationDedupeWindowMs: 3600000,
  escalationDefaultAction: "defer",
  escalationHoldMessage:
    "Your request has been escalated to a human agent. Please hold.",
  paperclipBaseUrl: "http://localhost:3100",
  maxAgentsPerThread: 5,
  approvalReactorSlackIds: [],
};
