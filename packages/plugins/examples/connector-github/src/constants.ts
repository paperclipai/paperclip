export const PLUGIN_ID = "paperclip-connector-github";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  github: "github-events",
} as const;

// State namespace prefix for all persisted mapping keys
export const STATE_NS = "github";

// Echo-dedup TTL in milliseconds (30 seconds)
export const ECHO_TTL_MS = 30_000;

// Mapping of GitHub issue/PR actions to Paperclip issue statuses
export const GH_CLOSED_STATUSES = new Set(["closed", "deleted"]);

// GitHub event names sent in the X-GitHub-Event header
export const GH_EVENTS = {
  issues: "issues",
  issueComment: "issue_comment",
  milestone: "milestone",
  pullRequest: "pull_request",
  pullRequestReview: "pull_request_review",
  push: "push",
} as const;

// Label prefix used to encode Paperclip priority on GitHub issues.
// e.g. "priority:high" maps to IssuePriority "high".
export const PRIORITY_LABEL_PREFIX = "priority:";

// Map from Paperclip IssuePriority → GitHub label name
export const PRIORITY_TO_LABEL: Record<string, string> = {
  critical: "priority:critical",
  high: "priority:high",
  medium: "priority:medium",
  low: "priority:low",
};

// Map from GitHub label name → Paperclip IssuePriority
export const LABEL_TO_PRIORITY: Record<string, string> = {
  "priority:critical": "critical",
  "priority:high": "high",
  "priority:medium": "medium",
  "priority:low": "low",
};

export const SLOT_IDS = {
  settingsPage: "connector-github-settings",
} as const;

export const EXPORT_NAMES = {
  settingsPage: "GitHubConnectorSettingsPage",
} as const;
