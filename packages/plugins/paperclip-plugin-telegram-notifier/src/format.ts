/**
 * MarkdownV2 helpers and message builders.
 *
 * Telegram MarkdownV2 requires escaping a specific set of characters. The
 * builders here always escape user-supplied text and never escape literal
 * markdown control sequences they emit themselves.
 *
 * @see https://core.telegram.org/bots/api#markdownv2-style
 */

import { CALLBACK_KIND } from "./constants.js";
import type { InlineKeyboard } from "./types.js";

const MARKDOWN_V2_RESERVED = /[_*\[\]()~`>#+=|{}.!\\-]/g;

export function escapeMd(input: string): string {
  return input.replace(MARKDOWN_V2_RESERVED, (m) => `\\${m}`);
}

export function truncate(input: string, max = 280): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Issue / approval link builders
// ---------------------------------------------------------------------------

/**
 * Build a dashboard URL for an issue.
 *
 * Paperclip's `/issues/:id` route expects the issue UUID, not the human
 * identifier. We pass the UUID when available and gracefully fall back to
 * the identifier for messages where only the identifier is known — those
 * fallback links may not resolve on every Paperclip build, but they preserve
 * intent and are safer than dropping the link entirely.
 */
export function issueUrl(base: string, urlId: string): string {
  return `${trimSlash(base)}/issues/${encodeURIComponent(urlId)}`;
}

export function approvalUrl(base: string, approvalId: string): string {
  return `${trimSlash(base)}/approvals/${encodeURIComponent(approvalId)}`;
}

export function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Pairing messages
// ---------------------------------------------------------------------------

export function buildPairingCodeMessage(input: {
  code: string;
  chatLabel: string;
}): { text: string; keyboard: InlineKeyboard } {
  return {
    text: [
      "*🔐 Paperclip pairing*",
      `Verification code:`,
      "",
      `*${escapeMd(input.code)}*`,
      "",
      `Paste this code into the Paperclip *Confirm pairing* form to finish linking *${escapeMd(input.chatLabel)}*\\.`,
      "",
      "_Code expires in 10 minutes\\._",
    ].join("\n"),
    keyboard: [],
  };
}

export function buildPairingNotInitiated(): {
  text: string;
  keyboard: InlineKeyboard;
} {
  return {
    text: [
      "*Pairing not started*",
      "Open the Paperclip plugin settings and click *Start pairing* first, then send any message here\\.",
    ].join("\n"),
    keyboard: [],
  };
}

export function buildPairingExpired(): {
  text: string;
  keyboard: InlineKeyboard;
} {
  return {
    text: [
      "*Pairing window expired*",
      "Click *Start pairing* in Paperclip again, then send a fresh message here\\.",
    ].join("\n"),
    keyboard: [],
  };
}

export function buildAlreadyPaired(input: {
  chatLabel: string;
  /** When set, a different-company handshake is in flight; the operator likely
   *  picked the wrong chat to send the verification message from. */
  handshakeForCompany?: string;
}): { text: string; keyboard: InlineKeyboard } {
  if (input.handshakeForCompany) {
    return {
      text: [
        "*Wrong chat for this pairing*",
        `This chat is already paired with another company \\(${escapeMd(input.chatLabel)}\\)\\.`,
        `You're pairing *${escapeMd(input.handshakeForCompany)}* — send the next message from the *new* chat you want to pair, not from here\\.`,
        "",
        "_If the new chat is a group, add this bot to it first\\. Bots can only see messages in chats they're a member of\\._",
      ].join("\n"),
      keyboard: [],
    };
  }
  return {
    text: [
      "*This chat is already paired with another company*",
      `Currently paired: ${escapeMd(input.chatLabel)}\\.`,
      "Run `/unpair` from this chat \\(or *Unpair* in Paperclip\\) before pairing it with a different company\\.",
    ].join("\n"),
    keyboard: [],
  };
}

export function buildPairedConfirmation(input: { chatLabel: string }): {
  text: string;
  keyboard: InlineKeyboard;
} {
  return {
    text: [
      "*✅ Paired with Paperclip*",
      `Notifications will arrive in this chat \\(${escapeMd(input.chatLabel)}\\)\\.`,
      "",
      "Commands:",
      "• `/test` — send a sample notification",
      "• `/status` — show pairing status",
      "• `/unpair` — disconnect this chat",
    ].join("\n"),
    keyboard: [],
  };
}

