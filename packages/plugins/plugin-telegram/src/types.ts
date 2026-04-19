/**
 * Domain types for plugin-telegram.
 *
 * Replaces scattered `: any` annotations with named, documented interfaces.
 * Telegram Bot API types are minimal subsets covering only the fields we access.
 */

// ---------------------------------------------------------------------------
// Telegram Bot API (subset)
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

export interface TelegramVoice {
  file_id: string;
  duration: number;
}

export interface TelegramAudio {
  file_id: string;
  duration: number;
  title?: string;
}

export interface TelegramVideoNote {
  file_id: string;
  duration: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  reply_to_message?: TelegramMessage;
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  video_note?: TelegramVideoNote;
  document?: TelegramDocument;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from: TelegramUser;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  callback_query?: TelegramCallbackQuery;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

// ---------------------------------------------------------------------------
// ACP Sessions (stored in plugin state)
// ---------------------------------------------------------------------------

export interface AcpSession {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string;
  transport: string;
  spawnedAt: string;
  status: "active" | "closed";
  lastActivityAt: string;
}

export interface AcpOutputEvent {
  sessionId: string;
  chatId: string;
  threadId: number;
  text: string;
  done?: boolean;
}

// ---------------------------------------------------------------------------
// Handoff / Discuss tool parameters
// ---------------------------------------------------------------------------

export interface HandoffToolParams {
  targetAgent?: string;
  reason?: string;
  contextSummary?: string;
  chatId?: string;
  threadId?: number;
  requiresApproval?: boolean;
}

export interface StoredHandoff {
  handoffId: string;
  sourceSessionId: string;
  sourceAgent: string;
  targetAgent: string;
  reason: string;
  contextSummary: string;
  chatId: string;
  threadId: number;
  companyId: string;
}

export interface DiscussToolParams {
  targetAgent?: string;
  topic?: string;
  initialMessage?: string;
  maxTurns?: number;
  chatId?: string;
  threadId?: number;
}

// ---------------------------------------------------------------------------
// Custom Command Registry
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  id: string;
  type:
    | "fetch_issue"
    | "invoke_agent"
    | "http_request"
    | "send_message"
    | "create_issue"
    | "wait_approval"
    | "set_state";
  name?: string;
  issueId?: string;
  agentId?: string;
  prompt?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  text?: string;
  title?: string;
  description?: string;
  projectId?: string;
  key?: string;
  value?: string;
}

export interface CustomCommand {
  name: string;
  description: string;
  steps: WorkflowStep[];
  createdBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Watch Registry
// ---------------------------------------------------------------------------

export interface WatchCondition {
  field: string;
  operator: "eq" | "ne" | "gt" | "lt" | "contains" | "exists";
  value: string;
}

export interface Watch {
  watchId: string;
  name: string;
  description: string;
  entityType: "issue" | "agent" | "custom";
  conditions: WatchCondition[];
  template: string;
  chatId: string;
  threadId?: number;
  companyId: string;
  createdBy: string;
  createdAt: string;
  lastTriggeredAt?: string;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

export interface EscalationContext {
  agentReasoning: string;
  suggestedReply: string;
  suggestedActions: string[];
  confidenceScore: number | null;
}

export interface EscalationEvent {
  escalationId: string;
  agentId: string;
  companyId: string;
  reason: string;
  context: EscalationContext;
  originChatId?: string;
  originThreadId?: number;
  originMessageId?: number;
  timeout: { durationMs: number; defaultAction: string };
  transport?: string;
  sessionId?: string;
}

export interface StoredEscalation {
  escalationId: string;
  agentId: string;
  companyId: string;
  reason: string;
  agentReasoning: string;
  suggestedReply: string;
  suggestedActions: string[];
  confidenceScore: number | null;
  originChatId?: string;
  originThreadId?: number;
  originMessageId?: number;
  escalationChatId: string;
  escalationMessageId: string;
  status: "pending" | "resolved" | "timed_out";
  createdAt: string;
  timeoutAt: string;
  defaultAction: string;
  transport?: string;
  sessionId?: string;
}

export interface EscalationResponse {
  escalationId: string;
  responderId: string;
  responseText: string;
  action: "reply_to_customer" | "dismiss" | "override";
}

export interface EscalateToolParams {
  agentId?: string;
  companyId?: string;
  reason?: string;
  reasoning?: string;
  suggestedReply?: string;
  suggestedActions?: string[];
  confidenceScore?: number;
  chatId?: string;
  threadId?: number;
  messageId?: number;
  transport?: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Event payloads (Paperclip → Telegram formatters)
// ---------------------------------------------------------------------------

export interface IssueEventPayload {
  identifier?: string;
  title?: string;
  status?: string;
  priority?: string;
  assigneeName?: string;
  projectName?: string;
  description?: string;
}

export interface ApprovalEventPayload {
  type?: string;
  approvalId?: string;
  title?: string;
  description?: string;
  agentName?: string;
  linkedIssues?: Array<{
    identifier?: string;
    title?: string;
    status?: string;
    priority?: string;
    assignee?: string;
  }>;
}

export interface AgentRunEventPayload {
  agentName?: string;
  name?: string;
  error?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// State mappings
// ---------------------------------------------------------------------------

export interface MessageMapping {
  entityId: string;
  entityType: "escalation" | "issue" | "approval";
  companyId: string;
  eventType?: string;
}

export interface AgentMessageMapping {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Inline keyboard (Telegram)
// ---------------------------------------------------------------------------

export type InlineKeyboardButton = { text: string; callback_data: string };
export type InlineKeyboardRow = InlineKeyboardButton[];

// ---------------------------------------------------------------------------
// Edit message options
// ---------------------------------------------------------------------------

export interface EditMessageOptions {
  parseMode?: "MarkdownV2";
  inlineKeyboard?: InlineKeyboardRow[];
}

// ---------------------------------------------------------------------------
// Register-watch tool params
// ---------------------------------------------------------------------------

export interface RegisterWatchParams {
  name?: string;
  description?: string;
  entityType?: string;
  conditions?: WatchCondition[];
  template?: string;
  chatId?: string;
  threadId?: number;
  builtinTemplate?: string;
  companyId?: string;
}
