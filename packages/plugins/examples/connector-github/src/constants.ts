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
  pullRequest: "pull_request",
  pullRequestReview: "pull_request_review",
  push: "push",
} as const;

export const SLOT_IDS = {
  settingsPage: "connector-github-settings",
} as const;

export const EXPORT_NAMES = {
  settingsPage: "GitHubConnectorSettingsPage",
} as const;
