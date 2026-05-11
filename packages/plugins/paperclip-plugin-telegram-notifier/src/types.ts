/**
 * Plugin-internal types for the Telegram Notifier.
 *
 * Wire types from the Telegram Bot API are kept narrow — we only model the
 * fields we actually consume. Everything else is `unknown` so runtime payloads
 * don't fail typecheck if Telegram adds new fields.
 */

export interface PluginConfig {
  /** Telegram bot token, or the name of a Paperclip secret holding the token. */
  botToken?: string;
  /** Base URL for deep links into the Paperclip dashboard. */
  paperclipBaseUrl?: string;
  /** Per-event-class on/off switches. All default true. */
  notifyOn?: NotifyToggles;
  /** Daily digest schedule. */
  morningDigest?: {
    enabled?: boolean;
    /** Hour of day, 0–23, server local time. */
    hour?: number;
    weekdaysOnly?: boolean;
  };
  /** Send messages without sound. */
  silent?: boolean;
}

export interface NotifyToggles {
  approvals?: boolean;
  assignedToYou?: boolean;
  comments?: boolean;
  runFailures?: boolean;
  budgetIncidents?: boolean;
  wakeRequests?: boolean;
}

/**
 * Pairing state machine — written by tools (Paperclip side) and the polling
 * job (Telegram side). Transitions:
 *
 *   not_paired
 *     ↓ startPairing tool
 *   awaiting_chat       (user must now send any message to the bot)
 *     ↓ first inbound message from a chat
 *   code_sent           (bot has replied with the verification code)
 *     ↓ confirmPairing(code) tool
 *   paired
 */
export interface PairingState {
  /** Telegram bot username (without @), captured from getMe(). */
  botUsername?: string;
  /** Last `update_id` ingested from getUpdates — used to advance the offset. */
  lastUpdateId?: number;
  /**
   * The single in-flight pairing handshake. Only one pairing can be in
   * progress at a time across the whole instance — starting a new pairing
   * for company B while company A's handshake is still in flight cancels A.
   */
  pairing?: PairingHandshake;
  /**
   * Map of companyId → paired chat. Each company gets its own Telegram chat;
   * a single chat cannot be paired with two companies at once.
   */
  pairedByCompany?: Record<string, PairedChat>;
  /**
   * Per-message context for inline-keyboard callbacks. Keyed by the
   * Telegram message_id of the bot's outbound message. Lets callback
   * handlers stay under the 64-byte callback_data limit by referencing
   * the message rather than embedding all the IDs in the data string.
   */
  messageContexts?: Record<string, MessageContext>;
  /**
   * Per-company plan-approval workflow config. When enabled, agents listed
   * in `agents[*].requiresApproval = true` post a plan + `request_confirmation`
   * before acting; the configured approver decides via [Approve]/[Decline]
   * inline-keyboard buttons in Telegram.
   */
  approvalByCompany?: Record<string, ApprovalConfig>;
}

export interface ApprovalConfig {
  /** Master switch — when false, the workflow is dormant for this company. */
  enabled: boolean;
  /**
   * Agent who decides on plans. Null → resolve at runtime by role
   * (first agent with role=ceo, then any role containing `lead`). UI shows the current
   * resolved value as a hint.
   */
  approverAgentId: string | null;
  /**
   * Per-agent participation. Keyed by agent UUID. Absent agents default
   * to `requiresApproval: false`.
   */
  agents: Record<string, ApprovalAgentConfig>;
}

export interface ApprovalAgentConfig {
  /** When true, agent must gate plans through approval before acting. */
  requiresApproval: boolean;
  /**
   * Plan-template override for this agent. Empty/undefined → fall back to
   * the default template shipped with the plugin. Supports placeholders:
   *   {ticketId}, {approverMention}
   */
  template?: string;
}

export type MessageContext =
  | {
      kind: "comment_thread";
      companyId: string;
      issueId: string;
      identifier: string;
      /** Full comment body, kept so "Show full" can serve it without a re-fetch. */
      fullBody?: string;
      createdAt: string;
    }
  | {
      kind: "issue_thread";
      companyId: string;
      issueId: string;
      identifier: string;
      createdAt: string;
    }
  | {
      kind: "assign_picker";
      companyId: string;
      issueId: string;
      identifier: string;
      /** Agents the user can reassign to, displayed as inline-keyboard buttons. */
      agents: Array<{ id: string; name: string }>;
      createdAt: string;
    }
  | {
      /**
       * Anchored to the message that carries the [Approve] / [Decline]
       * inline-keyboard buttons for a `request_confirmation` interaction.
       * Looked up when a callback fires on that message so we know which
       * interaction to resolve and what to render in the closeout edit.
       */
      kind: "confirmation_decision";
      companyId: string;
      issueId: string;
      interactionId: string;
      identifier: string;
      title: string;
      /** Original prompt body, kept so the closeout edit can quote it. */
      promptText?: string;
      requesterLabel?: string;
      createdAt: string;
    }
  | {
      /**
       * Anchored to the bot-side force-reply prompt asking the operator for
       * the decline reason. The next inbound `message.reply_to_message.id`
       * matching this context is treated as the reason and used to call
       * the reject endpoint + edit the original confirmation message.
       */
      kind: "confirmation_decline_reason";
      companyId: string;
      issueId: string;
      interactionId: string;
      identifier: string;
      title: string;
      /** Original confirmation message — the one we'll edit on completion. */
      originalMessageId: number;
      /** Original prompt body, kept so the closeout edit can quote it. */
      promptText?: string;
      /** Display name of the operator who tapped Decline (for the closeout). */
      decliner: string;
      createdAt: string;
    };

export type PairingHandshake =
  | {
      stage: "awaiting_chat";
      /** Company this handshake will pair, captured at start_pairing time. */
      targetCompanyId: string;
      targetCompanyName?: string;
      /** ISO 8601 expiry. After this, polling and confirmation reject the handshake. */
      expiresAt: string;
    }
  | {
      stage: "code_sent";
      targetCompanyId: string;
      targetCompanyName?: string;
      expiresAt: string;
      /** Telegram chat ID that proved control by sending us the first message. */
      candidateChatId: string;
      candidateLabel: string;
      /** Code the bot already echoed to the candidate chat. The operator
       *  pastes it back via confirmPairing to complete the handshake. */
      code: string;
    };

export interface PairedChat {
  chatId: string;
  chatLabel: string;
  pairedAt: string;
  /**
   * Operate-as agent UUID for this company's commands and digests.
   * Issues created from `/new` are assigned to this agent and attributed to
   * it via `actor.actorAgentId`. The morning digest is scoped to issues
   * assigned to this agent.
   */
  operateAsAgentId?: string;
  /** Display label for the operate-as agent (best-effort). */
  operateAsAgentLabel?: string;
  /** Last day this chat received a morning digest (YYYY-MM-DD, server local). */
  lastDigestSentOn?: string;
  /** Display name of the company this chat is paired with. */
  companyName?: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  username?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export type InlineKeyboardButton =
  | { text: string; url: string }
  | { text: string; callback_data: string };

export type InlineKeyboard = InlineKeyboardButton[][];

export interface SendMessageRequest {
  text: string;
  keyboard?: InlineKeyboard;
  silent?: boolean;
  /** Override target chat (defaults to paired chat). */
  chatId?: string;
}