export function buildTestMessage(): {
  text: string;
  keyboard: InlineKeyboard;
} {
  return {
    text: [
      "*🟢 Telegram Notifier — test*",
      "If you see this, pairing is working\\.",
      "",
      "You'll receive notifications when:",
      "• An approval needs your decision",
      "• An issue is assigned to you",
      "• A comment lands on one of your issues",
      "• An agent run fails",
      "• A budget incident opens",
    ].join("\n"),
    keyboard: [],
  };
}

export function buildUnpairedMessage(): {
  text: string;
  keyboard: InlineKeyboard;
} {
  return {
    text: [
      "*👋 Unpaired*",
      "This chat is no longer connected to Paperclip\\. Run *Start pairing* in the plugin settings to reconnect\\.",
    ].join("\n"),
    keyboard: [],
  };
}

interface DigestIssue {
  identifier: string;
  title: string;
  status: string;
}

export function buildMorningDigest(input: {
  date: string; // YYYY-MM-DD or human label
  doneYesterday: DigestIssue[];
  inProgress: DigestIssue[];
  todo: DigestIssue[];
  /** Maximum bullets per section before "+N more". */
  maxPerSection?: number;
}): { text: string; keyboard: InlineKeyboard } {
  const limit = input.maxPerSection ?? 6;
  const lines = [`*🌅 Good morning — ${escapeMd(input.date)}*`, ""];

  const renderSection = (title: string, items: DigestIssue[], emptyHint: string) => {
    lines.push(`*${title}*`);
    if (items.length === 0) {
      lines.push(`_${escapeMd(emptyHint)}_`);
    } else {
      const shown = items.slice(0, limit);
      for (const issue of shown) {
        lines.push(
          `• *${escapeMd(issue.identifier)}* — ${escapeMd(truncate(issue.title, 140))}`,
        );
      }
      if (items.length > shown.length) {
        lines.push(`_\\+${items.length - shown.length} more_`);
      }
    }
    lines.push("");
  };

  renderSection(
    `✅ Completed yesterday \\(${input.doneYesterday.length}\\)`,
    input.doneYesterday,
    "Nothing closed yesterday",
  );
  renderSection(
    `🟡 In progress \\(${input.inProgress.length}\\)`,
    input.inProgress,
    "No work in flight",
  );
  renderSection(
    `📋 Todo \\(${input.todo.length}\\)`,
    input.todo,
    "Inbox is clear",
  );

  return { text: lines.join("\n").trimEnd(), keyboard: [] };
}

export function buildHelpMessage(state: {
  commandsEnabled: boolean;
}): { text: string; keyboard: InlineKeyboard } {
  const lines = [
    "*Paperclip — Telegram bot*",
    "",
    "*Commands*",
    "• `/new <title>` — create an issue",
    "• `/inbox` — list your most recent assigned issues",
    "• `/test` — send yourself a test notification",
    "• `/status` — show pairing status",
    "• `/unpair` — disconnect this chat",
    "",
  ];
  if (!state.commandsEnabled) {
    lines.push(
      "_Commands `/new` and `/inbox` are disabled until *Default company* and *Operate-as user* are set in plugin settings\\._",
    );
  } else {
    lines.push(
      "_Notifications and commands are enabled\\._",
    );
  }
  return { text: lines.join("\n"), keyboard: [] };
}

export function buildIssueCreatedMessage(input: {
  baseUrl: string;
  identifier: string;
  issueId: string;
  title: string;
  description?: string;
  assigneeName?: string;
}): { text: string; keyboard: InlineKeyboard } {
  const lines = [
    "*✅ Issue created*",
    `*${escapeMd(input.identifier)}* — ${escapeMd(truncate(input.title, 200))}`,
  ];
  if (input.description && input.description.trim()) {
    const quoted = input.description
      .split("\n")
      .map((line) => `>${escapeMd(line)}`)
      .join("\n");
    lines.push("", quoted);
  }
  if (input.assigneeName) {
    lines.push("", `Assigned to: *${escapeMd(input.assigneeName)}*`);
  }
  return {
    text: lines.join("\n"),
    keyboard: [
      [
        { text: "👤 Reassign", callback_data: "ras" },
        { text: "Open issue →", url: issueUrl(input.baseUrl, input.issueId) },
      ],
    ],
  };
}

