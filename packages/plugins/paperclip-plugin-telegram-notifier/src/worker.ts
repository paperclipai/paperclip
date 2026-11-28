/**
 * Telegram Notifier — worker entrypoint.
 *
 * Pairing model (OpenClaw-style):
 *
 *   1. Operator clicks *Start pairing* in Paperclip → handshake stage becomes
 *      `awaiting_chat`.
 *   2. Operator sends any message to the bot in Telegram → polling job
 *      captures the chat, generates a 6-char code, replies with the code,
 *      handshake stage becomes `code_sent`.
 *   3. Operator pastes the code into Paperclip's *Confirm pairing* form
 *      (the `telegram.confirm_pairing` tool) → state moves to `paired`.
 *
 * The handshake requires control of *both* ends to complete: starting in
 * Paperclip alone or messaging the bot alone is not enough. Each step has a
 * 10-minute window.
 *
 * Plugin config (bot token, base URL, notification toggles, digest) is
 * stored per company by the host. Companies that use the same bot token are
 * polled together; each update is handled with the config of the company its
 * chat is paired to.
 *
 * Notifications are sent only to the paired chat. Most buttons are URL
 * deep-links to the dashboard. Plan confirmations can be approved or declined
 * from Telegram by the authorized approver (see `isAuthorizedApprover`).
 *
 * Failure mode: any exception inside an event or polling handler is caught
 * and logged; we never let a Telegram outage block the rest of Paperclip.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  Issue,
  PluginContext,
  PluginEvent,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";

import {
  AGENTS_MD_SNIPPET,
  CALLBACK_KIND,
  COMMENT_INLINE_LIMIT,
  DEFAULT_PLAN_TEMPLATE,
  JOB_KEYS,
  POLL_LOOP_DEADLINE_MS,
  POLL_TIMEOUT_SEC,
  TOOL_NAMES,
} from "./constants.js";
import {
  buildAlreadyPaired,
  buildApprovalMessage,
  buildAssignPickerMessage,
  buildAssignedConfirmation,
  buildBudgetMessage,
  buildConfirmationDecidedMessage,
  buildConfirmationMessage,
  buildCommandsDisabledMessage,
  buildCommentMessage,
  buildHelpMessage,
  buildInboxMessage,
  buildIssueAssignedMessage,
  buildIssueCreatedMessage,
  buildMorningDigest,
  buildPairedConfirmation,
  buildPairingCodeMessage,
  buildPairingCodeSentPrivately,
  buildPairingExpired,
  buildPairingNotInitiated,
  buildRunFailedMessage,
  buildStatusMessage,
  buildTestMessage,
  buildUnpairedMessage,
  buildWakeRequestedMessage,
} from "./format.js";
import {
  canWriteToPaperclip,
  chatLabel,
  clearHandshake,
  codesMatch,
  findCompanyForChat,
  generateVerificationCode,
  getApprovalConfig,
  getBotState,
  getMessageContext,
  getPaired,
  isAuthorizedApprover,
  isChatPairedToCompany,
  isPairingOperator,
  isHandshakeExpired,
  isPairedFor,
  mutatePairing,
  newHandshakeExpiry,
  patchBotState,
  patchPairedChat,
  patchPairing,
  readPairing,
  removePairedChat,
  saveMessageContext,
  setApprovalConfig,
} from "./pairing.js";
import { agentAssigneeChange, asRecord, asString } from "./events.js";
import {
  BOT_TOKEN_UNRESOLVED_MESSAGE,
  botIdFromToken,
  botTokenConfigError,
  createTelegramClient,
  errorText,
  isRateLimitError,
  isSecretRefBinding,
  resolveToken,
} from "./telegram-client.js";
import {
  createOutboundQueue,
  nextBackoff,
  outboundQueueSettings,
  type OutboundQueue,
} from "./outbound-queue.js";
import type {
  ApprovalConfig,
  InlineKeyboard,
  PairedChat,
  PairingState,
  PluginConfig,
  StoredPluginConfig,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Plugin config is company-scoped: the host stores one config row per
 * company and `ctx.config.get()` needs a company outside a company-scoped
 * invocation (scheduled jobs, for example). Every caller names the company.
 */
async function loadRawConfig(
  ctx: PluginContext,
  companyId: string,
): Promise<StoredPluginConfig> {
  const raw = await ctx.config.get(companyId);
  return (raw ?? {}) as StoredPluginConfig;
}

/**
 * Load a company's config with `botToken` resolved for that company. Every
 * call resolves the secret again: the token lives only in the caller's local
 * variables for one operation and is never cached, written to state or logged.
 */
async function loadConfig(
  ctx: PluginContext,
  companyId: string,
): Promise<PluginConfig> {
  const { botToken: stored, ...config } = await loadRawConfig(ctx, companyId);
  if (isSecretRefBinding(stored)) {
    return { ...config, botToken: await resolveToken(ctx, stored, companyId) };
  }
  // A literal token saved before secret references were required is refused:
  // without `botToken` nothing polls or sends for this company. The stored
  // value is never logged.
  const botTokenError = botTokenConfigError(stored);
  if (botTokenError) {
    ctx.logger.warn(`telegram-notifier: ${botTokenError}`, { companyId });
    return { ...config, botTokenError };
  }
  return config;
}

type NotifyFlag = keyof NonNullable<PluginConfig["notifyOn"]>;

function notifyEnabled(
  config: Pick<PluginConfig, "notifyOn">,
  flag: keyof NonNullable<PluginConfig["notifyOn"]>,
): boolean {
  return config.notifyOn?.[flag] !== false;
}

/**
 * Route a notification to the chat paired with the given company. If no chat
 * is paired, the notification is silently dropped — Paperclip's other surfaces
 * still receive it through the normal channels.
 */
async function sendToCompanyChat(
  ctx: PluginContext,
  config: PluginConfig,
  companyId: string,
  payload: { text: string; keyboard: InlineKeyboard },
): Promise<void> {
  if (!config.botToken) {
    ctx.logger.warn("telegram-notifier: missing botToken in config");
    return;
  }
  const state = await readPairing(ctx);
  const chat = getPaired(state, companyId);
  if (!chat) return;
  const client = await createTelegramClient(ctx, config.botToken);
  await client.sendMessage({
    chatId: chat.chatId,
    text: payload.text,
    keyboard: payload.keyboard.length > 0 ? payload.keyboard : undefined,
    silent: config.silent ?? false,
  });
}

/** Direct send to a specific Telegram chat ID — used inside the handshake flow. */
async function sendToChat(
  ctx: PluginContext,
  config: PluginConfig,
  chatId: string,
  payload: { text: string; keyboard: InlineKeyboard },
): Promise<void> {
  if (!config.botToken) return;
  const client = await createTelegramClient(ctx, config.botToken);
  await client.sendMessage({
    chatId,
    text: payload.text,
    keyboard: payload.keyboard.length > 0 ? payload.keyboard : undefined,
  });
}

/**
 * Send an "Issue created" confirmation, return the message_id so the caller
 * can save context for the 👤 Reassign callback. Returns undefined on failure.
 */
