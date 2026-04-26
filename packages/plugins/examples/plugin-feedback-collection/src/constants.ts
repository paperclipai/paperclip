export const PLUGIN_ID = "paperclip.feedback-collection";
export const PLUGIN_VERSION = "0.1.0";

export const TOOL_NAMES = {
  INGEST_FEEDBACK: "ingest_feedback",
} as const;

export const WEBHOOK_KEYS = {
  JIRA: "jira",
  BITBUCKET: "bitbucket",
  SLACK: "slack",
} as const;

export type FeedbackSource = "jira" | "bitbucket" | "slack";