export function buildAssignPickerMessage(input: {
  identifier: string;
  agents: Array<{ name: string }>;
  /** Index range matches the keyboard rows. */
}): { text: string; keyboard: InlineKeyboard } {
  const buttons = input.agents.map((a, i) => ({
    text: a.name,
    callback_data: `asg:${i}`,
  }));
  // 2 buttons per row keeps labels readable on mobile.
  const keyboard: InlineKeyboard = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }
  return {
    text: `*👤 Reassign ${escapeMd(input.identifier)}*\nPick the new assignee:`,
    keyboard,
  };
}

export function buildAssignedConfirmation(input: {
  identifier: string;
  assigneeName: string;
}): { text: string; keyboard: InlineKeyboard } {
  return {
    text: `*✅ ${escapeMd(input.identifier)} assigned to ${escapeMd(input.assigneeName)}*`,
    keyboard: [],
  };
}

export function buildInboxMessage(input: {
  baseUrl: string;
  issues: Array<{
    id: string;
    identifier: string;
    title: string;
    status: string;
  }>;
}): { text: string; keyboard: InlineKeyboard } {
  if (input.issues.length === 0) {
    return {
      text: "*📭 Your inbox is empty*\nNo issues are currently assigned to you\\.",
      keyboard: [],
    };
  }
  const lines = ["*📥 Your inbox*", ""];
  for (const issue of input.issues) {
    lines.push(
      `• *${escapeMd(issue.identifier)}* \\[\`${escapeMd(issue.status)}\`\\] — ${escapeMd(truncate(issue.title, 140))}`,
    );
  }
  return { text: lines.join("\n"), keyboard: [] };
}

export function buildCommandsDisabledMessage(): {
  text: string;
  keyboard: InlineKeyboard;
} {
  return {
    text: [
      "*Commands disabled*",
      "Set *Default company* and *Operate-as user* in the plugin settings to enable `/new`, `/inbox`, and other commands\\.",
    ].join("\n"),
    keyboard: [],
  };
}

export function buildStatusMessage(state: {
  paired: boolean;
  chatLabel?: string;
}): { text: string; keyboard: InlineKeyboard } {
  if (state.paired) {
    return {
      text: [
        "*Paperclip Telegram Notifier*",
        `Status: ✅ paired \\(${escapeMd(state.chatLabel ?? "this chat")}\\)`,
      ].join("\n"),
      keyboard: [],
    };
  }
  return {
    text: [
      "*Paperclip Telegram Notifier*",
      "Status: ⏳ not paired",
      "",
      "Open the Paperclip plugin settings and click *Start pairing* to begin\\.",
    ].join("\n"),
    keyboard: [],
  };
}

// ---------------------------------------------------------------------------
// Notification messages
// ---------------------------------------------------------------------------

interface ApprovalMessageInput {
  baseUrl: string;
  approvalId: string;
  title: string;
  reason?: string;
  requestedBy?: string;
}

export function buildApprovalMessage(input: ApprovalMessageInput): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const lines = ["*🛂 Approval needed*", `*${escapeMd(input.title)}*`];
  if (input.requestedBy) {
    lines.push(`Requested by: ${escapeMd(input.requestedBy)}`);
  }
  if (input.reason) {
    lines.push(`> ${escapeMd(truncate(input.reason))}`);
  }
  return {
    text: lines.join("\n"),
    keyboard: [
      [
        {
          text: "Decide approval →",
          url: approvalUrl(input.baseUrl, input.approvalId),
        },
      ],
    ],
  };
}

interface ConfirmationMessageInput {
  baseUrl: string;
  /** Paperclip issue UUID for the deep link. */
  issueId: string;
  /** Issue identifier (e.g. PROJ-20) — shown to the operator. */
  identifier: string;
  /** Issue title. */
  title: string;
  /** Body of the confirmation request — first paragraph of the proposal. */
  body?: string;
  /** Agent or user that requested the confirmation. */
  requestedBy?: string;
}

