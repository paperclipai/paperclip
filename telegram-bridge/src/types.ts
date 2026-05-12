/**
 * Telegram bridge types — Phase 1A scaffold.
 *
 * Bridge owns the inbound + outbound translation between Telegram and
 * Paperclip's REST API. Key contracts here, no behavior yet.
 */

export type WorkspaceName = "personal" | "work" | "finance" | "noted";

export type ChatToCompanyMapping = {
  /** Telegram chat ID (string for compat with negative-id supergroups). */
  chatId: string;
  /** Telegram thread/topic ID for forum-supergroups. Optional. */
  threadId?: number;
  /** Paperclip company UUID. */
  companyId: string;
  /** Workspace name (canonical: matches `00-system/workspaces/<name>.md`). */
  workspace: WorkspaceName;
  /** Default agent name (e.g., "karl"). "__id__" if defaultAgentId is set directly. */
  defaultAgent: string;
  /** Pre-resolved agent UUID from workspace frontmatter. Bypasses name lookup when set. */
  defaultAgentId?: string;
  /** Whether this chat requires @-mention to trigger. */
  requireMention: boolean;
};

export type InboundMessage = {
  chatId: string;
  threadId?: number;
  messageId: number;
  fromUserId: number;
  text?: string;
  voiceFileId?: string;
  photoFileIds?: string[];
  attachmentFileIds?: string[];
  receivedAt: string;
  /** Telegram reply-to context (when user is replying to a prior message). */
  replyTo?: {
    messageId: number;
    fromUserId?: number;
    fromUsername?: string;
    fromFirstName?: string;
    isBot?: boolean;
    text?: string;
  };
};

export type IssueCreationRequest = {
  companyId: string;
  agentId: string;
  title: string;
  description: string;
  /** Stable logical_task_id for cross-layer dispatch budget. */
  logicalTaskId: string;
  /** Source layer that originated this — always "telegram" from this bridge. */
  source: "telegram";
  /** Original Telegram message ref for outbound reply correlation. */
  originatingMessage: {
    chatId: string;
    threadId?: number;
    messageId: number;
  };
  /** Paperclip originKind. "interactive" for ephemeral/conversational issues. */
  originKind?: "manual" | "interactive";
};

export type OutboundComment = {
  /** Paperclip comment UUID — used by the bridge for outbound dedupe. */
  id: string;
  issueId: string;
  body: string;
  postedAt: string;
};

export type ApprovalCardSurface = {
  chatId: string;
  threadId?: number;
  approvalId: string;
  prompt: string;
  buttons: Array<{ label: string; callbackData: string }>;
  /** TTL in seconds; null means no expiry (Tier 2 morning batch). */
  ttlSec: number | null;
};

/** Quiet-hours window per AGENT-INFRA §3.9. Local time (Pacific). */
export const QUIET_HOURS_START_HOUR = 21; // 9pm
export const QUIET_HOURS_END_HOUR = 6.5;  // 6:30am
