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
  getApprovalConfig: "telegram.get_approval_config",
} as const;

/**
 * Default plan template surfaced to agents when no per-agent override is set.
 * Placeholders the worker substitutes at request_confirmation time:
 *   {ticketId}        — issue identifier (e.g. PROJ-42)
 *   {approverMention} — "@<approver-agent-name>"
 */
export const DEFAULT_PLAN_TEMPLATE = `## Plan — {ticketId}
**Goal:** <one-line restatement of what the ticket asks for>
**Approach:** <how you'll do it, one paragraph>
**Files / surfaces I'll touch:** <concrete list>
**Risks / open questions:** <any concerns>
**Estimated effort:** <S / M / L>

{approverMention} — please review.`;

/**
 * Canonical AGENTS.md snippet the plugin generates per checked agent. The UI
 * substitutes the agent's template into `{template}` and renders this for
 * copy-paste; the plugin never writes role files itself.
 */
export const AGENTS_MD_SNIPPET = `## Plan-approval gate (ONCE per ticket, before you start coding)

Before you make the first edit, post an implementation plan and issue a \`request_confirmation\` so the configured approver can sign off via Telegram.

**Investigation phase first — no gate.** Read the ticket and form the plan during discovery; don't gate during research.

**One gate per ticket, not per change.** Once you know the approach, issue ONE \`request_confirmation\` BEFORE the first edit. After approval, code freely. If the plan substantively changes mid-flight, issue a new \`request_confirmation\` with the revised plan.

**Plan format** — post as a comment AND mirror in the confirmation body:

\`\`\`
{template}
\`\`\`

\`<approver>\` is the agent configured in the **telegram-notifier plugin's approval config**. Get the current value via the plugin's \`get_approval_config\` tool.

**Decision flow:**
- **Approve** comment from approver → start coding.
- **Decline** comment from approver with reason → revise plan, post the revision + new \`request_confirmation\`. Repeat until approved.

Skip the gate only for trivially mechanical edits (the ticket explicitly names a file:line and a one-character correction).`;

/** Pairing window TTL — how long the operator has to relay the code back. */
export const PAIRING_WINDOW_TTL_MS = 10 * 60 * 1000;

/** Plugin state key, scoped per instance. Stores pairing state. */
export const STATE_KEY = "pairing-state";

/**
 * Polling timeout (seconds) passed to Telegram getUpdates. With long polling
 * Telegram holds the connection open for up to N seconds and returns as soon
 * as any update arrives. 5 keeps each poll short so the loop's deadline check
 * runs more often (better for clean exit before the next cron tick) without
 * meaningfully impacting freshness — Telegram still returns instantly when
 * an update is available, regardless of timeout.
 */
export const POLL_TIMEOUT_SEC = 5;

/** Cap on how many updates we ingest per poll. */
export const POLL_LIMIT = 50;

/**
 * How long a single cron-fired job invocation keeps polling before exiting.
 * The plugin scheduler fires this job every minute, so we want each
 * invocation to keep the long-poll alive for almost the full minute and
 * leave ~5s headroom for clean exit before the next tick. With
 * `POLL_TIMEOUT_SEC = 5` the loop runs ~11 polls per cycle and the
 * worst-case gap between a callback tap arriving in Telegram and the bot
 * picking it up is bounded by the gap (~5s) plus one short poll interval
 * (~5s) — under ~10s typical, well below Telegram's 60s callback expiry.
 */
export const POLL_LOOP_DEADLINE_MS = 55_000;

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
  /** Accept a `request_confirmation` thread interaction inline. */
  confirmAccept: "ca",
  /** Decline a `request_confirmation` — triggers a force-reply prompt for reason. */
  confirmDecline: "cd",
} as const;

/**
 * Telegram caps a single message at ~4096 chars. Reserve headroom for the
 * notification header so the comment body fits in one bubble most of the
 * time; longer bodies are truncated with a "Show full" button that fetches
 * the rest from message context.
 */
export const COMMENT_INLINE_LIMIT = 3000;