async function sendIssueCreatedConfirmation(
  ctx: PluginContext,
  config: PluginConfig,
  chatId: string,
  issue: { id: string; identifier: string | null; title: string; description: string | null },
  assigneeName?: string,
): Promise<{ message_id: number } | undefined> {
  if (!config.botToken) return undefined;
  const client = await createTelegramClient(ctx, config.botToken);
  const message = buildIssueCreatedMessage({
    baseUrl: config.paperclipBaseUrl ?? "http://localhost:3100",
    identifier: issue.identifier ?? issue.id.slice(0, 8),
    issueId: issue.id,
    title: issue.title,
    description: issue.description ?? undefined,
    assigneeName,
  });
  try {
    return await client.sendMessage({
      chatId,
      text: message.text,
      keyboard:
        message.keyboard.length > 0 ? message.keyboard : undefined,
    });
  } catch (err) {
    ctx.logger.warn("telegram-notifier: send issue-created failed", {
      err: errorText(err),
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Paperclip API helpers — used by callback handlers to resolve interactions
// without a dashboard hop. The plugin worker is in-process with the server,
// so unauth POST against `paperclipBaseUrl` (default `http://localhost:3100`)
// hits the loopback API as `local-board` actor. For non-localhost deployments
// a future SDK extension would be needed; for now, dev / self-hosted setups
// work end-to-end.
// ---------------------------------------------------------------------------

async function callPaperclipApi(
  config: PluginConfig,
  path: string,
  body: unknown = {},
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  const baseUrl = config.paperclipBaseUrl ?? "http://localhost:3100";
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const apiError =
        data && typeof data === "object"
          ? (data as { error?: string }).error
          : undefined;
      const errMsg = apiError ?? text.slice(0, 200) ?? `HTTP ${res.status}`;
      return { ok: false, status: res.status, data, error: errMsg };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: errorText(err),
    };
  }
}

async function acceptInteraction(
  config: PluginConfig,
  issueId: string,
  interactionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await callPaperclipApi(
    config,
    `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/accept`,
    {},
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

async function rejectInteraction(
  config: PluginConfig,
  issueId: string,
  interactionId: string,
  reason: string | undefined,
): Promise<{ ok: boolean; error?: string }> {
  const body = reason && reason.trim().length > 0 ? { reason: reason.trim() } : {};
  const result = await callPaperclipApi(
    config,
    `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/reject`,
    body,
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Send a `request_confirmation` notification with inline Approve / Decline
 * buttons, persist a `confirmation_decision` MessageContext keyed off the
 * sent message_id, and return the message_id for callers that want to
 * follow up (rare). Returns undefined on send failure.
 */
async function sendConfirmationToCompanyChat(
  ctx: PluginContext,
  config: PluginConfig,
  companyId: string,
  input: {
    issueId: string;
    interactionId: string;
    identifier: string;
    title: string;
    requestedBy?: string;
  },
): Promise<{ message_id: number } | undefined> {
  if (!config.botToken) return undefined;
  const state = await readPairing(ctx);
  const chat = getPaired(state, companyId);
  if (!chat) return undefined;
  const client = await createTelegramClient(ctx, config.botToken);
  const message = buildConfirmationMessage({
    baseUrl: config.paperclipBaseUrl ?? "http://localhost:3100",
    issueId: input.issueId,
    identifier: input.identifier,
    title: input.title,
    requestedBy: input.requestedBy,
  });
  try {
    const result = await client.sendMessage({
      chatId: chat.chatId,
      text: message.text,
      keyboard: message.keyboard.length > 0 ? message.keyboard : undefined,
      silent: config.silent ?? false,
    });
    if (result?.message_id) {
      await saveMessageContext(ctx, chat.chatId, result.message_id, {
        kind: "confirmation_decision",
        companyId,
        issueId: input.issueId,
        interactionId: input.interactionId,
        identifier: input.identifier,
        title: input.title,
        requesterLabel: input.requestedBy,
        createdAt: new Date().toISOString(),
      });
    }
    return result;
  } catch (err) {
    ctx.logger.warn("telegram-notifier: send confirmation failed", {
      err: errorText(err),
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Event handlers (Paperclip → Telegram)
// ---------------------------------------------------------------------------

async function onApprovalCreated(
  ctx: PluginContext,
  config: PluginConfig,
  event: PluginEvent,
): Promise<void> {
  if (!notifyEnabled(config, "approvals")) return;
  const payload = asRecord(event.payload) ?? {};
  const baseUrl = config.paperclipBaseUrl ?? "http://localhost:3100";

  // Two flavours arrive on this event lane:
  //   1. Top-level approval entities (existing flow — has approvalId).
  //   2. Issue-thread interactions (suggest_tasks / ask_user_questions /
  //      request_confirmation) — entityType="issue", payload carries
  //      `interactionKind` and `interactionId`.
  const interactionKind = asString(payload.interactionKind);
  const interactionId = asString(payload.interactionId);
  if (interactionKind) {
    // Skip suggestion-style interactions — the operator doesn't decide on
    // those from Telegram, the agent author handles them. Confirmations
    // are the one kind worth pushing.
    if (interactionKind !== "request_confirmation") return;
    const issueId = asString(event.entityId);
    if (!issueId || !interactionId) return;
    // Thread-interaction events reach this lane for every issue, private
    // ones included. Send only when the plugin may read the issue in this
    // company (the host's `issues.get` applies issue privacy), and send only
    // the title and link: the prompt body stays in Paperclip.
    const issue = await ctx.issues.get(issueId, event.companyId).catch(() => null);
    if (!issue) return;
    const title = issue.title ?? "Confirmation requested";
    const identifier = issue.identifier ?? issueId.slice(0, 8);
    let requestedBy: string | undefined;
    if (event.actorType === "agent" && event.actorId) {
      try {
        const agent = await ctx.agents.get(event.actorId, event.companyId);
        if (agent?.name) requestedBy = agent.name;
      } catch {
        /* best-effort */
      }
    } else if (event.actorType === "user" && event.actorId) {
      // Board-created confirmations come through with `actorId` like
      // `local-board`. Surface the raw id — it's the most accurate label
      // we have without an agents-style API for users.
      requestedBy = event.actorId;
    }
    await sendConfirmationToCompanyChat(ctx, config, event.companyId, {
      issueId,
      interactionId,
      identifier,
      title,
      requestedBy,
    });
    return;
  }

  // Legacy / approval-entity path.
  const approvalId = asString(event.entityId) ?? asString(payload.approvalId);
  if (!approvalId) return;
  await sendToCompanyChat(
    ctx,
    config,
    event.companyId,
    buildApprovalMessage({
      baseUrl,
      approvalId,
      title: asString(payload.title) ?? "Approval requested",
      reason: asString(payload.reason),
      requestedBy:
        asString(payload.requestedByName) ?? asString(payload.requestedBy),
    }),
  );
}

async function onIssueUpdated(
  ctx: PluginContext,
  config: PluginConfig,
  event: PluginEvent,
): Promise<void> {
  if (!notifyEnabled(config, "assignedToYou")) return;
  const payload = asRecord(event.payload) ?? {};
  // The issue.updated payload spreads the PATCH'd fields at the top level —
  // there is no `changes` wrapper, so an agent (re)assignment surfaces as a
  // top-level `assigneeAgentId`. agentAssigneeChange returns the new assignee
  // only when assignment actually changed in this update.
  const newAssigneeAgentId = agentAssigneeChange(payload);
  if (!newAssigneeAgentId) return;
  // entityId is the issue UUID (for deep-links); identifier is human-readable (e.g. PROJ-12).
  const issueId = asString(event.entityId);
  // Title/status/identifier aren't all in an assignment-only payload — fetch
  // the issue to render a complete notification (best-effort).
  let title = "(no title)";
  let identifier = asString(payload.identifier) ?? issueId?.slice(0, 8) ?? "?";
  let status = asString(payload.status);
  if (issueId) {
    try {
      const issue = await ctx.issues.get(issueId, event.companyId);
      if (issue) {
        title = issue.title ?? title;
        identifier = issue.identifier ?? identifier;
        status = issue.status ?? status;
      }
    } catch {
      /* best-effort — fall through with payload values */
    }
  }
  // "Handed off by" = the actor who performed the assignment.
  let handedOffBy: string | undefined;
  if (event.actorType === "agent" && event.actorId) {
    try {
      const agent = await ctx.agents.get(event.actorId, event.companyId);
      if (agent?.name) handedOffBy = agent.name;
    } catch {
      /* best-effort */
    }
  } else if (event.actorType === "user" && event.actorId) {
    handedOffBy = event.actorId;
  }
  await sendToCompanyChat(
    ctx,
    config,
    event.companyId,
    buildIssueAssignedMessage({
      baseUrl: config.paperclipBaseUrl ?? "http://localhost:3100",
      identifier,
      issueId,
      title,
      status,
      fromActor: handedOffBy,
    }),
  );
}

async function onCommentCreated(
  ctx: PluginContext,
  config: PluginConfig,
  event: PluginEvent,
): Promise<void> {
  if (!notifyEnabled(config, "comments")) return;
  const payload = asRecord(event.payload) ?? {};
  // The activity-log event payload only carries diff-style fields:
  // `commentId`, `identifier`, `issueTitle`, `bodySnippet` (truncated),
  // and `currentReferencedIssues`. The full comment body and the author's
  // agent ID are NOT in the payload — we have to fetch the comment record
  // to get them. Using `bodySnippet` alone produces a truncated notification
  // and "Someone wrote:" fallback, which is what was shipping before.
  // For `issue.comment.created`, `event.entityId` is the issue UUID (the
  // entityType is "issue"). The activity-log payload only carries
  // `commentId`, `identifier`, `issueTitle`, `bodySnippet` — no issueId.
  // Falling through to event.entityId is what makes the comment_thread
  // MessageContext save below actually run; without it, callback button
  // taps (Reply / Show full) get a "Reply context expired" alert.
  const issueId =
    asString(event.entityId) ??
    asString(payload.issueId) ??
    asString(payload.entityId);
  const commentId = asString(payload.commentId);
  const identifier =
    asString(payload.identifier) ?? asString(payload.issueIdentifier) ?? "?";
  let fullBody =
    asString(payload.body) ??
    asString(payload.text) ??
    asString(payload.bodySnippet) ??
    "";
  let authorName =
    asString(payload.authorName) ?? asString(payload.actorName);
  let authorAgentId: string | undefined;
  let authorIsUser = false;

  // Hydrate full body + author from the comment record itself when we have
  // an issueId. The activity-log payload truncates body and omits author
  // identity.
  if (issueId && commentId) {
    try {
      const comments = await ctx.issues.listComments(issueId, event.companyId);
      const comment = comments.find((c) => c.id === commentId);
      if (comment) {
        if (typeof comment.body === "string" && comment.body.length > 0) {
          fullBody = comment.body;
        }
        authorAgentId = comment.authorAgentId ?? undefined;
        authorIsUser = !authorAgentId && Boolean(comment.authorUserId);
      }
    } catch (err) {
      ctx.logger.warn("telegram-notifier: comment hydrate failed", {
        commentId,
        err: errorText(err),
      });
    }
  }
  // A reply relayed from this chat comes back as a comment event; the chat
  // already got "✅ Comment posted", so echoing it would be noise.
  if (issueId && (await consumeRelayedComment(issueId, commentId))) return;

  if (!authorName) {
    // The comment record is authoritative; the event actor covers a failed
    // hydrate.
    if (!authorAgentId && !authorIsUser && event.actorId) {
      if (event.actorType === "agent") authorAgentId = event.actorId;
      else if (event.actorType === "user") authorIsUser = true;
    }
    if (authorAgentId) {
      try {
        const agent = await ctx.agents.get(authorAgentId, event.companyId);
        if (agent?.name) authorName = agent.name;
      } catch {
        // ignore — fall back below
      }
    }
    // The plugin SDK exposes no user directory, so a board/human author is
    // labelled by role rather than by name.
    if (!authorName && authorIsUser) authorName = "Board";
  }
  if (!authorName) authorName = "Someone";

  // Comments the plugin posts itself carry no `issueTitle` in the payload.
  let issueTitle = asString(payload.issueTitle) ?? asString(payload.title);
  if (!issueTitle && issueId) {
    try {
      issueTitle = (await ctx.issues.get(issueId, event.companyId))?.title ?? undefined;
    } catch {
      /* best-effort */
    }
  }

  const inlineLimit = COMMENT_INLINE_LIMIT;
  const hasFullBody = fullBody.length > inlineLimit;
  const inlineBody = hasFullBody
    ? `${fullBody.slice(0, inlineLimit - 1)}…`
    : fullBody;

  // Send the notification, then save context keyed by the bot's outbound
  // message_id so reply-to and "Show full" callbacks can resolve back to
  // the original Paperclip issue.
  if (!config.botToken) return;
  const state = await readPairing(ctx);
  const chat = getPaired(state, event.companyId);
  if (!chat) return;
  const client = await createTelegramClient(ctx, config.botToken);
  const message = buildCommentMessage({
    baseUrl: config.paperclipBaseUrl ?? "http://localhost:3100",
    identifier,
    issueId,
    issueTitle: issueTitle ?? "(no title)",
    authorName,
    body: inlineBody,
    hasFullBody,
  });
  let sent: { message_id: number };
  try {
    sent = await client.sendMessage({
      chatId: chat.chatId,
      text: message.text,
      keyboard:
        message.keyboard.length > 0 ? message.keyboard : undefined,
      silent: config.silent ?? false,
    });
  } catch (err) {
    ctx.logger.warn("telegram-notifier: comment notification send failed", {
      err: errorText(err),
    });
    return;
  }
  if (issueId) {
    await saveMessageContext(ctx, chat.chatId, sent.message_id, {
      kind: "comment_thread",
      companyId: event.companyId,
      issueId,
      identifier,
      fullBody: hasFullBody ? fullBody : undefined,
      createdAt: new Date().toISOString(),
    });
  }
}

async function onAgentRunFailed(
  ctx: PluginContext,
  config: PluginConfig,
  event: PluginEvent,
): Promise<void> {
  if (!notifyEnabled(config, "runFailures")) return;
  const payload = asRecord(event.payload) ?? {};
  // `agent.run.failed` is a heartbeat-run event: `entityId` is the run id,
  // the agent is in `payload.agentId`.
  const agentId = asString(payload.agentId);
  let agentName = asString(payload.agentName);
  if (!agentName && agentId) {
    agentName = await ctx.agents
      .get(agentId, event.companyId)
      .then((agent) => agent?.name)
      .catch(() => undefined);
  }
  await sendToCompanyChat(
    ctx,
    config,
    event.companyId,
    buildRunFailedMessage({
      baseUrl: config.paperclipBaseUrl ?? "http://localhost:3100",
      agentId,
      agentName: agentName ?? "Agent",
      identifier: asString(payload.issueIdentifier),
      issueId: asString(payload.issueId),
      reason:
        asString(payload.reason) ?? asString(payload.error) ?? "Run failed",
    }),
  );
}

async function onBudgetIncident(
  ctx: PluginContext,
  config: PluginConfig,
  event: PluginEvent,
): Promise<void> {
  if (!notifyEnabled(config, "budgetIncidents")) return;
  const payload = asRecord(event.payload) ?? {};
  await sendToCompanyChat(
    ctx,
    config,
    event.companyId,
    buildBudgetMessage({
      subjectName: asString(payload.subjectName) ?? "subject",
      severity: asString(payload.severity) ?? "medium",
      reason: asString(payload.reason) ?? "Budget threshold crossed",
    }),
  );
}

async function onWakeupRequested(
  ctx: PluginContext,
  config: PluginConfig,
  event: PluginEvent,
): Promise<void> {
  if (!notifyEnabled(config, "wakeRequests")) return;
  const payload = asRecord(event.payload) ?? {};
  await sendToCompanyChat(
    ctx,
    config,
    event.companyId,
    buildWakeRequestedMessage({
      baseUrl: config.paperclipBaseUrl ?? "http://localhost:3100",
      identifier: asString(payload.identifier) ?? "?",
      issueId: asString(event.entityId) ?? asString(payload.issueId),
      title: asString(payload.title) ?? "(no title)",
      reason: asString(payload.reason) ?? "Manual wake requested",
    }),
  );
}

// ---------------------------------------------------------------------------
// Bot bootstrap (cache username, publish slash commands)
// ---------------------------------------------------------------------------

async function ensureBotBootstrap(
  ctx: PluginContext,
  config: PluginConfig,
): Promise<string | undefined> {
  if (!config.botToken) return undefined;
  const client = await createTelegramClient(ctx, config.botToken);
  // Cached per bot id, so a token for a different bot never reuses the
  // previous bot's username and still gets its command menu registered.
  const cached = getBotState(await readPairing(ctx), client.botId).username;
  if (cached) return cached;

  try {
    const me = await client.getMe();
    if (!me.username) {
      ctx.logger.warn("telegram-notifier: bot getMe returned no username");
      return undefined;
    }
    await client.setMyCommands().catch((err) => {
      ctx.logger.warn("telegram-notifier: setMyCommands failed", {
        err: errorText(err),
      });
    });
    await patchBotState(ctx, client.botId, { username: me.username });
    return me.username;
  } catch (err) {
    ctx.logger.warn("telegram-notifier: getMe failed", {
      err: errorText(err),
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Inbound (Telegram → Paperclip)
// ---------------------------------------------------------------------------

async function replyTo(
  ctx: PluginContext,
  config: PluginConfig,
  chatId: string,
  payload: { text: string; keyboard: InlineKeyboard },
): Promise<void> {
  if (!config.botToken) return;
  const client = await createTelegramClient(ctx, config.botToken);
  await client.sendMessage({
    chatId,
    text: payload.text,
    keyboard: payload.keyboard.length > 0 ? payload.keyboard : undefined,
  });
}

/**
 * Send the verification code and return the Telegram user it verifies.
 *
 * Whoever reads the code can have the Paperclip operator confirm it, so the
 * code may verify only a user who alone received it. In a private chat that
 * is the chat's owner. In a group every member would see it, so the code goes
 * to the sender's private chat; when the bot cannot reach it, the code is
 * posted in the group and the pairing verifies nobody.
 */
async function deliverPairingCode(
  ctx: PluginContext,
  config: PluginConfig,
  message: TelegramMessage,
  code: string,
  label: string,
): Promise<number | undefined> {
  const chatId = String(message.chat.id);
  const from = message.from;
  if (message.chat.type === "private") {
    await replyTo(ctx, config, chatId, buildPairingCodeMessage({ code, chatLabel: label }));
    return from?.id;
  }
  let sentPrivately = false;
  if (from && !from.is_bot) {
    try {
      await replyTo(ctx, config, String(from.id), buildPairingCodeMessage({ code, chatLabel: label }));
      sentPrivately = true;
    } catch (err) {
      // Usually the sender has no private chat with the bot yet.
      ctx.logger.info("telegram-notifier: pairing code not sent privately", {
        err: errorText(err),
      });
    }
  }
  if (from && sentPrivately) {
    await replyTo(
      ctx,
      config,
      chatId,
      buildPairingCodeSentPrivately({ userLabel: telegramUserLabel(from) }),
    );
    return from.id;
  }
  await replyTo(
    ctx,
    config,
    chatId,
    buildPairingCodeMessage({ code, chatLabel: label, noVerifiedOperator: true }),
  );
  return undefined;
}

async function handleHandshakeMessage(
  ctx: PluginContext,
  config: PluginConfig,
  message: TelegramMessage,
): Promise<boolean> {
  // Returns true if the message was consumed by the handshake flow.
  const state = await readPairing(ctx);
  const incomingChatId = String(message.chat.id);

  // If this chat is already paired with some company, fall through so slash
  // commands can be handled. The chat-to-company mapping is the source of
  // truth for routing.
  const existingPairing = findCompanyForChat(state, incomingChatId);

  // An already-paired chat keeps its own handlers (`/new`, `/unpair`,
  // replies, decline reasons) while another company pairs. Only `/start`,
  // the pairing message, gets the wrong-chat hint below.
  if (existingPairing) {
    const isStart = /^\/start(@\w+)?(\s|$)/.test(message.text ?? "");
    if (!isStart || !state.pairing || isHandshakeExpired(state.pairing)) return false;
  }

  // No active handshake in flight.
  if (!state.pairing) {
    await replyTo(ctx, config, incomingChatId, buildPairingNotInitiated());
    return true;
  }

  // Handshake exists; check expiry.
  if (isHandshakeExpired(state.pairing)) {
    await clearHandshake(ctx);
    await replyTo(ctx, config, incomingChatId, buildPairingExpired());
    return true;
  }

  // If this chat is already paired with a *different* company while a
  // handshake is in flight for some other company, the operator likely sent
  // the verification message from the wrong chat. Tell them what to do
  // next instead of just refusing.
  if (existingPairing && existingPairing.companyId !== state.pairing.targetCompanyId) {
    await replyTo(
      ctx,
      config,
      incomingChatId,
      buildAlreadyPaired({
        chatLabel: existingPairing.chat.chatLabel,
        handshakeForCompany:
          state.pairing.targetCompanyName ?? state.pairing.targetCompanyId,
      }),
    );
    return true;
  }

  // awaiting_chat → capture this chat, send code, advance to code_sent.
  if (state.pairing.stage === "awaiting_chat") {
    const code = generateVerificationCode();
    const label = chatLabel(message.chat);
    const candidateUserId = await deliverPairingCode(ctx, config, message, code, label);
    await patchPairing(ctx, {
      pairing: {
        stage: "code_sent",
        targetCompanyId: state.pairing.targetCompanyId,
        targetCompanyName: state.pairing.targetCompanyName,
        candidateChatId: incomingChatId,
        candidateLabel: label,
        candidateUserId,
        code,
        expiresAt: newHandshakeExpiry(),
      },
    });
    ctx.logger.info("telegram-notifier: code sent to candidate chat", {
      chatId: incomingChatId,
      companyId: state.pairing.targetCompanyId,
    });
    return true;
  }

  // code_sent → if the same chat sends another message (e.g. /start), resend
  // the same code so the operator doesn't have to scroll back to find it.
  if (state.pairing.stage === "code_sent") {
    if (state.pairing.candidateChatId !== incomingChatId) {
      // A different chat is trying to interfere; ignore them silently.
      return true;
    }
    const { code, candidateLabel, candidateUserId } = state.pairing;
    const isGroup = message.chat.type !== "private";
    if (isGroup && candidateUserId != null) {
      // The code stays private: resend it to the verified sender only.
      if (message.from?.id === candidateUserId) {
        await replyTo(
          ctx,
          config,
          String(candidateUserId),
          buildPairingCodeMessage({ code, chatLabel: candidateLabel }),
        ).catch(() => undefined);
      }
      return true;
    }
    await replyTo(
      ctx,
      config,
      incomingChatId,
      buildPairingCodeMessage({ code, chatLabel: candidateLabel, noVerifiedOperator: isGroup }),
    );
    return true;
  }

  return false;
}

const WRITE_DENIED_TEXT = "Only the paired operator can do this.";
/** Commands that write to Paperclip. `/unpair` has its own, stricter gate. */
const WRITE_COMMANDS = new Set(["/new"]);
/** Buttons that write to Paperclip or open a prompt whose answer does. */
function isWriteCallback(data: string): boolean {
  return (
    data === CALLBACK_KIND.reassignShow ||
    data === CALLBACK_KIND.replyToComment ||
    data.startsWith(CALLBACK_KIND.assignAgentPrefix)
  );
}

/**
 * The one guard for Telegram actions that write to Paperclip: `/new`,
 * Reassign, Reply and comment replies. True when the chat is paired and the
 * sender is neither its operator nor the company's explicit approver.
 * Read-only actions (`/inbox`, Show full) stay open to every chat member;
 * plan confirmations and `/unpair` keep their own approver/operator gates.
 */
async function writeDenied(
  ctx: PluginContext,
  chatId: string,
  fromUserId: number | undefined,
): Promise<boolean> {
  const pairing = await readPairing(ctx);
  const found = findCompanyForChat(pairing, chatId);
  if (!found) return false;
  return !canWriteToPaperclip(getApprovalConfig(pairing, found.companyId), found.chat, fromUserId);
}

async function handleSlashCommand(
  ctx: PluginContext,
  config: PluginConfig,
  message: TelegramMessage,
): Promise<void> {
  const text = message.text?.trim() ?? "";
  if (!text.startsWith("/")) return;

  const head = text.split(/\s+/, 1)[0];
  const command = head.split("@")[0]; // strip /command@bot suffix
  const argsText = text.slice(head.length).trim();
  const incomingChatId = String(message.chat.id);
  if (WRITE_COMMANDS.has(command) && (await writeDenied(ctx, incomingChatId, message.from?.id))) {
    await replyTo(ctx, config, incomingChatId, {
      text: escapeMdText(WRITE_DENIED_TEXT),
      keyboard: [],
    });
    return;
  }
  const state = await readPairing(ctx);

  // The chat-to-company mapping is the routing context for every authoring
  // command. /help and /status are still answered for unpaired chats with
  // useful guidance.
  const pairing = findCompanyForChat(state, incomingChatId);

  switch (command) {
    case "/help": {
      await replyTo(
        ctx,
        config,
        incomingChatId,
        buildHelpMessage({ commandsEnabled: !!pairing?.chat.operateAsAgentId }),
      );
      return;
    }
    case "/status": {
      await replyTo(
        ctx,
        config,
        incomingChatId,
        buildStatusMessage({
          paired: !!pairing,
          chatLabel: pairing?.chat.chatLabel,
        }),
      );
      return;
    }
    case "/test": {
      if (!pairing) return;
      await replyTo(ctx, config, incomingChatId, buildTestMessage());
      return;
    }
    case "/unpair": {
      if (!pairing) return;
      // Unpair disconnects the whole company — restrict it to the operator who
      // paired the chat so a stray group member can't sever the link.
      if (!isPairingOperator(pairing.chat, message.from?.id)) {
        await replyTo(ctx, config, incomingChatId, {
          text: "*Not allowed\\.* Only the operator who paired this chat can unpair it\\.",
          keyboard: [],
        });
        return;
      }
      await removePairedChat(ctx, pairing.companyId);
      await replyTo(ctx, config, incomingChatId, buildUnpairedMessage());
      return;
    }
    case "/new": {
      if (!pairing) return;
      const operateAsAgentId = pairing.chat.operateAsAgentId;
      if (!operateAsAgentId) {
        await replyTo(ctx, config, incomingChatId, buildCommandsDisabledMessage());
        return;
      }
      // Multi-line `/new`: first non-empty line = title, rest = description.
      const trimmed = argsText.trim();
      if (!trimmed) {
        await replyTo(ctx, config, incomingChatId, {
          text:
            "Usage:\n`/new <title>` — quick title-only issue\n" +
            "`/new <title>\\n<description>` — multi-line for description",
          keyboard: [],
        });
        return;
      }
      const newlineAt = trimmed.indexOf("\n");
      const title =
        newlineAt === -1 ? trimmed : trimmed.slice(0, newlineAt).trim();
      const description =
        newlineAt === -1 ? undefined : trimmed.slice(newlineAt + 1).trim() || undefined;

      try {
        const issue = await ctx.issues.create({
          companyId: pairing.companyId,
          title,
          description,
          assigneeAgentId: operateAsAgentId,
          actor: { actorAgentId: operateAsAgentId },
        });
        const assignee = operateAsAgentId
          ? (await ctx.agents.get(operateAsAgentId, pairing.companyId))?.name
          : undefined;
        const sent = await sendIssueCreatedConfirmation(
          ctx,
          config,
          incomingChatId,
          issue,
          assignee,
        );
        // Save assign-picker context keyed by the bot's message_id so the
        // 👤 Reassign button on this message can later swap to an agent
        // picker without us having to re-fetch the agent list.
        if (sent) {
          const agents = await ctx.agents.list({ companyId: pairing.companyId });
          await saveMessageContext(ctx, incomingChatId, sent.message_id, {
            kind: "assign_picker",
            companyId: pairing.companyId,
            issueId: issue.id,
            identifier: issue.identifier ?? issue.id.slice(0, 8),
            agents: agents.map((a) => ({ id: a.id, name: a.name })),
            createdAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        await replyTo(ctx, config, incomingChatId, {
          text: `*Failed to create issue*\n${escapeMdText(errorText(err))}`,
          keyboard: [],
        });
      }
      return;
    }
    case "/inbox": {
      if (!pairing) return;
      const operateAsAgentId = pairing.chat.operateAsAgentId;
      if (!operateAsAgentId) {
        await replyTo(ctx, config, incomingChatId, buildCommandsDisabledMessage());
        return;
      }
      try {
        // Server-side filter on assigneeAgentId so a high-activity company
        // with >50 backlog issues still surfaces the operate-as agent's
        // assignments. Bridge supports this filter directly — no need to
        // ingest the whole company backlog and slice client-side.
        const mine = (
          await ctx.issues.list({
            companyId: pairing.companyId,
            assigneeAgentId: operateAsAgentId,
            limit: 5,
          })
        ).map((issue) => ({
          id: issue.id,
          identifier: issue.identifier ?? issue.id.slice(0, 8),
          title: issue.title,
          status: issue.status,
        }));
        await replyTo(
          ctx,
          config,
          incomingChatId,
          buildInboxMessage({
            baseUrl: config.paperclipBaseUrl ?? "http://localhost:3100",
            issues: mine,
          }),
        );
      } catch (err) {
        await replyTo(ctx, config, incomingChatId, {
          text: `*Failed to load inbox*\n${escapeMdText(errorText(err))}`,
          keyboard: [],
        });
      }
      return;
    }
    default:
      // Silently ignore unknown commands (might be aimed at another bot in a group).
      return;
  }
}

/**
 * Best-effort display label for a Telegram user — first_name plus last_name
 * if present, falling back to @username, then the numeric id. Used as the
 * "Approved by …" / "Declined by …" line in the confirmation closeout.
 */
function telegramUserLabel(
  from: NonNullable<TelegramUpdate["callback_query"]>["from"],
): string {
  const fn = from.first_name ?? "";
  const ln = from.last_name ?? "";
  const full = `${fn} ${ln}`.trim();
  if (full) return full;
  if (from.username) return `@${from.username}`;
  return `tg:${from.id}`;
}

/**
 * MarkdownV2-escape plain text. Only escapes: user content (comments, titles)
 * must reach the chat unchanged, so error strings are redacted with
 * `errorText` at the error site before they get here.
 */
function escapeMdText(text: string): string {
  // Reuse the same MarkdownV2 escape rules used by format.ts.
  return text.replace(/[_*\[\]()~`>#+=|{}.!\\-]/g, (m) => `\\${m}`);
}

async function handleMessage(
  ctx: PluginContext,
  config: PluginConfig,
  message: TelegramMessage,
): Promise<void> {
  const consumed = await handleHandshakeMessage(ctx, config, message);
  if (consumed) return;

  // Reply-to: if this message quotes one of our previous bot messages, route
  // by the saved MessageContext kind:
  //   - comment_thread → post the user's text as a comment on the issue.
  //   - confirmation_decline_reason → reject the interaction with the text
  //     as the reason and edit the original confirmation message.
  const replyTarget = (message as { reply_to_message?: { message_id: number } })
    .reply_to_message;
  if (replyTarget?.message_id && message.text) {
    const handledDecline = await handleConfirmationDeclineReply(
      ctx,
      config,
      message,
      replyTarget.message_id,
    );
    if (handledDecline) return;
    const handled = await handleCommentReply(
      ctx,
      config,
      message,
      replyTarget.message_id,
    );
    if (handled) return;
  }

  await handleSlashCommand(ctx, config, message);
}

async function handleConfirmationDeclineReply(
  ctx: PluginContext,
  config: PluginConfig,
  message: TelegramMessage,
  replyToMessageId: number,
): Promise<boolean> {
  const incomingChatId = String(message.chat.id);
  const context = await getMessageContext(ctx, incomingChatId, replyToMessageId);
  if (!context || context.kind !== "confirmation_decline_reason") return false;
  const pairing = await readPairing(ctx);
  const found = findCompanyForChat(pairing, incomingChatId);
  if (!found || found.companyId !== context.companyId) return false;
  // Only the authorized approver can supply the decline reason that actually
  // rejects the interaction — mirrors the gate on the [Decline] button itself.
  if (!isAuthorizedApprover(getApprovalConfig(pairing, context.companyId), found.chat, message.from?.id)) {
    return false;
  }
  const reason = (message.text ?? "").trim();
  if (!reason) {
    await replyTo(ctx, config, incomingChatId, {
      text: "*Empty reason.* Reply with a non-empty decline reason\\.",
      keyboard: [],
    });
    return true;
  }
  const result = await rejectInteraction(
    config,
    context.issueId,
    context.interactionId,
    reason,
  );
  if (!result.ok) {
    await replyTo(ctx, config, incomingChatId, {
      text: `*Decline failed*\n${escapeMdText(errorText(result.error ?? "unknown error"))}`,
      keyboard: [],
    });
    return true;
  }
  // Replace the original confirmation message body with the closeout text
  // and strip the inline keyboard so the chat history shows the resolution.
  if (config.botToken) {
    try {
      const client = await createTelegramClient(ctx, config.botToken);
      const closeout = buildConfirmationDecidedMessage({
        outcome: "declined",
        identifier: context.identifier,
        title: context.title,
        decider: context.decliner,
        reason,
        promptText: context.promptText,
      });
      await client.editMessageText({
        chatId: incomingChatId,
        messageId: context.originalMessageId,
        text: closeout.text,
        keyboard: closeout.keyboard,
      });
    } catch (err) {
      ctx.logger.warn("telegram-notifier: edit decline closeout failed", {
        err: errorText(err),
      });
    }
  }
  await replyTo(ctx, config, incomingChatId, {
    text: `*✅ Declined ${escapeMdText(context.identifier)}* with your reason\\.`,
    keyboard: [],
  });
  return true;
}

// Comments this worker posted from Telegram replies, by comment id. The host
// emits `issue.comment.created` for them and may deliver it before
// createComment resolves, so the event handler first waits for the relays in
// flight on that issue. Matching by id alone keeps a different comment with
// the same text from being swallowed.
const RELAY_TTL_MS = 5 * 60_000;
const relayedCommentIds = new Map<string, number>();
const relaysInFlight = new Map<string, Set<Promise<unknown>>>();

async function relayComment(
  issueId: string,
  create: () => Promise<{ id: string }>,
): Promise<void> {
  const relay = create().then((comment) => {
    const now = Date.now();
    for (const [id, expires] of relayedCommentIds) {
      if (expires <= now) relayedCommentIds.delete(id);
    }
    relayedCommentIds.set(comment.id, now + RELAY_TTL_MS);
  });
  const inFlight = relaysInFlight.get(issueId) ?? new Set<Promise<unknown>>();
  relaysInFlight.set(issueId, inFlight);
  inFlight.add(relay);
  try {
    await relay;
  } finally {
    inFlight.delete(relay);
    if (inFlight.size === 0) relaysInFlight.delete(issueId);
  }
}

/** True (once) when the comment is one this worker relayed from Telegram. */
async function consumeRelayedComment(
  issueId: string,
  commentId: string | undefined,
): Promise<boolean> {
  if (!commentId) return false;
  const inFlight = relaysInFlight.get(issueId);
  if (inFlight) await Promise.allSettled([...inFlight]);
  const expires = relayedCommentIds.get(commentId);
  relayedCommentIds.delete(commentId);
  return expires !== undefined && expires > Date.now();
}

/**
 * Post a Telegram reply as an issue comment.
 *
 * A reply from the operator who paired the chat is posted as the Paperclip
 * user who confirmed that pairing (`actorUserId`). The host treats that as a
 * human comment and wakes the issue assignee, the same as a dashboard
 * comment. Agent-attributed plugin comments never wake anyone, so the
 * company's explicit approver (or chats paired before the user id was
 * captured) fall back to the operate-as agent, then to plugin attribution.
 * Callers admit only allowed senders (`canWriteToPaperclip`).
 */
export async function postTelegramReplyComment(
  ctx: PluginContext,
  chat: PairedChat,
  message: TelegramMessage,
  context: { companyId: string; issueId: string },
  body: string,
): Promise<"user" | "agent" | "plugin"> {
  if (chat.pairedByUserId && isPairingOperator(chat, message.from?.id)) {
    const startedAt = Date.now();
    try {
      await relayComment(context.issueId, () =>
        ctx.issues.createComment(context.issueId, body, context.companyId, {
          actorUserId: chat.pairedByUserId,
        }),
      );
      return "user";
    } catch (err) {
      // The user may have left the company or lost write access; keep the
      // reply instead of dropping it. A failure can also come after the host
      // saved the comment (a timeout, a later activity-log error), so check
      // for it before writing a second copy under the agent.
      ctx.logger.warn("telegram-notifier: human-attributed comment failed", {
        companyId: context.companyId,
        err: errorText(err),
      });
      const saved = await ctx.issues
        .listComments(context.issueId, context.companyId)
        .then((comments) =>
          comments.find(
            (c) =>
              c.authorUserId === chat.pairedByUserId &&
              c.body === body &&
              new Date(c.createdAt).getTime() >= startedAt - 60_000,
          ),
        )
        .catch(() => undefined);
      if (saved) {
        // Keep the echo suppression the successful path gets.
        relayedCommentIds.set(saved.id, Date.now() + RELAY_TTL_MS);
        return "user";
      }
    }
  }
  const operateAsAgentId = chat.operateAsAgentId;
  await relayComment(context.issueId, () =>
    ctx.issues.createComment(
      context.issueId,
      body,
      context.companyId,
      operateAsAgentId ? { authorAgentId: operateAsAgentId } : undefined,
    ),
  );
  return operateAsAgentId ? "agent" : "plugin";
}

async function handleCommentReply(
  ctx: PluginContext,
  config: PluginConfig,
  message: TelegramMessage,
  replyToMessageId: number,
): Promise<boolean> {
  const incomingChatId = String(message.chat.id);
  const context = await getMessageContext(ctx, incomingChatId, replyToMessageId);
  if (!context || context.kind !== "comment_thread") return false;
  const pairing = await readPairing(ctx);
  const found = findCompanyForChat(pairing, incomingChatId);
  if (!found || found.companyId !== context.companyId) return false;
  // Other members of a paired group cannot write to Paperclip: their reply
  // is dropped without a comment or an answer.
  if (await writeDenied(ctx, incomingChatId, message.from?.id)) return true;
  const body = (message.text ?? "").trim();
  if (!body) return false;
  try {
    await postTelegramReplyComment(ctx, found.chat, message, context, body);
    await replyTo(ctx, config, incomingChatId, {
      text: `*✅ Comment posted on ${escapeMdText(context.identifier)}*`,
      keyboard: [],
    });
  } catch (err) {
    await replyTo(ctx, config, incomingChatId, {
      text: `*Failed to post comment*\n${escapeMdText(errorText(err))}`,
      keyboard: [],
    });
  }
  return true;
}

/**
 * Gate for resolving a plan confirmation from an inline button. Confirms that
 * (a) the firing chat is the one currently paired to the context's company —
 * so a callback can't reach across chats — and (b) the pressing user is an
 * authorized approver. Answers the callback with an alert and returns false
 * when either check fails.
 */
async function assertConfirmationAuthorized(
  ctx: PluginContext,
  client: Awaited<ReturnType<typeof createTelegramClient>>,
  query: NonNullable<TelegramUpdate["callback_query"]>,
  chatId: string,
  companyId: string,
): Promise<boolean> {
  const pairing = await readPairing(ctx);
  const paired = getPaired(pairing, companyId);
  if (!paired || paired.chatId !== chatId) {
    await client.answerCallbackQuery({
      callbackQueryId: query.id,
      text: "Confirmation context expired. Open the issue in Paperclip.",
      showAlert: true,
    });
    return false;
  }
  if (!isAuthorizedApprover(getApprovalConfig(pairing, companyId), paired, query.from.id)) {
    await client.answerCallbackQuery({
      callbackQueryId: query.id,
      text: "Only the designated approver can act on this confirmation.",
      showAlert: true,
    });
    return false;
  }
  return true;
}

async function handleCallbackQuery(
  ctx: PluginContext,
  config: PluginConfig,
  query: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<void> {
  if (!config.botToken) return;
  if (!query.message) return;
  const client = await createTelegramClient(ctx, config.botToken);
  const data = query.data ?? "";
  const chatId = String(query.message.chat.id);
  try {
    if (isWriteCallback(data) && (await writeDenied(ctx, chatId, query.from.id))) {
      // A toast for the presser only, so the group is not spammed.
      await client.answerCallbackQuery({ callbackQueryId: query.id, text: WRITE_DENIED_TEXT });
      return;
    }
    if (data === CALLBACK_KIND.reassignShow) {
      // Tap on 👤 Reassign — switch the message keyboard to a list of agents.
      const context = await getMessageContext(ctx, chatId, query.message.message_id);
      if (!context || context.kind !== "assign_picker") {
        await client.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "Reassign menu has expired. Open the issue in Paperclip.",
          showAlert: true,
        });
        return;
      }
      const picker = buildAssignPickerMessage({
        identifier: context.identifier,
        agents: context.agents,
      });
      await client.editMessageReplyMarkup({
        chatId: String(query.message.chat.id),
        messageId: query.message.message_id,
        keyboard: picker.keyboard,
      });
      await client.answerCallbackQuery({ callbackQueryId: query.id });
      return;
    }
    if (data.startsWith(CALLBACK_KIND.assignAgentPrefix)) {
      const idx = Number.parseInt(
        data.slice(CALLBACK_KIND.assignAgentPrefix.length),
        10,
      );
      const context = await getMessageContext(ctx, chatId, query.message.message_id);
      if (
        !context ||
        context.kind !== "assign_picker" ||
        !Number.isFinite(idx) ||
        idx < 0 ||
        idx >= context.agents.length
      ) {
        await client.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "Reassign target unavailable.",
          showAlert: true,
        });
        return;
      }
      // Guard stale buttons: only act if this chat is still paired to the
      // context's company (it may have been unpaired or re-paired since).
      if (!isChatPairedToCompany(await readPairing(ctx), chatId, context.companyId)) {
        await client.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "This chat is no longer paired to that company.",
          showAlert: true,
        });
        return;
      }
      const target = context.agents[idx]!;
      try {
        await ctx.issues.update(
          context.issueId,
          { assigneeAgentId: target.id },
          context.companyId,
          { actorAgentId: target.id },
        );
        await client.editMessageReplyMarkup({
          chatId: String(query.message.chat.id),
          messageId: query.message.message_id,
          keyboard: undefined,
        });
        await client.sendMessage({
          chatId: String(query.message.chat.id),
          ...buildAssignedConfirmation({
            identifier: context.identifier,
            assigneeName: target.name,
          }),
          replyToMessageId: query.message.message_id,
        });
        await client.answerCallbackQuery({
          callbackQueryId: query.id,
          text: `Assigned to ${target.name}`,
        });
      } catch (err) {
        await client.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "Reassign failed — see Paperclip logs.",
          showAlert: true,
        });
        ctx.logger.warn("telegram-notifier: reassign failed", {
          err: errorText(err),
        });
      }
      return;
    }
    if (data === CALLBACK_KIND.replyToComment) {
      // Tap on 💬 Reply — send a force-reply prompt and copy the
      // comment_thread context onto the new message_id so the reply handler
      // resolves it back to the original Paperclip issue when the operator
      // sends their text.
      const context = await getMessageContext(ctx, chatId, query.message.message_id);
      if (!context || context.kind !== "comment_thread") {
        await client.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "Reply context expired. Use the standard quote-reply on the original notification instead.",
          showAlert: true,
        });
        return;
      }
      const sent = await client.sendMessage({
        chatId: String(query.message.chat.id),
        text: `*Reply to ${escapeMdText(context.identifier)}*\nSend your comment as the next message — it will post to Paperclip\\.`,
        forceReply: { placeholder: `Reply to ${context.identifier}` },
        replyToMessageId: query.message.message_id,
      });
      await saveMessageContext(ctx, chatId, sent.message_id, {
        kind: "comment_thread",
        companyId: context.companyId,
        issueId: context.issueId,
        identifier: context.identifier,
        createdAt: new Date().toISOString(),
      });
      await client.answerCallbackQuery({ callbackQueryId: query.id });
      return;
    }
    if (data === CALLBACK_KIND.showFullComment) {
      const context = await getMessageContext(ctx, chatId, query.message.message_id);
      if (
        !context ||
        context.kind !== "comment_thread" ||
        !context.fullBody
      ) {
        await client.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "Full body is no longer available.",
          showAlert: true,
        });
        return;
      }
      // Telegram caps single message at ~4096; chunk if larger.
      const chunks: string[] = [];
      const body = context.fullBody;
      const chunkSize = 3500;
      for (let i = 0; i < body.length; i += chunkSize) {
        chunks.push(body.slice(i, i + chunkSize));
      }
      for (let i = 0; i < chunks.length; i++) {
        await client.sendMessage({
          chatId,
          text:
            (i === 0
              ? `*📄 Full comment on ${escapeMdText(context.identifier)}*\n\n`
              : "") + escapeMdText(chunks[i]!),
          replyToMessageId: i === 0 ? query.message.message_id : undefined,
        });
      }
      await client.answerCallbackQuery({ callbackQueryId: query.id });
      return;
    }
    if (data === CALLBACK_KIND.confirmAccept) {
      const context = await getMessageContext(ctx, chatId, query.message.message_id);
      if (!context || context.kind !== "confirmation_decision") {
        await client.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "Confirmation context expired. Open the issue in Paperclip.",
          showAlert: true,
        });
        return;
      }
      if (!(await assertConfirmationAuthorized(ctx, client, query, chatId, context.companyId))) {
        return;
      }
      const result = await acceptInteraction(
        config,
        context.issueId,
        context.interactionId,
      );
      if (!result.ok) {
        await client.answerCallbackQuery({
          callbackQueryId: query.id,
          text: `Approve failed: ${errorText(result.error ?? "unknown error")}`.slice(0, 200),
          showAlert: true,
        });
        return;
      }
      const decider = telegramUserLabel(query.from);
      const closeout = buildConfirmationDecidedMessage({
        outcome: "approved",
        identifier: context.identifier,
        title: context.title,
        decider,
        promptText: context.promptText,
      });
      try {
        await client.editMessageText({
          chatId: String(query.message.chat.id),
          messageId: query.message.message_id,
          text: closeout.text,
          keyboard: closeout.keyboard,
        });
      } catch (err) {
        ctx.logger.warn("telegram-notifier: edit approve closeout failed", {
          err: errorText(err),
        });
      }
      await client.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Approved",
      });
      return;
    }
    if (data === CALLBACK_KIND.confirmDecline) {
      const context = await getMessageContext(ctx, chatId, query.message.message_id);
      if (!context || context.kind !== "confirmation_decision") {
        await client.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "Confirmation context expired. Open the issue in Paperclip.",
          showAlert: true,
        });
        return;
      }
      if (!(await assertConfirmationAuthorized(ctx, client, query, chatId, context.companyId))) {
        return;
      }
      const decliner = telegramUserLabel(query.from);
      const sent = await client.sendMessage({
        chatId: String(query.message.chat.id),
        text: `*Decline ${escapeMdText(context.identifier)}*\nReply with the reason\\. The interaction will be rejected when you send your reason\\.`,
        forceReply: { placeholder: `Reason for declining ${context.identifier}` },
        replyToMessageId: query.message.message_id,
      });
      await saveMessageContext(ctx, chatId, sent.message_id, {
        kind: "confirmation_decline_reason",
        companyId: context.companyId,
        issueId: context.issueId,
        interactionId: context.interactionId,
        identifier: context.identifier,
        title: context.title,
        originalMessageId: query.message.message_id,
        promptText: context.promptText,
        decliner,
        createdAt: new Date().toISOString(),
      });
      await client.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Reply with the decline reason",
      });
      return;
    }
    // Unknown callback — ack silently to clear the loading spinner.
    await client.answerCallbackQuery({ callbackQueryId: query.id });
  } catch (err) {
    ctx.logger.warn("telegram-notifier: callback handler failed", {
      data,
      err: errorText(err),
    });
    await client
      .answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Action failed — see Paperclip logs.",
        showAlert: true,
      })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Polling job
// ---------------------------------------------------------------------------

/**
 * Companies sharing one bot are polled together. A group holds no token:
 * `companyIds` lists the companies on this bot (the first one's secret is
 * used for the bot's own requests) and `stored` holds each company's config
 * as stored, without the secret resolved.
 */
export interface BotGroup {
  botId: string;
  companyIds: string[];
  stored: Map<string, StoredPluginConfig>;
}

/**
 * Build the poll groups from the companies the plugin is working for: every
 * paired company plus the target of an in-flight handshake. Config is
 * company-scoped, and a scheduled job has no company context, so each read
 * names its company. The host allows such proactive reads only for companies
 * that have saved plugin config; a company without config is skipped. The
 * token is resolved once per company to learn its bot id, then dropped.
 */
export async function collectBotGroups(ctx: PluginContext): Promise<BotGroup[]> {
  const state = await readPairing(ctx);
  const companyIds = new Set(Object.keys(state.pairedByCompany ?? {}));
  if (state.pairing && !isHandshakeExpired(state.pairing)) {
    companyIds.add(state.pairing.targetCompanyId);
  }
  const groups = new Map<string, BotGroup>();
  for (const companyId of companyIds) {
    let botId: string;
    let stored: StoredPluginConfig;
    try {
      stored = await loadRawConfig(ctx, companyId);
      const config = await loadConfig(ctx, companyId);
      if (!config.botToken) continue;
      botId = botIdFromToken(config.botToken);
    } catch (err) {
      ctx.logger.debug("telegram-notifier: no readable config for company", {
        companyId,
        err: errorText(err),
      });
      continue;
    }
    let group = groups.get(botId);
    if (!group) {
      group = { botId, companyIds: [], stored: new Map() };
      groups.set(botId, group);
    }
    group.companyIds.push(companyId);
    group.stored.set(companyId, stored);
  }
  return [...groups.values()];
}

/**
 * The company an update belongs to: the company its chat is paired to, else
 * the target of a live handshake. `null` means no company yet (an unpaired
 * chat with no handshake); `undefined` means the update has no chat.
 */
function companyForUpdate(
  state: PairingState,
  update: TelegramUpdate,
): string | null | undefined {
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
  if (!chat) return undefined;
  const paired = findCompanyForChat(state, String(chat.id));
  if (paired) return paired.companyId;
  if (state.pairing && !isHandshakeExpired(state.pairing)) {
    return state.pairing.targetCompanyId;
  }
  return null;
}

/**
 * Load a company's config for one poller operation. A rate-limited secret
 * resolution waits with backoff and retries while the poll loop's deadline
 * allows; any other failure is thrown.
 */
async function loadConfigWithBackoff(
  ctx: PluginContext,
  companyId: string,
  deadline: number,
): Promise<PluginConfig> {
  let delay = outboundQueueSettings.initialBackoffMs;
  for (;;) {
    try {
      return await loadConfig(ctx, companyId);
    } catch (err) {
      if (!isRateLimitError(err) || Date.now() + delay >= deadline) throw err;
      ctx.logger.debug("telegram-notifier: secret resolution rate-limited, backing off", {
        companyId,
        delayMs: delay,
      });
      await sleep(delay);
      delay = nextBackoff(delay);
    }
  }
}

/**
 * Pick the config an update is handled with. A chat paired to a company
 * that uses a different bot is ignored, so one company's bot never reads or
 * acts on another company's data. A chat with no company yet is answered
 * with the group's first company's config. `batch` holds the configs
 * resolved for the update batch being handled, so each company's secret is
 * resolved at most once per batch; the caller drops it after the batch.
 *
 * A rate-limited resolution that outlasts the poll deadline is thrown: the
 * update is not handled yet and must stay unconfirmed. Any other failure
 * (secret deleted, disabled, or another bot) returns `undefined`, and the
 * update is skipped for good.
 */
export async function resolveUpdateConfig(
  ctx: PluginContext,
  state: PairingState,
  update: TelegramUpdate,
  group: BotGroup,
  batch: Map<string, PluginConfig>,
  deadline = Date.now() + POLL_LOOP_DEADLINE_MS,
): Promise<PluginConfig | undefined> {
  const updateCompanyId = companyForUpdate(state, update);
  if (updateCompanyId === undefined) return undefined;
  const companyId = updateCompanyId ?? group.companyIds[0];
  if (!companyId) return undefined;
  const known = batch.get(companyId);
  if (known) return known;
  try {
    const config = await loadConfigWithBackoff(ctx, companyId, deadline);
    if (config.botToken && botIdFromToken(config.botToken) === group.botId) {
      batch.set(companyId, config);
      return config;
    }
  } catch (err) {
    if (isRateLimitError(err)) throw err;
    ctx.logger.debug("telegram-notifier: no readable config for company", {
      companyId,
      err: errorText(err),
    });
  }
  return undefined;
}

async function runPollUpdates(
  ctx: PluginContext,
  outbound: OutboundQueue,
): Promise<void> {
  const groups = await collectBotGroups(ctx);
  if (groups.length === 0) {
    ctx.logger.debug("telegram-notifier: no configured bot to poll");
    return;
  }
  await Promise.all(groups.map((group) => pollBot(ctx, group, outbound)));
}

/**
 * One poll as one operation: resolve the group's secret, check it still
 * names this bot, and long-poll. The returned config is used for the batch
 * the call returned and dropped with it. Returns null when the secret is
 * gone (deleted, disabled, or no longer this bot).
 */
async function fetchUpdates(
  ctx: PluginContext,
  group: BotGroup,
  offset: number | undefined,
  timeoutSec: number,
  deadline: number,
): Promise<{ updates: TelegramUpdate[]; config: PluginConfig } | null> {
  let config: PluginConfig;
  try {
    config = await loadConfigWithBackoff(ctx, group.companyIds[0]!, deadline);
  } catch (err) {
    if (isRateLimitError(err)) throw err;
    return null;
  }
  if (!config.botToken || botIdFromToken(config.botToken) !== group.botId) return null;
  const client = await createTelegramClient(ctx, config.botToken);
  return { updates: await client.getUpdates(offset, timeoutSec), config };
}

/**
 * Handle one update batch in update_id order; configs resolved for it are
 * dropped on return. Returns the id of the last update that is done
 * (handled, failed in its handler, or skipped), so the caller confirms
 * nothing past it. Handling stops at the first update whose config is
 * rate-limited: that update and the ones after it stay unconfirmed, and
 * Telegram sends them again on the next poll.
 */
async function handleUpdateBatch(
  ctx: PluginContext,
  group: BotGroup,
  updates: TelegramUpdate[],
  batch: Map<string, PluginConfig>,
  deadline: number,
): Promise<{ doneThrough?: number; blocked: boolean }> {
  let doneThrough: number | undefined;
  for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
    let config: PluginConfig | undefined;
    try {
      config = await resolveUpdateConfig(
        ctx,
        await readPairing(ctx),
        update,
        group,
        batch,
        deadline,
      );
    } catch (err) {
      if (isRateLimitError(err)) {
        ctx.logger.warn("telegram-notifier: secret resolution rate-limited, update kept for the next poll", {
          botId: group.botId,
          updateId: update.update_id,
        });
        return { doneThrough, blocked: true };
      }
      ctx.logger.warn("telegram-notifier: update handler failed", {
        updateId: update.update_id,
        err: errorText(err),
      });
    }
    if (config) {
      try {
        if (update.message) {
          await handleMessage(ctx, config, update.message);
        } else if (update.callback_query) {
          await handleCallbackQuery(ctx, config, update.callback_query);
        }
      } catch (err) {
        ctx.logger.warn("telegram-notifier: update handler failed", {
          updateId: update.update_id,
          err: errorText(err),
        });
      }
    }
    doneThrough = update.update_id;
  }
  return { doneThrough, blocked: false };
}

async function pollBot(
  ctx: PluginContext,
  group: BotGroup,
  outbound: OutboundQueue,
): Promise<void> {
  const deadline = Date.now() + POLL_LOOP_DEADLINE_MS;
  const primaryCompanyId = group.companyIds[0]!;
  if (!getBotState(await readPairing(ctx), group.botId).username) {
    await ensureBotBootstrap(ctx, await loadConfigWithBackoff(ctx, primaryCompanyId, deadline));
  }

  // Morning digest is independent of inbound polling; it is checked once
  // per cron tick and, when due, sent through the company's outbound queue.
  for (const [companyId, stored] of group.stored) {
    await runMorningDigestIfDue(ctx, stored, companyId, outbound);
  }

  // Long-poll loop: keep getUpdates open for up to POLL_TIMEOUT_SEC and process
  // anything that arrives. Exits before the next cron tick fires so two
  // jobs don't overlap. An idle bot makes about three requests (and three
  // secret resolutions) per cycle, well under the host's 30 per minute.
  let backoff = outboundQueueSettings.initialBackoffMs;
  while (Date.now() < deadline) {
    const state = await readPairing(ctx);
    if (state.pairing && isHandshakeExpired(state.pairing)) {
      await clearHandshake(ctx);
    }
    const lastUpdateId = getBotState(state, group.botId).lastUpdateId;
    const offset = lastUpdateId !== undefined ? lastUpdateId + 1 : undefined;

    let polled: Awaited<ReturnType<typeof fetchUpdates>>;
    try {
      // End the last long poll before the deadline so cycles never overlap.
      const remainingSec = Math.floor((deadline - Date.now()) / 1000) - 1;
      if (remainingSec < 1) break;
      polled = await fetchUpdates(
        ctx,
        group,
        offset,
        Math.min(POLL_TIMEOUT_SEC, remainingSec),
        deadline,
      );
      backoff = outboundQueueSettings.initialBackoffMs;
    } catch (err) {
      ctx.logger.warn("telegram-notifier: getUpdates failed", {
        botId: group.botId,
        err: errorText(err),
      });
      // Back off on rate limits and transport errors so we don't busy-loop.
      await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())));
      backoff = nextBackoff(backoff);
      continue;
    }
    if (polled === null) {
      // A deleted or disabled secret ends this cycle: nothing polls with it.
      ctx.logger.warn("telegram-notifier: bot token secret unavailable, polling stopped", {
        botId: group.botId,
      });
      break;
    }

    // The primary company's config was resolved for this poll; reuse it for
    // the batch instead of resolving the same secret again.
    const { doneThrough, blocked } = await handleUpdateBatch(
      ctx,
      group,
      polled.updates,
      new Map([[primaryCompanyId, polled.config]]),
      deadline,
    );
    // The next getUpdates offset confirms everything up to the saved id, so
    // the cursor never moves past an update that was not handled.
    if (doneThrough !== undefined && doneThrough !== lastUpdateId) {
      await patchBotState(ctx, group.botId, { lastUpdateId: doneThrough });
    }
    // Rate-limited: the secret budget is spent. The next poll job retries
    // from the first unhandled update.
    if (blocked) break;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Morning digest
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function localDateKey(date: Date): string {
  // YYYY-MM-DD in server local time. Used to dedupe digest sends per day.
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function isWithinLastNHours(value: Date | string | null | undefined, hours: number, now: Date): boolean {
  if (!value) return false;
  const ts = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (!Number.isFinite(ts)) return false;
  return now.getTime() - ts <= hours * 60 * 60 * 1000;
}

/**
 * Build + send the morning digest for a single company. Returns a small
 * summary so callers can surface it (UI button, log line). When `force` is
 * true, the daily dedup guard is skipped so the operator can preview the
 * digest from the settings page without waiting for the scheduled hour.
 */
const DIGEST_PAGE_SIZE = 200;
/** Most issues read per digest section; a capped section says so. */
export const DIGEST_SECTION_CAP = 1000;

export interface DigestIssues {
  doneYesterday: Issue[];
  inProgress: Issue[];
  todo: Issue[];
  /** True when a section reached DIGEST_SECTION_CAP and may be incomplete. */
  capped: boolean;
}

/**
 * Read each digest section by status, page by page. One unfiltered page
 * would be sorted by priority, so old high-priority issues could push
 * current work and yesterday's completions out of it.
 */
export async function collectDigestIssues(
  ctx: PluginContext,
  companyId: string,
  now: Date,
): Promise<DigestIssues> {
  let capped = false;
  const readStatus = async (status: Issue["status"]): Promise<Issue[]> => {
    const out: Issue[] = [];
    while (out.length < DIGEST_SECTION_CAP) {
      const page = await ctx.issues.list({
        companyId,
        status,
        limit: DIGEST_PAGE_SIZE,
        offset: out.length,
      });
      out.push(...page);
      if (page.length < DIGEST_PAGE_SIZE) return out;
    }
    capped = true;
    return out;
  };
  const [done, inProgress, todo] = await Promise.all([
    readStatus("done"),
    readStatus("in_progress"),
    readStatus("todo"),
  ]);
  return {
    doneYesterday: done.filter((i) => isWithinLastNHours(i.completedAt, 36, now)),
    inProgress,
    todo,
    capped,
  };
}

async function sendDigestForCompany(
  ctx: PluginContext,
  config: PluginConfig,
  companyId: string,
  options: { force?: boolean } = {},
): Promise<{ sent: boolean; reason?: string; counts?: { done: number; inProgress: number; todo: number } }> {
  const state = await readPairing(ctx);
  const chat = getPaired(state, companyId);
  if (!chat) return { sent: false, reason: "Company has no paired chat." };

  const now = new Date();
  const today = localDateKey(now);
  if (!options.force) {
    if (chat.lastDigestSentOn === today) {
      return { sent: false, reason: "Digest already sent today." };
    }
  }

  let digest: DigestIssues;
  try {
    // Company-wide digest, not personal. Top-of-chain operators (CEO /
    // PS Lead / PS Manager) typically don't carry tickets directly — their
    // reports do. Filtering by `assigneeAgentId == operateAsAgentId`
    // produced 0/0/0 every morning for those operators because their
    // personal queue was always empty even when the company shipped.
    digest = await collectDigestIssues(ctx, companyId, now);
  } catch (err) {
    ctx.logger.warn("telegram-notifier: digest issue.list failed", {
      companyId,
      err: errorText(err),
    });
    return { sent: false, reason: "Failed to read issues." };
  }

  const { doneYesterday, inProgress, todo, capped } = digest;

  const toDigest = (i: Issue) => ({
    identifier: i.identifier ?? i.id.slice(0, 8),
    title: i.title,
    status: i.status,
  });

  const message = buildMorningDigest({
    date: today,
    doneYesterday: doneYesterday.map(toDigest),
    inProgress: inProgress.map(toDigest),
    todo: todo.map(toDigest),
    cappedAt: capped ? DIGEST_SECTION_CAP : undefined,
  });

  try {
    await sendToCompanyChat(ctx, config, companyId, message);
    await patchPairedChat(ctx, companyId, { lastDigestSentOn: today });
    ctx.logger.info("telegram-notifier: digest sent", {
      companyId,
      done: doneYesterday.length,
      inProgress: inProgress.length,
      todo: todo.length,
      forced: !!options.force,
    });
    return {
      sent: true,
      counts: {
        done: doneYesterday.length,
        inProgress: inProgress.length,
        todo: todo.length,
      },
    };
  } catch (err) {
    ctx.logger.warn("telegram-notifier: digest send failed", {
      companyId,
      err: errorText(err),
    });
    return {
      sent: false,
      reason: errorText(err),
    };
  }
}

async function runMorningDigestIfDue(
  ctx: PluginContext,
  stored: StoredPluginConfig,
  companyId: string,
  outbound: OutboundQueue,
): Promise<void> {
  const digest = stored.morningDigest;
  if (!digest?.enabled) return;

  const now = new Date();
  const targetHour = digest.hour ?? 8;
  if (now.getHours() !== targetHour) return;
  if (digest.weekdaysOnly !== false) {
    const day = now.getDay(); // 0 Sun, 6 Sat
    if (day === 0 || day === 6) return;
  }

  const chat = getPaired(await readPairing(ctx), companyId);
  if (!chat?.operateAsAgentId || chat.lastDigestSentOn === localDateKey(now)) return;
  // Not awaited: a rate-limited queue must not hold up the poll loop. A
  // digest queued twice sends once, because the send re-checks the date.
  void outbound.enqueue(companyId, async (config) => {
    await sendDigestForCompany(ctx, config, companyId);
  });
}

// ---------------------------------------------------------------------------
// Plugin entrypoint
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("telegram-notifier: starting");

    // Companies whose bot token secret failed to resolve (deleted, disabled
    // or missing) on the last outbound drain; shown as `tokenError`.
    const unresolvedTokenCompanies = new Set<string>();
    const outbound = createOutboundQueue({
      logger: ctx.logger,
      loadConfig: (companyId) => loadConfig(ctx, companyId),
      onResolveFailure: (companyId) => unresolvedTokenCompanies.add(companyId),
      onResolveSuccess: (companyId) => unresolvedTokenCompanies.delete(companyId),
    });

    // Decide whether an event needs a message before resolving the bot
    // secret: the host rate-limits secret resolution per company, and most
    // events (an `issue.updated` without an assignment, an unpaired company)
    // send nothing. A message that is needed goes through the company's
    // outbound queue, which resolves the secret once per drain cycle.
    const guarded =
      <T extends PluginEvent>(
        flag: NotifyFlag,
        fn: (
          ctx: PluginContext,
          config: PluginConfig,
          event: T,
        ) => Promise<void>,
        relevant: (event: T) => boolean = () => true,
      ) =>
      async (event: T) => {
        try {
          const stored = await loadRawConfig(ctx, event.companyId);
          if (!notifyEnabled(stored, flag) || !relevant(event)) return;
          if (!getPaired(await readPairing(ctx), event.companyId)) return;
          await outbound.enqueue(event.companyId, async (config) => {
            if (config.botToken) await fn(ctx, config, event);
          });
        } catch (err) {
          ctx.logger.warn("telegram-notifier: handler failed", {
            eventType: event.eventType,
            err: errorText(err),
          });
        }
      };

    ctx.events.on(
      "approval.created",
      guarded("approvals", onApprovalCreated, (event) => {
        const kind = asString(asRecord(event.payload)?.interactionKind);
        return !kind || kind === "request_confirmation";
      }),
    );
    ctx.events.on(
      "issue.updated",
      guarded("assignedToYou", onIssueUpdated, (event) =>
        agentAssigneeChange(event.payload) !== null,
      ),
    );
    ctx.events.on("issue.comment.created", guarded("comments", onCommentCreated));
    ctx.events.on("agent.run.failed", guarded("runFailures", onAgentRunFailed));
    ctx.events.on("budget.incident.opened", guarded("budgetIncidents", onBudgetIncident));
    ctx.events.on(
      "issue.assignment_wakeup_requested",
      guarded("wakeRequests", onWakeupRequested),
    );

    ctx.jobs.register(JOB_KEYS.pollUpdates, async () => {
      await runPollUpdates(ctx, outbound);
    });

    // Agent tools act on the calling agent's company only. The host supplies
    // it in `runCtx.companyId`; a `companyId` argument is accepted for
    // backward compatibility but must match, so an agent cannot reach into
    // another company's pairing (pairing state is instance-scoped, so the
    // host's company check does not cover it).
    const noParamsSchema = { type: "object", properties: {} } as const;
    const COMPANY_MISMATCH_ERROR =
      "companyId must be the calling agent's own company.";

    function toolCompanyId(
      params: unknown,
      runCtx: ToolRunContext,
    ): string | null {
      const requested = (params as { companyId?: unknown } | null)?.companyId;
      if (
        typeof requested === "string" &&
        requested.length > 0 &&
        requested !== runCtx.companyId
      ) {
        return null;
      }
      return runCtx.companyId;
    }

    async function botUsernameFor(companyId: string): Promise<string | undefined> {
      const config = await loadConfig(ctx, companyId);
      if (!config.botToken) return undefined;
      return getBotState(await readPairing(ctx), botIdFromToken(config.botToken))
        .username;
    }
    const confirmSchema = {
      type: "object",
      required: ["code"],
      properties: {
        code: { type: "string" },
      },
    } as const;

    // ─── getStatus ──────────────────────────────────────────────────────
    ctx.tools.register(
      TOOL_NAMES.getStatus,
      {
        displayName: "Telegram pairing status",
        description:
          "Returns the bot username, this company's paired chat, and any in-flight handshake for it.",
        parametersSchema: noParamsSchema,
      },
      async (params, runCtx) => {
        const companyId = toolCompanyId(params, runCtx);
        if (!companyId) return { error: COMPANY_MISMATCH_ERROR };
        const state = await readPairing(ctx);
        const chat = getPaired(state, companyId);
        // SECURITY: never include the live verification `code` in tool
        // output. The handshake is two-endpoint by design — anyone able to
        // read the code outside of Telegram could call confirmPairing and
        // skip the Telegram half.
        const handshake =
          state.pairing &&
          state.pairing.targetCompanyId === companyId &&
          !isHandshakeExpired(state.pairing)
            ? {
                stage: state.pairing.stage,
                expiresAt: state.pairing.expiresAt,
                ...(state.pairing.stage === "code_sent"
                  ? { candidateChatLabel: state.pairing.candidateLabel }
                  : {}),
              }
            : undefined;
        return {
          content: chat
            ? `Paired with ${chat.chatLabel}.`
            : "This company has no paired Telegram chat.",
          data: {
            botUsername: await botUsernameFor(companyId),
            paired: chat
              ? {
                  companyId,
                  chatLabel: chat.chatLabel,
                  pairedAt: chat.pairedAt,
                  operateAsAgentId: chat.operateAsAgentId,
                }
              : null,
            handshake,
          },
        };
      },
    );

    // ─── startPairing ───────────────────────────────────────────────────
    ctx.tools.register(
      TOOL_NAMES.startPairing,
      {
        displayName: "Start Telegram pairing",
        description:
          "Begins a handshake for the calling agent's company. Send any message to the bot afterward.",
        parametersSchema: noParamsSchema,
      },
      async (params, runCtx) => {
        const companyId = toolCompanyId(params, runCtx);
        if (!companyId) return { error: COMPANY_MISMATCH_ERROR };
        try {
          const started = await doStartPairing(companyId);
          return {
            content: started.botUsername
              ? `Pairing started for ${started.companyName ?? companyId}. Open @${started.botUsername} in Telegram, send any message, then confirm with the code. Window: 10 minutes.`
              : "Pairing started. Send any message to your bot, then confirm with the code.",
            data: {
              stage: "awaiting_chat",
              companyId,
              botUsername: started.botUsername,
              telegramUrl: started.botUsername
                ? `https://t.me/${started.botUsername}`
                : undefined,
            },
          };
        } catch (err) {
          return { error: errorText(err) };
        }
      },
    );

    // ─── confirmPairing ─────────────────────────────────────────────────
    ctx.tools.register(
      TOOL_NAMES.confirmPairing,
      {
        displayName: "Confirm Telegram pairing",
        description: "Validates the verification code from Telegram.",
        parametersSchema: confirmSchema,
      },
      async (params, runCtx) => {
        const code =
          typeof (params as { code?: unknown })?.code === "string"
            ? ((params as { code: string }).code as string)
            : "";
        if (!code) return { error: "code parameter is required." };
        try {
          const { paired } = await doConfirmPairing(code, runCtx.companyId);
          return {
            content: `Paired ${paired.companyName ?? paired.companyId} with ${paired.chatLabel}.`,
            data: { paired: true, ...paired },
          };
        } catch (err) {
          return { error: errorText(err) };
        }
      },
    );

    // ─── unpair ─────────────────────────────────────────────────────────
    ctx.tools.register(
      TOOL_NAMES.unpair,
      {
        displayName: "Unpair Telegram chat",
        description: "Disconnects the chat paired with the calling agent's company.",
        parametersSchema: noParamsSchema,
      },
      async (params, runCtx) => {
        const companyId = toolCompanyId(params, runCtx);
        if (!companyId) return { error: COMPANY_MISMATCH_ERROR };
        const result = await doUnpairCompany(companyId);
        return {
          content: result.previousLabel
            ? `Unpaired ${result.previousLabel}.`
            : "No chat was paired for this company.",
          data: { paired: false, companyId },
        };
      },
    );

    // ─── sendTest ───────────────────────────────────────────────────────
    ctx.tools.register(
      TOOL_NAMES.sendTest,
      {
        displayName: "Send Telegram test notification",
        description: "Sends a sample notification to the calling agent's company chat.",
        parametersSchema: noParamsSchema,
      },
      async (params, runCtx) => {
        const companyId = toolCompanyId(params, runCtx);
        if (!companyId) return { error: COMPANY_MISMATCH_ERROR };
        try {
          const result = await doSendTestForCompany(companyId);
          return {
            content: `Test message sent to ${result.chatLabel}.`,
            data: { sent: true, companyId },
          };
        } catch (err) {
          return {
            content: `Not sent: ${errorText(err)}`,
            data: { sent: false, companyId },
          };
        }
      },
    );

    // ─── getApprovalConfig (agent-callable) ─────────────────────────────
    //
    // Agents call this before posting their plan to discover (a) whether
    // they're configured to gate at all, (b) who to @-mention as approver,
    // and (c) which template to use. AGENTS.md instructions reference this
    // tool by name — the plugin is the source of truth for approval policy.
    ctx.tools.register(
      TOOL_NAMES.getApprovalConfig,
      {
        displayName: "Get plan-approval config",
        description:
          "Returns the configured approver and whether the calling agent must gate plans before acting. Resolves for the calling agent unless `agentId` names another agent.",
        parametersSchema: {
          type: "object",
          properties: {
            agentId: { type: "string" },
          },
        },
      },
      async (params, runCtx) => {
        const p = (params ?? {}) as { agentId?: string };
        const companyId = toolCompanyId(params, runCtx);
        if (!companyId) return { error: COMPANY_MISMATCH_ERROR };
        // The caller is the default subject: the generated instructions call
        // this tool without `agentId`, and a gated agent must still be told so.
        const agentId = p.agentId || runCtx.agentId;
        const state = await readPairing(ctx);
        const config = getApprovalConfig(state, companyId);
        const approver = await resolveApprover(companyId, config);
        const enabled = config?.enabled === true;
        const requiresApproval = !!(
          enabled &&
          agentId &&
          config?.agents?.[agentId]?.requiresApproval
        );
        const template = agentId
          ? templateForAgent(config, agentId)
          : DEFAULT_PLAN_TEMPLATE;
        return {
          content: enabled
            ? requiresApproval
              ? `Gate is ON. Post plan, then request_confirmation. Approver: ${approver?.name ?? "(unresolved)"}.`
              : `Gate is OFF for this agent. Proceed without confirmation.`
            : `Approval workflow is not enabled for this company.`,
          data: {
            enabled,
            requiresApproval,
            approver,
            template,
          },
        };
      },
    );

    // ─── UI bridge: data + actions for the settings page ────────────────
    //
    // The settings page renders the same operations as the agent tools, but
    // through ctx.data / ctx.actions so the UI can use usePluginData /
    // usePluginAction hooks. Worker logic is shared via small inner helpers
    // that return JSON-serializable shapes.

    // ─── Companies — populated via plugin bridge ──────────────────────
    //
    // Archived companies are intentionally excluded: pairing a Telegram chat
    // with an archived company is almost always a mistake (it would receive
    // notifications no one is acting on). If a previously paired company is
    // archived later, its pairing record is preserved in state but stops
    // being routable through the UI until the company is unarchived.
    //
    // The host scopes every settings-page request to the company selected in
    // the dashboard (and overrides `companyId` in action params with it), so
    // the page shows and acts on that company only.
    ctx.data.register("companies", async (params) => {
      const companyId = (params as { companyId?: unknown })?.companyId;
      if (typeof companyId !== "string" || !companyId) return { items: [] };
      const company = await ctx.companies.get(companyId);
      const state = await readPairing(ctx);
      return {
        items: (company ? [company] : [])
          .filter((c) => (c as { status?: string }).status !== "archived")
          .map((c) => {
            const chat = getPaired(state, c.id);
            return {
              id: c.id,
              name: c.name,
              paired: !!chat,
              chatLabel: chat?.chatLabel,
              operateAsAgentId: chat?.operateAsAgentId,
              operateAsAgentLabel: chat?.operateAsAgentLabel,
              pairedAt: chat?.pairedAt,
            };
          }),
      };
    });

    // ─── Agents dropdown — populated via plugin bridge ────────────────
    //
    // The operate-as agent is the persona the bot impersonates when it
    // creates issues from `/new` (e.g. the company's CEO agent). Listed
    // per company via `ctx.agents.list({ companyId })`, scoped to the
    // company the operator is configuring on a given row.
    ctx.data.register("agents", async (params) => {
      const companyId =
        typeof (params as { companyId?: unknown })?.companyId === "string"
          ? ((params as { companyId: string }).companyId as string)
          : undefined;
      if (!companyId) return { items: [] };
      try {
        const agents = await ctx.agents.list({ companyId });
        return {
          items: agents.map((a) => ({
            id: a.id,
            label: a.name,
            role: a.role,
            title: a.title ?? null,
          })),
        };
      } catch (err) {
        ctx.logger.warn("telegram-notifier: agents.list failed", {
          companyId,
          err: errorText(err),
        });
        return { items: [] };
      }
    });

    /**
     * Resolve the approver agent for a company. Resolution order:
     *   1. The company's operate-as agent (if paired and set) — this is the
     *      primary path. The operate-as agent is the persona the operator
     *      already trusts to act for the org, so it's the natural approver.
     *   2. Explicit `approverAgentId` in approval config (legacy escape hatch).
     *   3. Role-based fallback: exact `ceo` match, then any role containing
     *      `lead` (covers `team-lead`, `tech-lead`, etc.).
     */
    async function resolveApprover(
      companyId: string,
      config: ApprovalConfig | undefined,
    ): Promise<{ id: string; name: string } | null> {
      try {
        const state = await readPairing(ctx);
        const operateAsId = getPaired(state, companyId)?.operateAsAgentId;
        const agents = await ctx.agents.list({ companyId });
        if (operateAsId) {
          const operateAs = agents.find((a) => a.id === operateAsId);
          if (operateAs) return { id: operateAs.id, name: operateAs.name };
        }
        if (config?.approverAgentId) {
          const explicit = agents.find((a) => a.id === config.approverAgentId);
          if (explicit) return { id: explicit.id, name: explicit.name };
        }
        const exactCeo = agents.find(
          (a) => (a.role ?? "").toLowerCase() === "ceo",
        );
        const anyLead = agents.find((a) =>
          (a.role ?? "").toLowerCase().includes("lead"),
        );
        const fallback = exactCeo ?? anyLead;
        return fallback ? { id: fallback.id, name: fallback.name } : null;
      } catch (err) {
        ctx.logger.warn("telegram-notifier: resolveApprover failed", {
          companyId,
          err: errorText(err),
        });
        return null;
      }
    }

    function templateForAgent(
      config: ApprovalConfig | undefined,
      agentId: string,
    ): string {
      const override = config?.agents?.[agentId]?.template;
      return override && override.trim().length > 0
        ? override
        : DEFAULT_PLAN_TEMPLATE;
    }

    /**
     * Per-company approval config for the settings UI. Includes resolved
     * approver and the canonical AGENTS.md snippet so the UI can render the
     * Copy-snippet button with substituted template per agent.
     */
    ctx.data.register("approvalConfig", async (params) => {
      const companyId =
        typeof (params as { companyId?: unknown })?.companyId === "string"
          ? ((params as { companyId: string }).companyId as string)
          : undefined;
      if (!companyId) {
        return {
          config: null,
          agents: [],
          resolvedApprover: null,
          defaultTemplate: DEFAULT_PLAN_TEMPLATE,
          snippetWrapper: AGENTS_MD_SNIPPET,
          companyPrefix: null,
          dashboardBaseUrl: "http://localhost:3100",
        };
      }
      const state = await readPairing(ctx);
      const config = getApprovalConfig(state, companyId);
      let agents: Array<{ id: string; label: string; role?: string }> = [];
      try {
        const list = await ctx.agents.list({ companyId });
        agents = list.map((a) => ({ id: a.id, label: a.name, role: a.role }));
      } catch {
        /* best-effort */
      }
      // companyPrefix (issuePrefix) drives the dashboard URL pattern
      // <base>/<prefix>/agents/<id>/instructions for the Edit-instructions
      // quick link surfaced next to Copy snippet.
      let companyPrefix: string | null = null;
      try {
        const company = await ctx.companies.get(companyId);
        companyPrefix =
          (company as { issuePrefix?: string } | null)?.issuePrefix ?? null;
      } catch {
        /* best-effort */
      }
      const pluginConfig = await loadRawConfig(ctx, companyId);
      const dashboardBaseUrl =
        pluginConfig.paperclipBaseUrl ?? "http://localhost:3100";
      const resolvedApprover = await resolveApprover(companyId, config);
      return {
        config: config ?? null,
        agents,
        resolvedApprover,
        defaultTemplate: DEFAULT_PLAN_TEMPLATE,
        snippetWrapper: AGENTS_MD_SNIPPET,
        companyPrefix,
        dashboardBaseUrl,
      };
    });

    /**
     * Persist per-company approval config. The UI calls this whenever the
     * operator toggles enabled, picks an approver, or edits per-agent
     * participation/templates. Replaces the whole config blob — caller
     * should send the merged value, not a patch.
     */
    ctx.actions.register("setApprovalConfig", async (params) => {
      const p = (params ?? {}) as {
        companyId?: string;
        config?: ApprovalConfig;
      };
      if (!p.companyId) throw new Error("companyId is required");
      if (!p.config || typeof p.config !== "object") {
        throw new Error("config is required");
      }
      const safe: ApprovalConfig = {
        enabled: p.config.enabled === true,
        approverAgentId:
          typeof p.config.approverAgentId === "string"
            ? p.config.approverAgentId
            : null,
        agents: {},
      };
      const inAgents = (p.config.agents ?? {}) as Record<string, unknown>;
      for (const [agentId, raw] of Object.entries(inAgents)) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as { requiresApproval?: unknown; template?: unknown };
        safe.agents[agentId] = {
          requiresApproval: r.requiresApproval === true,
          template: typeof r.template === "string" ? r.template : undefined,
        };
      }
      await setApprovalConfig(ctx, p.companyId, safe);
      return { ok: true, companyId: p.companyId };
    });

    /**
     * Update the operate-as agent for a paired company. The UI calls this
     * with `{ companyId, agentId, agentLabel }` after the operator picks
     * an agent from the dropdown. Issues created from `/new` are then
     * assigned to and attributed to that agent.
     */
    ctx.actions.register("setOperateAsForCompany", async (params) => {
      const p = (params ?? {}) as {
        companyId?: string;
        agentId?: string;
        agentLabel?: string;
      };
      if (!p.companyId) {
        throw new Error("companyId is required");
      }
      const updated = await patchPairedChat(ctx, p.companyId, {
        operateAsAgentId: p.agentId,
        operateAsAgentLabel: p.agentLabel,
      });
      if (!updated) throw new Error("Company is not paired yet");
      return { ok: true, companyId: p.companyId, operateAsAgentId: p.agentId };
    });

    /**
     * Status data — combines token state, bot username, in-flight handshake,
     * and per-company paired chats. Drives the entire settings UI.
     */
    ctx.data.register("status", async (params) => {
      const companyId = requireCompanyParam(params);
      const config = await loadRawConfig(ctx, companyId);
      const state = await readPairing(ctx);
      // Only whether a secret is bound and why a stored value was refused;
      // the stored value itself never reaches the page.
      const tokenConfigured = isSecretRefBinding(config.botToken);
      let botUsername: string | undefined;
      if (tokenConfigured) {
        try {
          botUsername = await botUsernameFor(companyId);
          unresolvedTokenCompanies.delete(companyId);
        } catch (err) {
          if (!isRateLimitError(err)) unresolvedTokenCompanies.add(companyId);
        }
      }
      const tokenError =
        botTokenConfigError(config.botToken) ??
        (unresolvedTokenCompanies.has(companyId) ? BOT_TOKEN_UNRESOLVED_MESSAGE : null);
      // Another company's handshake is reported without its details, so the
      // page can explain why pairing cannot start yet.
      const otherHandshakeInFlight =
        !!state.pairing &&
        state.pairing.targetCompanyId !== companyId &&
        !isHandshakeExpired(state.pairing);
      const handshake =
        state.pairing &&
        state.pairing.targetCompanyId === companyId &&
        !isHandshakeExpired(state.pairing)
          ? {
              stage: state.pairing.stage,
              targetCompanyId: state.pairing.targetCompanyId,
              targetCompanyName: state.pairing.targetCompanyName,
              expiresAt: state.pairing.expiresAt,
              candidateChatLabel:
                state.pairing.stage === "code_sent"
                  ? state.pairing.candidateLabel
                  : undefined,
            }
          : undefined;
      return {
        tokenConfigured,
        tokenError,
        botUsername,
        telegramUrl: botUsername ? `https://t.me/${botUsername}` : undefined,
        handshake,
        otherHandshakeInFlight,
      };
    });

    async function doStartPairing(companyId: string) {
      const config = await loadConfig(ctx, companyId);
      if (!config.botToken) {
        throw new Error(config.botTokenError ?? "botToken missing in plugin config");
      }
      const username = await ensureBotBootstrap(ctx, config);
      let targetCompanyName: string | undefined;
      try {
        targetCompanyName = (await ctx.companies.get(companyId))?.name;
      } catch {
        /* best-effort */
      }
      await mutatePairing(ctx, (state) => {
        if (isPairedFor(state, companyId)) {
          const existing = getPaired(state, companyId);
          throw new Error(
            `Company is already paired with ${existing?.chatLabel}. Unpair first.`,
          );
        }
        // One handshake at a time per instance. A live handshake for another
        // company is not cancelled from here: that would let one company
        // interrupt another company's pairing.
        if (
          state.pairing &&
          state.pairing.targetCompanyId !== companyId &&
          !isHandshakeExpired(state.pairing)
        ) {
          throw new Error(
            "Another company is pairing right now. Try again when its 10-minute window ends.",
          );
        }
        return {
          next: {
            ...state,
            pairing: {
              stage: "awaiting_chat",
              targetCompanyId: companyId,
              targetCompanyName,
              expiresAt: newHandshakeExpiry(),
            },
          },
          result: undefined,
        };
      });
      return {
        stage: "awaiting_chat",
        botUsername: username,
        companyName: targetCompanyName,
      };
    }

    /**
     * Complete the handshake. `companyId` is the host-authorized company of
     * the caller (settings page or agent tool); it must be the handshake's
     * target. `pairedByUserId` is the Paperclip user who confirmed, when the
     * caller is a board user.
     */
    async function doConfirmPairing(
      code: string,
      companyId: string,
      pairedByUserId?: string | null,
    ) {
      const paired = await mutatePairing(ctx, (state) => {
        if (!state.pairing || state.pairing.targetCompanyId !== companyId) {
          throw new Error("No active pairing handshake. Start pairing first.");
        }
        if (isHandshakeExpired(state.pairing)) {
          const next = { ...state };
          delete next.pairing;
          return { next, result: null };
        }
        if (state.pairing.stage !== "code_sent") {
          throw new Error(
            "Bot has not sent a code yet. Send any message to the bot in Telegram first.",
          );
        }
        if (!codesMatch(state.pairing.code, code)) {
          throw new Error("Code mismatch. Re-check the code and try again.");
        }
        const chat: PairedChat = {
          chatId: state.pairing.candidateChatId,
          chatLabel: state.pairing.candidateLabel,
          pairedAt: new Date().toISOString(),
          companyName: state.pairing.targetCompanyName,
          // Capture the operator id here too — the agent-tool path must
          // enforce the same approver/unpair gating as the UI confirm path.
          pairedByTelegramUserId: state.pairing.candidateUserId,
          ...(pairedByUserId ? { pairedByUserId } : {}),
        };
        const next: PairingState = {
          ...state,
          pairedByCompany: { ...(state.pairedByCompany ?? {}), [companyId]: chat },
        };
        delete next.pairing;
        return { next, result: chat };
      });
      if (!paired) throw new Error("Pairing window expired. Start over.");
      ctx.logger.info("telegram-notifier: paired", {
        companyId,
        chatId: paired.chatId,
        label: paired.chatLabel,
      });
      const config = await loadConfig(ctx, companyId);
      await sendToChat(
        ctx,
        config,
        paired.chatId,
        buildPairedConfirmation({ chatLabel: paired.chatLabel }),
      ).catch(() => undefined);
      return {
        paired: {
          companyId,
          chatLabel: paired.chatLabel,
          pairedAt: paired.pairedAt,
          companyName: paired.companyName,
        },
      };
    }

    async function doUnpairCompany(companyId: string) {
      const removed = await removePairedChat(ctx, companyId);
      if (!removed) return { paired: false, companyId };
      const config = await loadConfig(ctx, companyId);
      await sendToChat(ctx, config, removed.chatId, buildUnpairedMessage()).catch(
        () => undefined,
      );
      return {
        paired: false,
        companyId,
        previousLabel: removed.chatLabel,
      };
    }

    async function doSendTestForCompany(companyId: string) {
      const config = await loadConfig(ctx, companyId);
      const state = await readPairing(ctx);
      const chat = getPaired(state, companyId);
      if (!chat) throw new Error("Company has no paired chat.");
      if (!config.botToken) {
        throw new Error(config.botTokenError ?? "botToken missing in plugin config.");
      }
      const client = await createTelegramClient(ctx, config.botToken);
      await client.sendMessage({
        chatId: chat.chatId,
        ...buildTestMessage(),
      });
      return { sent: true, companyId, chatLabel: chat.chatLabel };
    }

    function requireCompanyParam(params: unknown): string {
      const id = (params as { companyId?: unknown })?.companyId;
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("companyId is required");
      }
      return id;
    }

    // Settings-page actions. The host replaces `params.companyId` with the
    // company selected in the dashboard and passes it in `context.companyId`.
    ctx.actions.register("startPairing", async (params) =>
      doStartPairing(requireCompanyParam(params)),
    );
    ctx.actions.register("confirmPairing", async (params, context) => {
      const code =
        typeof (params as { code?: unknown })?.code === "string"
          ? ((params as { code: string }).code as string)
          : "";
      if (!code) throw new Error("code parameter is required");
      return doConfirmPairing(
        code,
        requireCompanyParam(params),
        context?.actor?.type === "user" ? context.actor.userId : null,
      );
    });
    ctx.actions.register("unpair", async (params) =>
      doUnpairCompany(requireCompanyParam(params)),
    );
    ctx.actions.register("sendTest", async (params) =>
      doSendTestForCompany(requireCompanyParam(params)),
    );
    /**
     * Validate the configured bot token by calling Telegram's getMe.
     * Independent of any company pairing — exercises the credential alone.
     */
    ctx.actions.register("testBotConnection", async (params) => {
      const config = await loadConfig(ctx, requireCompanyParam(params));
      if (!config.botToken) {
        throw new Error("No bot token configured.");
      }
      const client = await createTelegramClient(ctx, config.botToken);
      try {
        const me = await client.getMe();
        return {
          ok: true,
          content: `Connected as @${me.username ?? "(no username)"}`,
          data: { botUsername: me.username, botId: me.id },
        };
      } catch (err) {
        const msg = errorText(err);
        throw new Error(`Telegram getMe failed: ${msg}`);
      }
    });

    ctx.logger.info(
      "telegram-notifier: subscribed to 6 events, registered 1 job, 6 tools, 7 actions, 4 data handlers",
    );
  },

  async onValidateConfig(config) {
    const error = botTokenConfigError(config.botToken);
    return error ? { ok: false, errors: [error] } : { ok: true };
  },

  async onHealth() {
    return { status: "ok", message: "telegram-notifier ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
