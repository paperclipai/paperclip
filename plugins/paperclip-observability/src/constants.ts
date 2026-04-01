export const PLUGIN_ID = "paperclip.observability";
export const PLUGIN_VERSION = "0.1.0";

export const JOB_KEYS = {
  collectMetrics: "collect-metrics",
} as const;

export const METRIC_NAMES = {
  agentRunDuration: "paperclip.agent.run.duration_ms",
  agentRunErrors: "paperclip.agent.run.errors",
  agentRunsStarted: "paperclip.agent.runs.started",
  tokensInput: "paperclip.tokens.input",
  tokensOutput: "paperclip.tokens.output",
  costCents: "paperclip.cost.cents",
  issuesCreated: "paperclip.issues.created",
  issueTransitions: "paperclip.issue.transitions",
  agentStatusChanges: "paperclip.agent.status_changes",
  approvalsCreated: "paperclip.approvals.created",
  approvalsDecided: "paperclip.approvals.decided",
  eventsTotal: "paperclip.events.total",
} as const;
