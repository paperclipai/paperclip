export const PLUGIN_ID = "paperclip.observability";
export const PLUGIN_VERSION = "0.1.0";

export const JOB_KEYS = {
  collectMetrics: "collect-metrics",
} as const;

export const METRIC_NAMES = {
  agentRunDuration: "paperclip.agent.run.duration_ms",
  agentRunErrors: "paperclip.agent.run.errors",
  tokensInput: "paperclip.tokens.input",
  tokensOutput: "paperclip.tokens.output",
  costCents: "paperclip.cost.cents",
  issueTransitions: "paperclip.issue.transitions",
  agentStatusChanges: "paperclip.agent.status_changes",
  approvalsDecided: "paperclip.approvals.decided",
  eventsTotal: "paperclip.events.total",
} as const;
