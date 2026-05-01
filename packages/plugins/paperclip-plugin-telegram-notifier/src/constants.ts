export const PLUGIN_ID = "paperclip.telegram-notifier";
export const PLUGIN_VERSION = "0.1.0";

export const TELEGRAM_API_BASE = "https://api.telegram.org";

export const JOB_KEYS = {
  pollUpdates: "poll-updates",
} as const;

export const TOOL_NAMES = {
  getStatus: "telegram.get_status",
  startPairing: "telegram.start_pairing",
  confirmPairing: "telegram.confirm_pairing",
  unpair: "telegram.unpair",
  sendTest: "telegram.send_test",
} as const;

/** Pairing window TTL — how long the operator has to relay the code back. */
export const PAIRING_WINDOW_TTL_MS = 10 * 60 * 1000;

/** Plugin state key, scoped per instance. Stores pairing state. */
export const STATE_KEY = "pairing-state";

/**
 * Polling timeout (seconds) passed to Telegram getUpdates. With long polling
 * Telegram holds the connection open for up to N seconds and returns as soon
 * as any update arrives. 25 keeps us well below typical proxy idle timeouts
 * while still amortising the request rate.
 */
export const POLL_TIMEOUT_SEC = 25;

/** Cap on how many updates we ingest per poll. */
export const POLL_LIMIT = 50;

/**
 * How long a single cron-fired job invocation keeps polling before exiting.
 * The plugin scheduler fires this job every minute, so we want each
 * invocation to keep the long-poll alive for almost the full minute and
 * leave ~10s headroom for clean exit before the next tick. This compresses
 * the worst-case gap between a Telegram callback tap and the bot answering
 * to ~10s — well under Telegram's 60s callback_query expiry.
 */
export const POLL_LOOP_DEADLINE_MS = 50_000;

/** Bot commands handled by the plugin (for setMyCommands). */
export const BOT_COMMANDS = [
  { command: "start", description: "Pair this chat with Paperclip" },
  { command: "help", description: "Show available commands" },
  { command: "new", description: "Create an issue (e.g. /new Fix login)" },
  { command: "inbox", description: "List your most recent assigned issues" },
  { command: "test", description: "Send a test notification" },
  { command: "status", description: "Show pairing status" },
  { command: "unpair", description: "Disconnect this chat from Paperclip" },
] as const;

/** Callback-data prefixes for inline-keyboard buttons. ≤64 bytes total. */
export const CALLBACK_KIND = {
  /** Show the full comment body (looked up by replied message_id). */
  showFullComment: "sfc",
  /** Send a force-reply prompt asking for the user's reply text. */
  replyToComment: "rtc",
  /** Switch the message keyboard to an agent-picker for reassignment. */
  reassignShow: "ras",
  /** Assign the issue to the agent at index N: `asg:N`. */
  assignAgentPrefix: "asg:",
} as const;

/**
 * Telegram caps a single message at ~4096 chars. Reserve headroom for the
 * notification header so the comment body fits in one bubble most of the
 * time; longer bodies are truncated with a "Show full" button that fetches
 * the rest from message context.
 */
export const COMMENT_INLINE_LIMIT = 3000;
