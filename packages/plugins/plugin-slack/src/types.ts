/**
 * Plugin-level shared types for plugin-slack.
 * Imported throughout worker modules (not UI).
 */

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** Paperclip agent UUID */
  agentId: string;
  /** Slack bot token (xoxb-…) */
  botToken: string;
  /** Slack bot user ID (U…) — used for echo prevention */
  botUserId?: string;
  /** Human-readable name for logging / UI */
  displayName?: string;
  /** Slack app signing secret — used for Events API webhook verification */
  signingSecret?: string;
}

export interface ChannelMapping {
  /** Slack channel ID (C…) */
  slackChannelId: string;
  /** Optional human-readable label */
  channelName?: string;
  /** Paperclip project UUID */
  paperclipProjectId: string;
}

export interface SlackConfig {
  signingSecret?: string;
  /** xapp-… token — enables Socket Mode. Omit to use Events API. */
  appToken?: string;
  defaultAgentId?: string;
  agents?: AgentConfig[];
  channelMappings?: ChannelMapping[];
}

// ---------------------------------------------------------------------------
// Slack event payload shapes (subset we handle)
// ---------------------------------------------------------------------------

export interface SlackEventEnvelope {
  type: "event_callback" | "url_verification";
  /** Present for url_verification */
  challenge?: string;
  /** Unique ID for this event delivery — used for deduplication */
  event_id?: string;
  api_app_id?: string;
  team_id?: string;
  event?: SlackEvent;
}

export type SlackEvent =
  | SlackMessageEvent
  | SlackReactionEvent
  | SlackAppMentionEvent;

export interface SlackMessageEvent {
  type: "message";
  subtype?: string;
  channel: string;
  channel_type?: "channel" | "im" | "group" | "mpim";
  user?: string;
  bot_id?: string;
  api_app_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  event_id?: string;
}

export interface SlackReactionEvent {
  type: "reaction_added";
  user: string;
  reaction: string;
  item: {
    type: "message";
    channel: string;
    ts: string;
  };
  event_id?: string;
}

export interface SlackAppMentionEvent {
  type: "app_mention";
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  event_id?: string;
  api_app_id?: string;
}

// ---------------------------------------------------------------------------
// Thread map entry (stored in ctx.state)
// ---------------------------------------------------------------------------

export interface ThreadEntry {
  /** Slack channel ID */
  channelId: string;
  /** Slack message timestamp of the root message (the "thread parent") */
  threadTs: string;
  /** Slack permalink URL (optional, for display in UI) */
  slackUrl?: string;
  /** ISO timestamp when the thread was created */
  createdAt: string;
}
