export const PLUGIN_ID = "paperclip-github";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  github: "github-events",
} as const;

export const SUPPORTED_GITHUB_EVENTS = [
  "workflow_run",
  "check_run",
  "issues",
  "pull_request",
] as const;

export type SupportedGitHubEvent = (typeof SUPPORTED_GITHUB_EVENTS)[number];

export const TOOL_NAMES = {
  searchIssues: "github_search_issues",
  linkIssue: "github_link_issue",
  unlinkIssue: "github_unlink_issue",
} as const;

export const JOB_KEYS = {
  syncLinkedIssues: "sync-linked-issues",
} as const;

export const DEFAULT_CONFIG = {
  webhookSecret: undefined,
  companyId: undefined,
  goalId: undefined,
  defaultAssigneeAgentId: undefined,
  defaultRepo: undefined,
  githubTokenRef: undefined,
  syncDirection: "bidirectional" as const,
  syncComments: false,
  skipSignatureVerification: false,
};

export type PluginConfig = {
  webhookSecret?: string;
  companyId?: string;
  goalId?: string;
  defaultAssigneeAgentId?: string;
  defaultRepo?: string;
  githubTokenRef?: string;
  syncDirection?: "bidirectional" | "github-to-paperclip" | "paperclip-to-github";
  syncComments?: boolean;
  skipSignatureVerification?: boolean;
};
