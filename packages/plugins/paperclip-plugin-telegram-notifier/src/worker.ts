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
 * Notifications are sent only to the paired chat. Action buttons in
 * notifications are URL deep-links to the dashboard, so any decision-grade
 * action stays with the logged-in user — the plugin never carries an API key
 * for the Paperclip backend.
 *
 * Failure mode: any exception inside an event or polling handler is caught
 * and logged; we never let a Telegram outage block the rest of Paperclip.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  PluginEvent,
  PluginJobContext,
} from "@paperclipai/plugin-sdk";

import {
  AGENTS_MD_SNIPPET,
  CALLBACK_KIND,
  COMMENT_INLINE_LIMIT,
  DEFAULT_PLAN_TEMPLATE,
  JOB_KEYS,
  POLL_LOOP_DEADLINE_MS,
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
  buildPairingExpired,
  buildPairingNotInitiated,
  buildRunFailedMessage,
  buildStatusMessage,
  buildTestMessage,
  buildUnpairedMessage,
  buildWakeRequestedMessage,
} from "./format.js";
import {
  chatLabel,
  clearHandshake,
  codesMatch,
  findCompanyForChat,
  generateVerificationCode,
  getApprovalConfig,
  getMessageContext,
  getPaired,
  isHandshakeExpired,
  isPairedFor,
  listPairedCompanies,
  newHandshakeExpiry,
  patchPairedChat,
  patchPairing,
  readPairing,
  removePairedChat,
  saveMessageContext,
  setApprovalConfig,
  setPairedChat,
} from "./pairing.js";
import { createTelegramClient } from "./telegram-client.js";
import type {
  ApprovalConfig,
  InlineKeyboard,
  PluginConfig,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Mask a Telegram bot token for safe display.
 *
 *   1234567890:AAEX...rest    →    1234567890:••••rest
 *
 * Real tokens have the form `<digits>:<token-body>`. We keep the digit prefix
 * (the "bot ID" part is not secret) and the trailing 4 characters so the
 * operator can distinguish between accidentally-saved tokens. Anything else
 * (including secret-ref names) is masked uniformly.
 */
function maskTokenForDisplay(token: string): string {
  const trimmed = token.trim();
  const m = trimmed.match(/^(\d+):(.+)$/);
  if (m) {
    const [, prefix, body] = m;
    if (body.length <= 6) return `${prefix}:${"•".repeat(body.length)}`;
    return `${prefix}:${"•".repeat(Math.max(4, body.length - 4))}${body.slice(-4)}`;
  }
  if (trimmed.length <= 4) return "•".repeat(trimmed.length);
  return `${"•".repeat(Math.max(4, trimmed.length - 4))}${trimmed.slice(-4)}`;
}

async function loadConfig(ctx: PluginContext): Promise<PluginConfig> {
  const raw = await ctx.config.get();
  return (raw ?? {}) as PluginConfig;
}

function notifyEnabled(
  config: PluginConfig,
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
      err: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
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
 * Fetch the full prompt text of a `request_confirmation` interaction. The
 * activity-log payload that drives `approval.created` only carries metadata
 * (id, kind, status), not the prompt body, so we round-trip to the API to
 * render the body in the Telegram message.
 */
async function fetchInteractionPrompt(
  config: PluginConfig,
  issueId: string,
  interactionId: string,
): Promise<string | undefined> {
  const baseUrl = config.paperclipBaseUrl ?? "http://localhost:3100";
  try {
    const res = await fetch(
      `${baseUrl}/api/issues/${encodeURIComponent(issueId)}/interactions`,
      { method: "GET", headers: { Accept: "application/json" } },
    );
    if (!res.ok) return undefined;
    const items = (await res.json()) as Array<{
      id: string;
      payload?: { prompt?: string };
      summary?: string | null;
      title?: string | null;
    }>;
    const ix = items.find((i) => i.id === interactionId);
    if (!ix) return undefined;
    return (
      ix.payload?.prompt ?? ix.summary ?? ix.title ?? undefined
    ) as string | undefined;
  } catch {
    return undefined;
  }
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
    promptText?: string;
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
    body: input.promptText,
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
      await saveMessageContext(ctx, result.message_id, {
        kind: "confirmation_decision",
        companyId,
        issueId: input.issueId,
        interactionId: input.interactionId,
        identifier: input.identifier,
        title: input.title,
        promptText: input.promptText,
        requesterLabel: input.requestedBy,
        createdAt: new Date().toISOString(),
      });
    }
    return result;
  } catch (err) {
    ctx.logger.warn("telegram-notifier: send confirmation failed", {
      err: err instanceof Error ? err.message : String(err),
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
    let title = "Confirmation requested";
    let identifier = asString(payload.identifier) ?? issueId.slice(0, 8);
    let requestedBy: string | undefined;
    try {
      const issue = await ctx.issues.get(issueId, event.companyId);
      if (issue) {
        title = issue.title ?? title;
        identifier = issue.identifier ?? identifier;
      }
    } catch {
      /* best-effort — fall through with payload values */
    }
    // Activity-log payload only carries interaction metadata (id, kind,
    // status), not the prompt body. Round-trip through the interactions
    // endpoint to render the actual prompt in the Telegram message.
    const promptText =
      (await fetchInteractionPrompt(config, issueId, interactionId)) ??
      asString(payload.bodySnippet) ??
      asString(payload.body) ??
      undefined;
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
      promptText,
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
  const change = asRecord(payload.changes) ?? {};
  const assigneeChange = asRecord(change.assigneeUserId);
  if (!assigneeChange) return;
  const newAssignee = asString(assigneeChange.to);
  if (!newAssignee) return;
  // entityId is the issue UUID (for deep-links); identifier is human-readable (e.g. PROJ-12).
  const issueId = asString(event.entityId);
  await sendToCompanyChat(
    ctx,
    config,
    event.companyId,
    buildIssueAssignedMessage({
      baseUrl: config.paperclipBaseUrl ?? "http://localhost:3100",
      identifier:
        asString(payload.identifier) ?? issueId ?? "?",
      issueId,
      title: asString(payload.title) ?? "(no title)",
      status: asString(payload.status),
      fromActor: asString(payload.assignedFromAgentName),
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

  // Hydrate full body + author name from the comment record itself when
  // we have an issueId. The activity-log payload truncates body and omits
  // author identity.
  if (issueId && commentId) {
    try {
      const comments = await ctx.issues.listComments(issueId, event.companyId);
      const comment = comments.find(
        (c) => (c as { id?: string }).id === commentId,
      );
      if (comment) {
        const cBody = (comment as { body?: string }).body;
        if (typeof cBody === "string" && cBody.length > 0) fullBody = cBody;
        if (!authorName) {
          const cAuthorId = (comment as { authorAgentId?: string | null })
            .authorAgentId;
          if (cAuthorId) {
            try {
              const agent = await ctx.agents.get(cAuthorId, event.companyId);
              if (agent?.name) authorName = agent.name;
            } catch {
              // ignore — fall back to "Someone"
            }
          }
        }
      }
    } catch (err) {
      ctx.logger.warn("telegram-notifier: comment hydrate failed", {
        commentId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!authorName) authorName = "Someone";

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
    issueTitle:
      asString(payload.issueTitle) ?? asString(payload.title) ?? "(no title)",
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
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (issueId) {
    await saveMessageContext(ctx, sent.message_id, {
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
  await sendToCompanyChat(
    ctx,
    config,
    event.companyId,
    buildRunFailedMessage({
      baseUrl: config.paperclipBaseUrl ?? "http://localhost:3100",
      agentId: asString(event.entityId) ?? asString(payload.agentId),
      agentName: asString(payload.agentName) ?? "Agent",
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
  const state = await readPairing(ctx);
  if (state.botUsername) return state.botUsername;

  const client = await createTelegramClient(ctx, config.botToken);
  try {
    const me = await client.getMe();
    if (!me.username) {
      ctx.logger.warn("telegram-notifier: bot getMe returned no username");
      return undefined;
    }
    await client.setMyCommands().catch((err) => {
      ctx.logger.warn("telegram-notifier: setMyCommands failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
    await patchPairing(ctx, { botUsername: me.username });
    return me.username;
  } catch (err) {
    ctx.logger.warn("telegram-notifier: getMe failed", {
      err: err instanceof Error ? err.message : String(err),
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

  // No active handshake in flight.
  if (!state.pairing) {
    if (existingPairing) {
      // Already-paired chat messaging the bot — let slash-command handler run.
      return false;
    }
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
    await patchPairing(ctx, {
      pairing: {
        stage: "code_sent",
        targetCompanyId: state.pairing.targetCompanyId,
        targetCompanyName: state.pairing.targetCompanyName,
        candidateChatId: incomingChatId,
        candidateLabel: label,
        code,
        expiresAt: newHandshakeExpiry(),
      },
    });
    await replyTo(
      ctx,
      config,
      incomingChatId,
      buildPairingCodeMessage({ code, chatLabel: label }),
    );
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
    await replyTo(
      ctx,
      config,
      incomingChatId,
      buildPairingCodeMessage({
        code: state.pairing.code,
        chatLabel: state.pairing.candidateLabel,
      }),
    );
    return true;
  }

  return false;
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
          await saveMessageContext(ctx, sent.message_id, {
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
          text: `*Failed to create issue*\n${escapeMdText(err)}`,
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
          text: `*Failed to load inbox*\n${escapeMdText(err)}`,
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

function escapeMdText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Reuse the same MarkdownV2 escape rules used by format.ts.
  return message.replace(/[_*\[\]()~`>#+=|{}.!\\-]/g, (m) => `\\${m}`);
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
  const context = await getMessageContext(ctx, replyToMessageId);
  if (!context || context.kind !== "confirmation_decline_reason") return false;
  const incomingChatId = String(message.chat.id);
  const pairing = await readPairing(ctx);
  const found = findCompanyForChat(pairing, incomingChatId);
  if (!found || found.companyId !== context.companyId) return false;
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
      text: `*Decline failed*\n${escapeMdText(result.error ?? "unknown error")}`,
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
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await replyTo(ctx, config, incomingChatId, {
    text: `*✅ Declined ${escapeMdText(context.identifier)}* with your reason\\.`,
    keyboard: [],
  });
  return true;
}

async function handleCommentReply(
  ctx: PluginContext,
  config: PluginConfig,
  message: TelegramMessage,
  replyToMessageId: number,
): Promise<boolean> {
  const context = await getMessageContext(ctx, replyToMessageId);
  if (!context || context.kind !== "comment_thread") return false;
  const incomingChatId = String(message.chat.id);
  const pairing = await readPairing(ctx);
  const found = findCompanyForChat(pairing, incomingChatId);
  if (!found || found.companyId !== context.companyId) return false;
  const body = (message.text ?? "").trim();
  if (!body) return false;
  try {
    // Posting on behalf of the company's operate-as agent (if configured) so
    // the comment is attributed correctly. Falls back to plugin attribution
    // when no operate-as agent is set.
    const operateAsAgentId = found.chat.operateAsAgentId;
    await ctx.issues.createComment(
      context.issueId,
      body,
      context.companyId,
      operateAsAgentId ? { authorAgentId: operateAsAgentId } : undefined,
    );
    await replyTo(ctx, config, incomingChatId, {
      text: `*✅ Comment posted on ${escapeMdText(context.identifier)}*`,
      keyboard: [],
    });
  } catch (err) {
    await replyTo(ctx, config, incomingChatId, {
      text: `*Failed to post comment*\n${escapeMdText(err)}`,
      keyboard: [],
    });
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
  try {
    if (data === CALLBACK_KIND.reassignShow) {
      // Tap on 👤 Reassign — switch the message keyboard to a list of agents.
      const context = await getMessageContext(ctx, query.message.message_id);
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
      const context = await getMessageContext(ctx, query.message.message_id);
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
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (data === CALLBACK_KIND.replyToComment) {
      // Tap on 💬 Reply — send a force-reply prompt and copy the
      // comment_thread context onto the new message_id so the reply handler
      // resolves it back to the original Paperclip issue when the operator
      // sends their text.
      const context = await getMessageContext(ctx, query.message.message_id);
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
      await saveMessageContext(ctx, sent.message_id, {
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
      const context = await getMessageContext(ctx, query.message.message_id);
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
      const chatId = String(query.message.chat.id);
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
      const context = await getMessageContext(ctx, query.message.message_id);
      if (!context || context.kind !== "confirmation_decision") {
        await client.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "Confirmation context expired. Open the issue in Paperclip.",
          showAlert: true,
        });
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
          text: `Approve failed: ${result.error ?? "unknown error"}`.slice(0, 200),
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
          err: err instanceof Error ? err.message : String(err),
        });
      }
      await client.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Approved",
      });
      return;
    }
    if (data === CALLBACK_KIND.confirmDecline) {
      const context = await getMessageContext(ctx, query.message.message_id);
      if (!context || context.kind !== "confirmation_decision") {
        await client.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "Confirmation context expired. Open the issue in Paperclip.",
          showAlert: true,
        });
        return;
      }
      const decliner = telegramUserLabel(query.from);
      const sent = await client.sendMessage({
        chatId: String(query.message.chat.id),
        text: `*Decline ${escapeMdText(context.identifier)}*\nReply with the reason\\. The interaction will be rejected when you send your reason\\.`,
        forceReply: { placeholder: `Reason for declining ${context.identifier}` },
        replyToMessageId: query.message.message_id,
      });
      await saveMessageContext(ctx, sent.message_id, {
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
      err: err instanceof Error ? err.message : String(err),
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

async function runPollUpdates(
  ctx: PluginContext,
  _job: PluginJobContext,
): Promise<void> {
  const config = await loadConfig(ctx);
  if (!config.botToken) {
    ctx.logger.debug("telegram-notifier: no botToken yet, skipping poll");
    return;
  }

  await ensureBotBootstrap(ctx, config);

  // Morning digest is independent of inbound polling; run it once per
  // cron tick before we settle into the long-poll loop.
  await runMorningDigestIfDue(ctx, config);

  const client = await createTelegramClient(ctx, config.botToken);
  const deadline = Date.now() + POLL_LOOP_DEADLINE_MS;

  // Long-poll loop: keep getUpdates open for ~25s at a time and process
  // anything that arrives. Exits before the next cron tick fires so two
  // jobs don't overlap. This compresses callback_query latency from up to
  // 60s (full cron gap) down to ~10s, well under Telegram's 60s expiry.
  while (Date.now() < deadline) {
    const state = await readPairing(ctx);
    if (state.pairing && isHandshakeExpired(state.pairing)) {
      await clearHandshake(ctx);
    }
    const offset =
      state.lastUpdateId !== undefined ? state.lastUpdateId + 1 : undefined;

    let updates: TelegramUpdate[];
    try {
      updates = await client.getUpdates(offset);
    } catch (err) {
      ctx.logger.warn("telegram-notifier: getUpdates failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      // Back off briefly on transport errors so we don't busy-loop.
      await sleep(2000);
      continue;
    }

    let newest = state.lastUpdateId ?? -1;
    for (const update of updates) {
      if (update.update_id > newest) newest = update.update_id;
      try {
        if (update.message) {
          await handleMessage(ctx, config, update.message);
        } else if (update.callback_query) {
          await handleCallbackQuery(ctx, config, update.callback_query);
        }
      } catch (err) {
        ctx.logger.warn("telegram-notifier: update handler failed", {
          updateId: update.update_id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (newest >= 0 && newest !== state.lastUpdateId) {
      await patchPairing(ctx, { lastUpdateId: newest });
    }
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

  let mine: Awaited<ReturnType<PluginContext["issues"]["list"]>>;
  try {
    // Company-wide digest, not personal. Top-of-chain operators (CEO /
    // PS Lead / PS Manager) typically don't carry tickets directly — their
    // reports do. Filtering by `assigneeAgentId == operateAsAgentId`
    // produced 0/0/0 every morning for those operators because their
    // personal queue was always empty even when the company shipped.
    mine = await ctx.issues.list({ companyId, limit: 200 });
  } catch (err) {
    ctx.logger.warn("telegram-notifier: digest issue.list failed", {
      companyId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { sent: false, reason: "Failed to read issues." };
  }

  const doneYesterday = mine.filter(
    (i) => i.status === "done" && isWithinLastNHours(i.completedAt, 36, now),
  );
  const inProgress = mine.filter((i) => i.status === "in_progress");
  const todo = mine.filter((i) => i.status === "todo");

  const toDigest = (i: typeof mine[number]) => ({
    identifier: i.identifier ?? i.id.slice(0, 8),
    title: i.title,
    status: i.status,
  });

  const message = buildMorningDigest({
    date: today,
    doneYesterday: doneYesterday.map(toDigest),
    inProgress: inProgress.map(toDigest),
    todo: todo.map(toDigest),
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
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      sent: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runMorningDigestIfDue(
  ctx: PluginContext,
  config: PluginConfig,
): Promise<void> {
  const digest = config.morningDigest;
  if (!digest?.enabled) return;

  const now = new Date();
  const targetHour = digest.hour ?? 8;
  if (now.getHours() !== targetHour) return;
  if (digest.weekdaysOnly !== false) {
    const day = now.getDay(); // 0 Sun, 6 Sat
    if (day === 0 || day === 6) return;
  }

  const state = await readPairing(ctx);
  const paired = listPairedCompanies(state);
  if (paired.length === 0) return;

  for (const { companyId, chat } of paired) {
    if (!chat.operateAsAgentId) continue;
    await sendDigestForCompany(ctx, config, companyId);
  }
}

// ---------------------------------------------------------------------------
// Plugin entrypoint
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("telegram-notifier: starting");

    const guarded =
      <T extends PluginEvent>(
        fn: (
          ctx: PluginContext,
          config: PluginConfig,
          event: T,
        ) => Promise<void>,
      ) =>
      async (event: T) => {
        try {
          const config = await loadConfig(ctx);
          if (!config.botToken) return;
          await fn(ctx, config, event);
        } catch (err) {
          ctx.logger.warn("telegram-notifier: handler failed", {
            eventType: event.eventType,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      };

    ctx.events.on("approval.created", guarded(onApprovalCreated));
    ctx.events.on("issue.updated", guarded(onIssueUpdated));
    ctx.events.on("issue.comment.created", guarded(onCommentCreated));
    ctx.events.on("agent.run.failed", guarded(onAgentRunFailed));
    ctx.events.on("budget.incident.opened", guarded(onBudgetIncident));
    ctx.events.on(
      "issue.assignment_wakeup_requested",
      guarded(onWakeupRequested),
    );

    ctx.jobs.register(JOB_KEYS.pollUpdates, async (job) => {
      await runPollUpdates(ctx, job);
    });

    const companyParamSchema = {
      type: "object",
      required: ["companyId"],
      properties: { companyId: { type: "string" } },
    } as const;
    const confirmSchema = {
      type: "object",
      required: ["code"],
      properties: {
        code: { type: "string" },
      },
    } as const;

    function getCompanyParam(params: unknown): string {
      const id = (params as { companyId?: unknown })?.companyId;
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("companyId is required");
      }
      return id;
    }

    // ─── getStatus ──────────────────────────────────────────────────────
    ctx.tools.register(
      TOOL_NAMES.getStatus,
      {
        displayName: "Telegram pairing status",
        description:
          "Returns the bot username, list of paired companies, and any in-flight handshake.",
        parametersSchema: { type: "object", properties: {} },
      },
      async () => {
        const state = await readPairing(ctx);
        const paired = listPairedCompanies(state).map(({ companyId, chat }) => ({
          companyId,
          chatId: chat.chatId,
          chatLabel: chat.chatLabel,
          companyName: chat.companyName,
          pairedAt: chat.pairedAt,
          operateAsAgentId: chat.operateAsAgentId,
        }));
        // SECURITY: never include the live verification `code` in tool
        // output. The handshake is two-endpoint by design — anyone able to
        // read the code outside of Telegram could call confirmPairing and
        // skip the Telegram half.
        const handshake =
          state.pairing && !isHandshakeExpired(state.pairing)
            ? {
                stage: state.pairing.stage,
                targetCompanyId: state.pairing.targetCompanyId,
                targetCompanyName: state.pairing.targetCompanyName,
                expiresAt: state.pairing.expiresAt,
                ...(state.pairing.stage === "code_sent"
                  ? { candidateChatLabel: state.pairing.candidateLabel }
                  : {}),
              }
            : undefined;
        return {
          content: paired.length
            ? `Paired with ${paired.length} ${paired.length === 1 ? "company" : "companies"}.`
            : "No companies paired yet.",
          data: {
            botUsername: state.botUsername,
            paired,
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
          "Begins a handshake for the given company. Send any message to the bot afterward.",
        parametersSchema: companyParamSchema,
      },
      async (params) => {
        const companyId = getCompanyParam(params);
        const config = await loadConfig(ctx);
        if (!config.botToken) {
          return {
            error: "botToken missing in plugin config — set it before pairing.",
          };
        }
        const username = await ensureBotBootstrap(ctx, config);
        const state = await readPairing(ctx);
        if (isPairedFor(state, companyId)) {
          const existing = getPaired(state, companyId);
          return {
            error: `Company is already paired with ${existing?.chatLabel}. Unpair first.`,
          };
        }
        // Resolve company name for nicer messaging.
        let targetCompanyName: string | undefined;
        try {
          const companies = await ctx.companies.list();
          targetCompanyName = companies.find((c) => c.id === companyId)?.name;
        } catch {
          /* best-effort */
        }
        await patchPairing(ctx, {
          pairing: {
            stage: "awaiting_chat",
            targetCompanyId: companyId,
            targetCompanyName,
            expiresAt: newHandshakeExpiry(),
          },
        });
        return {
          content: username
            ? `Pairing started for ${targetCompanyName ?? companyId}. Open @${username} in Telegram, send any message, then confirm with the code. Window: 10 minutes.`
            : "Pairing started. Send any message to your bot, then confirm with the code.",
          data: {
            stage: "awaiting_chat",
            companyId,
            botUsername: username,
            telegramUrl: username ? `https://t.me/${username}` : undefined,
          },
        };
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
      async (params) => {
        const code =
          typeof (params as { code?: unknown })?.code === "string"
            ? ((params as { code: string }).code as string)
            : "";
        if (!code) return { error: "code parameter is required." };

        const state = await readPairing(ctx);
        if (!state.pairing) {
          return {
            error: "No active pairing handshake. Run telegram.start_pairing first.",
          };
        }
        if (isHandshakeExpired(state.pairing)) {
          await clearHandshake(ctx);
          return { error: "Pairing window expired. Start over." };
        }
        if (state.pairing.stage !== "code_sent") {
          return {
            error:
              "Bot has not sent a code yet. Send any message to the bot in Telegram first.",
          };
        }
        if (!codesMatch(state.pairing.code, code)) {
          return {
            error: "Code mismatch. Re-check the code the bot sent and try again.",
          };
        }

        const targetCompanyId = state.pairing.targetCompanyId;
        const paired = {
          chatId: state.pairing.candidateChatId,
          chatLabel: state.pairing.candidateLabel,
          pairedAt: new Date().toISOString(),
          companyName: state.pairing.targetCompanyName,
        };
        await setPairedChat(ctx, targetCompanyId, paired);
        await clearHandshake(ctx);
        ctx.logger.info("telegram-notifier: paired", {
          companyId: targetCompanyId,
          chatId: paired.chatId,
          label: paired.chatLabel,
        });

        const config = await loadConfig(ctx);
        await sendToChat(
          ctx,
          config,
          paired.chatId,
          buildPairedConfirmation({ chatLabel: paired.chatLabel }),
        ).catch(() => undefined);

        return {
          content: `Paired ${paired.companyName ?? targetCompanyId} with ${paired.chatLabel}.`,
          data: { paired: true, companyId: targetCompanyId, ...paired },
        };
      },
    );

    // ─── unpair ─────────────────────────────────────────────────────────
    ctx.tools.register(
      TOOL_NAMES.unpair,
      {
        displayName: "Unpair Telegram chat",
        description: "Disconnects the chat paired with a specific company.",
        parametersSchema: companyParamSchema,
      },
      async (params) => {
        const companyId = getCompanyParam(params);
        const removed = await removePairedChat(ctx, companyId);
        if (!removed) {
          return {
            content: "No chat was paired for that company.",
            data: { paired: false, companyId },
          };
        }
        const config = await loadConfig(ctx);
        await sendToChat(
          ctx,
          config,
          removed.chatId,
          buildUnpairedMessage(),
        ).catch(() => undefined);
        return {
          content: `Unpaired ${removed.chatLabel}.`,
          data: { paired: false, companyId },
        };
      },
    );

    // ─── sendTest ───────────────────────────────────────────────────────
    ctx.tools.register(
      TOOL_NAMES.sendTest,
      {
        displayName: "Send Telegram test notification",
        description: "Sends a sample notification to a company's paired chat.",
        parametersSchema: companyParamSchema,
      },
      async (params) => {
        const companyId = getCompanyParam(params);
        const config = await loadConfig(ctx);
        const state = await readPairing(ctx);
        const chat = getPaired(state, companyId);
        if (!chat) {
          return {
            content: "Not sent: that company has no paired chat.",
            data: { sent: false, companyId },
          };
        }
        if (!config.botToken) {
          return {
            content: "Not sent: botToken missing in config.",
            data: { sent: false, companyId },
          };
        }
        const client = await createTelegramClient(ctx, config.botToken);
        await client.sendMessage({
          chatId: chat.chatId,
          ...buildTestMessage(),
        });
        return {
          content: `Test message sent to ${chat.chatLabel}.`,
          data: { sent: true, companyId, chatId: chat.chatId },
        };
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
          "Returns the configured approver and whether the calling agent must gate plans before acting. Pass `agentId` to get caller-specific resolution.",
        parametersSchema: {
          type: "object",
          required: ["companyId"],
          properties: {
            companyId: { type: "string" },
            agentId: { type: "string" },
          },
        },
      },
      async (params) => {
        const p = (params ?? {}) as { companyId?: string; agentId?: string };
        if (!p.companyId) return { error: "companyId is required" };
        const state = await readPairing(ctx);
        const config = getApprovalConfig(state, p.companyId);
        const approver = await resolveApprover(p.companyId, config);
        const enabled = config?.enabled === true;
        const requiresApproval = !!(
          enabled &&
          p.agentId &&
          config?.agents?.[p.agentId]?.requiresApproval
        );
        const template = p.agentId
          ? templateForAgent(config, p.agentId)
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
    ctx.data.register("companies", async () => {
      const companies = await ctx.companies.list();
      const state = await readPairing(ctx);
      return {
        items: companies
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
          err: err instanceof Error ? err.message : String(err),
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
          err: err instanceof Error ? err.message : String(err),
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
      const pluginConfig = await loadConfig(ctx);
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
    ctx.data.register("status", async () => {
      const config = await loadConfig(ctx);
      const state = await readPairing(ctx);
      const tokenConfigured = !!config.botToken && config.botToken.length > 0;
      const tokenMasked = tokenConfigured
        ? maskTokenForDisplay(config.botToken!)
        : null;
      const handshake =
        state.pairing && !isHandshakeExpired(state.pairing)
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
        tokenMasked,
        botUsername: state.botUsername,
        telegramUrl: state.botUsername
          ? `https://t.me/${state.botUsername}`
          : undefined,
        handshake,
      };
    });

    async function doStartPairing(companyId: string) {
      const config = await loadConfig(ctx);
      if (!config.botToken) throw new Error("botToken missing in plugin config");
      const username = await ensureBotBootstrap(ctx, config);
      const state = await readPairing(ctx);
      if (isPairedFor(state, companyId)) {
        const existing = getPaired(state, companyId);
        throw new Error(
          `Company is already paired with ${existing?.chatLabel}. Unpair first.`,
        );
      }
      let targetCompanyName: string | undefined;
      try {
        const companies = await ctx.companies.list();
        targetCompanyName = companies.find((c) => c.id === companyId)?.name;
      } catch {
        /* best-effort */
      }
      await patchPairing(ctx, {
        pairing: {
          stage: "awaiting_chat",
          targetCompanyId: companyId,
          targetCompanyName,
          expiresAt: newHandshakeExpiry(),
        },
      });
      return { stage: "awaiting_chat", botUsername: username };
    }

    async function doConfirmPairing(code: string) {
      const state = await readPairing(ctx);
      if (!state.pairing) {
        throw new Error("No active pairing handshake. Start pairing first.");
      }
      if (isHandshakeExpired(state.pairing)) {
        await clearHandshake(ctx);
        throw new Error("Pairing window expired. Start over.");
      }
      if (state.pairing.stage !== "code_sent") {
        throw new Error(
          "Bot has not sent a code yet. Send any message to the bot in Telegram first.",
        );
      }
      if (!codesMatch(state.pairing.code, code)) {
        throw new Error("Code mismatch. Re-check the code and try again.");
      }
      const targetCompanyId = state.pairing.targetCompanyId;
      const paired = {
        chatId: state.pairing.candidateChatId,
        chatLabel: state.pairing.candidateLabel,
        pairedAt: new Date().toISOString(),
        companyName: state.pairing.targetCompanyName,
      };
      await setPairedChat(ctx, targetCompanyId, paired);
      await clearHandshake(ctx);
      const config = await loadConfig(ctx);
      await sendToChat(
        ctx,
        config,
        paired.chatId,
        buildPairedConfirmation({ chatLabel: paired.chatLabel }),
      ).catch(() => undefined);
      return { paired: { ...paired, companyId: targetCompanyId } };
    }

    async function doUnpairCompany(companyId: string) {
      const removed = await removePairedChat(ctx, companyId);
      if (!removed) return { paired: false, companyId };
      const config = await loadConfig(ctx);
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
      const config = await loadConfig(ctx);
      const state = await readPairing(ctx);
      const chat = getPaired(state, companyId);
      if (!chat) throw new Error("Company has no paired chat.");
      if (!config.botToken)
        throw new Error("botToken missing in plugin config.");
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

    ctx.actions.register("startPairing", async (params) =>
      doStartPairing(requireCompanyParam(params)),
    );
    ctx.actions.register("confirmPairing", async (params) => {
      const code =
        typeof (params as { code?: unknown })?.code === "string"
          ? ((params as { code: string }).code as string)
          : "";
      if (!code) throw new Error("code parameter is required");
      return doConfirmPairing(code);
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
    ctx.actions.register("testBotConnection", async () => {
      const config = await loadConfig(ctx);
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
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Telegram getMe failed: ${msg}`);
      }
    });

    ctx.logger.info(
      "telegram-notifier: subscribed to 6 events, registered 1 job, 6 tools, 7 actions, 4 data handlers",
    );
  },

  async onHealth() {
    return { status: "ok", message: "telegram-notifier ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
