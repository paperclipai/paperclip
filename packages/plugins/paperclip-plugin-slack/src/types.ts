export interface SlackPluginConfig {
  slackTokenRef: string;
  slackSigningSecretRef: string;
  /** Optional secret reference to a Slack user token (xoxp-...) used by search.messages. */
  slackUserTokenRef?: string;
  defaultChannelId: string;
  approvalsChannelId: string;
  errorsChannelId: string;
  pipelineChannelId: string;
  escalationChatId: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnApprovalCreated: boolean;
  notifyOnAgentError: boolean;
  notifyOnAgentConnected: boolean;
  notifyOnBudgetThreshold: boolean;
  /**
   * DM the human assignee on issue.created when `assigneeUserId` is set and
   * resolves to a Slack user via Paperclip-user → email → Slack lookup.
   * Cached per Paperclip user id so the lookup runs at most once.
   */
  notifyAssigneeOnAssignment: boolean;
  enableDailyDigest: boolean;
  escalationTimeoutMs: number;
  escalationDedupeWindowMs: number;
  escalationDefaultAction: string;
  escalationHoldMessage: string;
  paperclipBaseUrl: string;
  maxAgentsPerThread: number;
}

/** Alias preserving the upstream symbol name used across ported modules. */
export type SlackConfig = SlackPluginConfig;

export interface SessionEntry {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string;
  transport: "native" | "acp";
  status: "active" | "closed";
  spawnedAt: string;
  lastActivityAt: string;
}

export interface DiscussionLoop {
  id: string;
  channelId: string;
  threadTs: string;
  companyId?: string;
  initiatorAgent: string;
  targetAgent: string;
  reason: string;
  turns: number;
  maxTurns: number;
  status: "active" | "paused" | "completed" | "stale";
  lastTurnAt: string;
  createdAt: string;
}

export interface QueuedOutput {
  agentName: string;
  agentDisplayName: string;
  text: string;
  toolName?: string;
  queuedAt: string;
}

export interface EscalationRecord {
  id: string;
  reason: string;
  confidence?: number;
  agentName?: string;
  conversationHistory?: Array<{
    role: string;
    text: string;
  }>;
  agentReasoning?: string;
  suggestedReply?: string;
  status: "open" | "resolved" | "timed_out";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  steps: CommandStep[];
}

export interface CommandStep {
  type: "invoke_agent" | "post_message" | "create_issue" | "wait_approval";
  agentId?: string;
  prompt?: string;
  message?: string;
  issueTitle?: string;
  issueDescription?: string;
  timeout?: number;
}

export interface WatchEntry {
  id: string;
  channelId: string;
  threadTs: string;
  companyId: string;
  eventPattern: string;
  agentId: string;
  prompt: string;
  createdAt: string;
  createdBy: string;
  lastTriggeredAt?: string;
  triggerCount: number;
}
