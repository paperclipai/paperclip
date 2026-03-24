export const PLUGIN_ID = "plugin-slack";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  SLACK_EVENTS: "slack-events",
} as const;

export const JOB_KEYS = {
  TOKEN_HEALTH: "token-health",
  CHANNEL_SYNC: "channel-sync",
} as const;

export const SLOT_IDS = {
  settingsPage: "slack-settings-page",
  issueTab: "slack-issue-thread-tab",
  commentAnnotation: "slack-comment-posted-annotation",
} as const;

export const EXPORT_NAMES = {
  settingsPage: "SlackSettingsPage",
  issueTab: "SlackIssueTab",
  commentAnnotation: "SlackCommentAnnotation",
} as const;

export const DATA_KEYS = {
  CHANNEL_LIST: "channel-list",
  THREAD_FOR_ISSUE: "thread-for-issue",
  MESSAGE_TS_FOR_COMMENT: "message-ts-for-comment",
} as const;

/**
 * Maps Slack emoji names to Paperclip issue status strings.
 * When a user adds one of these reactions to a tracked message,
 * the plugin updates the linked issue's status.
 */
export const EMOJI_TO_STATUS: Record<string, string> = {
  white_check_mark: "done",
  no_entry_sign: "cancelled",
  arrows_counterclockwise: "in_progress",
  eyes: "in_review",
  red_circle: "blocked",
};