/**
 * Notification for an issue-thread `request_confirmation` interaction.
 * Carries inline `[✅ Approve] [❌ Decline]` callback buttons so the operator
 * can resolve directly in chat — no dashboard hop needed (also works when
 * `paperclipBaseUrl` is `http://localhost`, where URL buttons can't render).
 *
 * The "Open issue ↗" URL button is included as a fallback row for richer
 * context viewing; in localhost setups Telegram renders it as a code-span
 * URL in the message text instead of a button (see telegram-client.ts).
 */
export function buildConfirmationMessage(input: ConfirmationMessageInput): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const lines = [
    "*🛂 Confirmation requested*",
    `*${escapeMd(input.identifier)}* — ${escapeMd(truncate(input.title, 200))}`,
  ];
  if (input.requestedBy) {
    lines.push(`Requested by: ${escapeMd(input.requestedBy)}`);
  }
  if (input.body && input.body.trim().length > 0) {
    lines.push("");
    // Render the prompt body as a MarkdownV2 blockquote so multi-line bodies
    // wrap cleanly in the chat. Each line is escape-prefixed and `>`-tagged.
    const truncated = truncate(input.body, 1500);
    for (const bodyLine of truncated.split("\n")) {
      lines.push(`> ${escapeMd(bodyLine)}`);
    }
  }
  return {
    text: lines.join("\n"),
    keyboard: [
      [
        { text: "✅ Approve", callback_data: CALLBACK_KIND.confirmAccept },
        { text: "❌ Decline", callback_data: CALLBACK_KIND.confirmDecline },
      ],
      [
        {
          text: "Open issue ↗",
          url: issueUrl(input.baseUrl, input.issueId),
        },
      ],
    ],
  };
}

/**
 * Closeout text shown after the operator taps Approve / Decline. The original
 * inline keyboard is removed when this is rendered so the chat history shows
 * the resolution as a sealed record. Body of the original prompt is preserved
 * for context.
 */
export function buildConfirmationDecidedMessage(input: {
  outcome: "approved" | "declined";
  identifier: string;
  title: string;
  decider: string;
  /** Decline reason — required for `declined`, ignored for `approved`. */
  reason?: string;
  /** Optional original prompt body for inclusion as a blockquote. */
  promptText?: string;
}): { text: string; keyboard: InlineKeyboard } {
  const isApproved = input.outcome === "approved";
  const headerIcon = isApproved ? "✅" : "❌";
  const headerLabel = isApproved ? "Approved" : "Declined";
  const lines = [
    `*${headerIcon} ${headerLabel}*`,
    `*${escapeMd(input.identifier)}* — ${escapeMd(truncate(input.title, 200))}`,
    `${headerLabel} by: ${escapeMd(input.decider)}`,
  ];
  if (!isApproved && input.reason && input.reason.trim().length > 0) {
    lines.push(`Reason: ${escapeMd(truncate(input.reason, 500))}`);
  }
  if (input.promptText && input.promptText.trim().length > 0) {
    lines.push("");
    const truncated = truncate(input.promptText, 1500);
    for (const bodyLine of truncated.split("\n")) {
      lines.push(`> ${escapeMd(bodyLine)}`);
    }
  }
  return {
    text: lines.join("\n"),
    keyboard: [],
  };
}

interface IssueAssignedMessageInput {
  baseUrl: string;
  identifier: string;
  /** UUID for the deep-link URL. Falls back to identifier if absent. */
  issueId?: string;
  title: string;
  status?: string;
  fromActor?: string;
}

export function buildIssueAssignedMessage(input: IssueAssignedMessageInput): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const lines = [
    "*📥 Issue assigned to you*",
    `*${escapeMd(input.identifier)}* — ${escapeMd(truncate(input.title, 200))}`,
  ];
  if (input.status) lines.push(`Status: \`${escapeMd(input.status)}\``);
  if (input.fromActor) {
    lines.push(`Handed off by: ${escapeMd(input.fromActor)}`);
  }
  return {
    text: lines.join("\n"),
    keyboard: [
      [
        {
          text: "Open issue →",
          url: issueUrl(input.baseUrl, input.issueId ?? input.identifier),
        },
      ],
    ],
  };
}

interface CommentMessageInput {
  baseUrl: string;
  identifier: string;
  /** UUID for the deep-link URL. Falls back to identifier if absent. */
  issueId?: string;
  issueTitle: string;
  authorName: string;
  body: string;
  /** When the body exceeds Telegram's per-message limit, callers pass true
   *  so the keyboard gets a "Show full" button that callbacks back to the
   *  worker. */
  hasFullBody?: boolean;
}

export function buildCommentMessage(input: CommentMessageInput): {
  text: string;
  keyboard: InlineKeyboard;
} {
  // Render the comment body as a Telegram MarkdownV2 blockquote so the
  // client draws the side bar and renders it as a quote of the original
  // remark, not as the bot's own words.
  const quotedBody = input.body
    .split("\n")
    .map((line) => `>${escapeMd(line)}`)
    .join("\n");

  const lines = [
    "*💬 New comment*",
    `*${escapeMd(input.identifier)}* — ${escapeMd(truncate(input.issueTitle, 160))}`,
    `*${escapeMd(input.authorName)}* wrote:`,
    quotedBody,
  ];

  const keyboard: InlineKeyboard = [
    [
      {
        text: "💬 Reply",
        callback_data: "rtc",
      },
      {
        text: "Open issue →",
        url: issueUrl(input.baseUrl, input.issueId ?? input.identifier),
      },
    ],
  ];
  if (input.hasFullBody) {
    keyboard.unshift([{ text: "📄 Show full", callback_data: "sfc" }]);
  }
  return { text: lines.join("\n"), keyboard };
}

interface RunFailedMessageInput {
  baseUrl: string;
  agentId?: string;
  agentName: string;
  identifier?: string;
  /** UUID for the issue deep-link URL. Falls back to identifier if absent. */
  issueId?: string;
  reason: string;
}

export function buildRunFailedMessage(input: RunFailedMessageInput): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const lines = [
    "*⚠️ Agent run failed*",
    input.identifier
      ? `${escapeMd(input.agentName)} on *${escapeMd(input.identifier)}*`
      : escapeMd(input.agentName),
    `> ${escapeMd(truncate(input.reason, 320))}`,
  ];
  const keyboard: InlineKeyboard = [];
  const issueLinkId = input.issueId ?? input.identifier;
  if (issueLinkId) {
    keyboard.push([
      {
        text: "Open issue →",
        url: issueUrl(input.baseUrl, issueLinkId),
      },
    ]);
  }
  if (input.agentId) {
    keyboard.push([
      {
        text: "Open agent →",
        url: `${trimSlash(input.baseUrl)}/agents/${encodeURIComponent(input.agentId)}`,
      },
    ]);
  }
  return { text: lines.join("\n"), keyboard };
}

interface BudgetMessageInput {
  subjectName: string;
  severity: string;
  reason: string;
}

export function buildBudgetMessage(input: BudgetMessageInput): {
  text: string;
  keyboard: InlineKeyboard;
} {
  return {
    text: [
      "*💸 Budget incident*",
      `*${escapeMd(input.subjectName)}* — severity: ${escapeMd(input.severity)}`,
      `> ${escapeMd(truncate(input.reason, 320))}`,
    ].join("\n"),
    keyboard: [],
  };
}

interface WakeRequestedMessageInput {
  baseUrl: string;
  identifier: string;
  /** UUID for the deep-link URL. Falls back to identifier if absent. */
  issueId?: string;
  title: string;
  reason: string;
}

export function buildWakeRequestedMessage(
  input: WakeRequestedMessageInput,
): { text: string; keyboard: InlineKeyboard } {
  return {
    text: [
      "*🔔 Wake requested*",
      `*${escapeMd(input.identifier)}* — ${escapeMd(truncate(input.title, 160))}`,
      `> ${escapeMd(truncate(input.reason, 280))}`,
    ].join("\n"),
    keyboard: [
      [
        {
          text: "Open issue →",
          url: issueUrl(input.baseUrl, input.issueId ?? input.identifier),
        },
      ],
    ],
  };
}
