/**
 * paperclip-telegram-bridge — entry point
 *
 * Long-polls Telegram via grammy. Inbound: text/voice → buildIssueRequest →
 * dispatch-budget check → POST /api/companies/<id>/issues + wake agent.
 * Outbound: poll Paperclip per-company for new comments → reply via
 * markdown-aware chunking back to the originating chat.
 *
 * Voice: local whisper transcription (lifted from v2/transcribe.ts).
 * Chat → company: workspace-file frontmatter at ~/second-brain/00-system/workspaces/.
 *
 * Quiet-hours window: 9pm-6:30am suppresses real-time Tier 3 approvals;
 * Tier 2 (morning batch) decisions queue silently per AGENT-INFRA §3.9.
 */

import type {
  ChatToCompanyMapping,
  InboundMessage,
  IssueCreationRequest,
  OutboundComment,
  ApprovalCardSurface,
} from "./types.js";
import { canFireApprovalNow, isQuietHours, isMarketHours } from "./quiet-hours.js";
import { loadChatMappings as loadChatMappingsImpl, findMappingForChat } from "./chat-mappings.js";
import { PaperclipBridgeClient } from "./paperclip-client.js";
import { createTelegramBot, sendMarkdownMessage } from "./telegram-bot.js";
import { transcribeAudio, downloadTelegramFile } from "./voice.js";
import type { Bot } from "grammy";
import { DispatchBudget, getDispatchBudget } from "../../../mattclaw/v2/shared/dispatch-budget.js";

export { findMappingForChat } from "./chat-mappings.js";
export { chunkMarkdownForTelegram } from "./chunking.js";
export { transcribeAudio, downloadTelegramFile } from "./voice.js";

// ---------------------------------------------------------------------------
// Chat mapping loader
// ---------------------------------------------------------------------------

export const loadChatMappings = loadChatMappingsImpl;

// ---------------------------------------------------------------------------
// Inbound: Telegram → Paperclip issue
// ---------------------------------------------------------------------------

/**
 * Build an IssueCreationRequest from an inbound Telegram message.
 * Generates a stable logical_task_id for the cross-layer dispatch budget
 * (per AGENT-INFRA §3.8 + Phase 1A foundation primitives).
 */
export function buildIssueRequest(
  msg: InboundMessage,
  mapping: ChatToCompanyMapping,
): IssueCreationRequest {
  // logical_task_id format: telegram:<chatId>:<messageId> — stable across
  // re-dispatches. Bridge re-receiving the same message after a crash hits
  // the dispatch budget ledger and gets blocked at attempt 3.
  const logicalTaskId = `telegram:${msg.chatId}:${msg.messageId}`;
  const title = msg.text
    ? msg.text.slice(0, 80) + (msg.text.length > 80 ? "..." : "")
    : msg.voiceFileId
      ? "[voice message]"
      : "[message]";
  return {
    companyId: mapping.companyId,
    agentId: "", // resolved at POST time from companyId + defaultAgent
    title,
    description: msg.text ?? "",
    logicalTaskId,
    source: "telegram",
    originatingMessage: {
      chatId: msg.chatId,
      threadId: msg.threadId,
      messageId: msg.messageId,
    },
  };
}

/**
 * Create the Paperclip issue and wake the assigned agent.
 * Returns the new issue ID.
 */
export async function postIssueAndWakeup(
  req: IssueCreationRequest,
  client: PaperclipBridgeClient,
  budget: DispatchBudget = getDispatchBudget(),
): Promise<string> {
  const reservationId = `telegram:${req.originatingMessage.messageId}`;
  const claimed = budget.attemptOrBlock(req.logicalTaskId, req.source, reservationId);
  if (claimed.blocked) {
    throw new Error(
      `dispatch budget exhausted for ${req.logicalTaskId}: ${claimed.used}/${DispatchBudget.HARD_CEILING} attempts in window`,
    );
  }
  let issueId: string | null = null;
  let issue;
  try {
    issue = await client.createIssue(req.companyId, {
      title: req.title,
      description: req.description,
      status: "todo",
      priority: "medium",
      assigneeAgentId: req.agentId || undefined,
      originKind: req.originKind ?? "manual",
      originFingerprint: req.logicalTaskId,
    });
  } catch (err) {
    budget.markFailed(req.logicalTaskId, reservationId, "failed");
    throw err;
  }
  issueId = issue.id;
  if (req.agentId) {
    try {
      await client.wakeAgent(req.agentId, {
        reason: `telegram-inbound:${req.logicalTaskId}`,
        source: "automation",
      });
    } catch (err: any) {
      // 409 = agent paused/not invokable. Issue is already assigned; Paperclip
      // will wake the agent on next heartbeat once it's running again. Don't
      // fail the whole dispatch over a wakeup race.
      if (err?.message?.includes("409")) {
        console.warn(`[telegram-bridge] wakeup 409 for agent ${req.agentId} — issue ${issueId} assigned, agent will pick up when unpaused`);
      } else {
        budget.markFailed(req.logicalTaskId, reservationId, "failed");
        throw err;
      }
    }
  }
  budget.markCompleted(req.logicalTaskId, reservationId);
  budget.recordAttempt({
    logicalTaskId: req.logicalTaskId,
    source: req.source,
    paperclipRunId: issue.id,
    attemptedAt: new Date().toISOString(),
    outcome: "claimed",
  });
  return issue.id;
}

// ---------------------------------------------------------------------------
// Outbound: Paperclip comment → Telegram reply
// ---------------------------------------------------------------------------

export async function pollNewComments(
  companyId: string,
  sinceCursor: string,
  client: PaperclipBridgeClient,
): Promise<OutboundComment[]> {
  const raw = await client.getNewComments(companyId, sinceCursor);
  return raw.map((c) => ({
    id: c.id,
    issueId: c.issueId,
    body: c.body,
    postedAt: c.createdAt,
  }));
}

/**
 * Send a Paperclip comment back to Telegram via markdown-aware chunking.
 * If `replyToMessageId` is provided, the reply threads under that message.
 * Bot must already be running; pass via deps.
 */
export async function sendTelegramReply(
  comment: OutboundComment,
  mapping: ChatToCompanyMapping,
  bot: Bot,
  replyToMessageId?: number,
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  return sendMarkdownMessage(bot, mapping.chatId, comment.body, mapping.threadId, replyToMessageId);
}

// ---------------------------------------------------------------------------
// Approval surface (Tier 3 time-critical only — Tier 2 is morning brief)
// ---------------------------------------------------------------------------

/**
 * In-process approval ledger. Key = approvalId.
 * TTL eviction is lazy (checked on button press).
 */
const _approvalLedger = new Map<
  string,
  {
    card: ApprovalCardSurface;
    expiresAt: number | null; // ms since epoch, null = no expiry
    issueId: string;
    companyId: string;
    chatId: string;
  }
>();

/**
 * Surface a Tier 3 time-critical approval card if market hours allow.
 * Sends an inline keyboard to the finance Telegram chat.
 * Returns surfaced=false outside market hours (9:30am–4:00pm ET weekdays).
 *
 * Per AGENT-INFRA §3.9 Phase 1B: trade approvals fire ONLY during market
 * hours. Outside market hours, suppresses and logs (not queued — stale
 * market state is unsafe).
 */
export async function maybeSurfaceApproval(
  card: ApprovalCardSurface,
  bot: Bot,
  issueId: string,
  companyId: string,
): Promise<{ surfaced: boolean; reason: string }> {
  const decision = canFireApprovalNow("time-critical");
  if (!decision.fire) {
    console.log(`[approval] suppressed approvalId=${card.approvalId} reason=${decision.reason}`);
    return { surfaced: false, reason: decision.reason };
  }

  if (!isMarketHours()) {
    const reason = "Tier 3 trade approval suppressed outside market hours (9:30am-4pm ET weekdays)";
    console.log(`[approval] suppressed approvalId=${card.approvalId} reason=${reason}`);
    return { surfaced: false, reason };
  }

  const expiresAt = card.ttlSec != null ? Date.now() + card.ttlSec * 1000 : null;
  _approvalLedger.set(card.approvalId, {
    card,
    expiresAt,
    issueId,
    companyId,
    chatId: card.chatId,
  });

  // Build inline keyboard rows
  const keyboard = card.buttons.map((btn) => [
    { text: btn.label, callback_data: btn.callbackData },
  ]);

  try {
    const opts: Record<string, unknown> = {
      reply_markup: { inline_keyboard: keyboard },
    };
    if (card.threadId != null) opts.message_thread_id = card.threadId;
    await bot.api.sendMessage(card.chatId, card.prompt, opts as any);
    console.log(`[approval] surfaced approvalId=${card.approvalId} chat=${card.chatId} ttlSec=${card.ttlSec ?? "none"}`);
    return { surfaced: true, reason: "approval card sent to Telegram" };
  } catch (err: any) {
    _approvalLedger.delete(card.approvalId);
    console.error(`[approval] sendMessage failed: ${err?.message ?? err}`);
    return { surfaced: false, reason: `Telegram send failed: ${err?.message ?? err}` };
  }
}

/**
 * Handle a Telegram callback_query from an approval inline keyboard.
 * Called when the user presses Approve/Reject.
 *
 * Decision flow per AGENT-INFRA §3.9:
 * - Within TTL: post approval decision as comment on the Paperclip issue.
 * - TTL expired: post "approval expired — re-evaluating" comment + create
 *   new issue for Dalio to re-evaluate with current market state.
 */
export async function handleApprovalCallback(
  callbackData: string,
  callbackQueryId: string,
  bot: Bot,
  client: PaperclipBridgeClient,
): Promise<void> {
  // callbackData format: "approve:<approvalId>" or "reject:<approvalId>"
  const match = callbackData.match(/^(approve|reject):(.+)$/);
  if (!match) return;
  const [, decision, approvalId] = match;
  const entry = _approvalLedger.get(approvalId);

  if (!entry) {
    await bot.api.answerCallbackQuery(callbackQueryId, { text: "Approval not found or already handled." });
    return;
  }

  const isExpired = entry.expiresAt != null && Date.now() > entry.expiresAt;

  if (isExpired) {
    _approvalLedger.delete(approvalId);
    // Post expiry notice on original issue
    await client.createComment(entry.issueId, "approval expired — re-evaluating against current market state");
    // Create new issue for Dalio to re-evaluate
    const DALIO_AGENT_ID = "60388066-7525-4128-9800-27dfac33a697";
    await client.createIssue(entry.companyId, {
      title: `[Re-evaluate] Expired approval: ${entry.card.prompt.slice(0, 60)}`,
      description: `Approval card expired (TTL=${entry.card.ttlSec}s). Original prompt:\n\n${entry.card.prompt}\n\nRe-evaluate with current market state before taking any action.`,
      status: "todo",
      priority: "urgent",
      assigneeAgentId: DALIO_AGENT_ID,
    });
    await bot.api.answerCallbackQuery(callbackQueryId, { text: "Approval expired. Dalio will re-evaluate with current market state." });
    console.log(`[approval] expired approvalId=${approvalId} — new re-eval issue created`);
    return;
  }

  _approvalLedger.delete(approvalId);
  const commentBody = `APPROVAL_DECISION: ${decision.toUpperCase()}\napprovalId: ${approvalId}\ndecidedAt: ${new Date().toISOString()}`;
  await client.createComment(entry.issueId, commentBody);
  await bot.api.answerCallbackQuery(callbackQueryId, { text: `${decision === "approve" ? "Approved" : "Rejected"}.` });
  console.log(`[approval] decision=${decision} approvalId=${approvalId} issue=${entry.issueId}`);
}

/**
 * Handle a Telegram callback_query for issue action buttons.
 * callbackData format: "action:<verb>:<issueId>"
 * Supported verbs: rework, verify, escalate, done
 */
export async function handleActionCallback(
  callbackData: string,
  callbackQueryId: string,
  bot: Bot,
  client: PaperclipBridgeClient,
): Promise<void> {
  const match = callbackData.match(/^action:(rework|verify|escalate|done):(.+)$/);
  if (!match) return;
  const [, verb, issueId] = match;

  switch (verb) {
    case "done": {
      await client.updateIssue(issueId, { status: "done" });
      await bot.api.answerCallbackQuery(callbackQueryId, { text: "Marked done." });
      break;
    }
    case "rework": {
      await client.updateIssue(issueId, { status: "todo", comment: "🔄 Rework requested via Telegram", reopen: true });
      await bot.api.answerCallbackQuery(callbackQueryId, { text: "Sent back for rework." });
      break;
    }
    case "verify": {
      await client.updateIssue(issueId, { status: "in_review", comment: "🔍 Verification requested via Telegram" });
      await bot.api.answerCallbackQuery(callbackQueryId, { text: "Marked for verification." });
      break;
    }
    case "escalate": {
      await client.updateIssue(issueId, { status: "blocked", comment: "⚠️ Escalated via Telegram — needs human attention" });
      await bot.api.answerCallbackQuery(callbackQueryId, { text: "Escalated. Issue blocked." });
      break;
    }
  }
  console.log(`[action] verb=${verb} issue=${issueId}`);
}

// ---------------------------------------------------------------------------
// Alpaca event-ingress HTTP server
// ---------------------------------------------------------------------------

/**
 * In-memory idempotency set for Alpaca event_ids.
 * Prevents duplicate issue creation on webhook replay.
 * Per spec: in-memory Map is fine for Phase 1B.
 */
const _alpacaSeenEventIds = new Map<string, number>(); // eventId → processedAt ms
const ALPACA_EVENT_ID_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function pruneAlpacaEventIds(): void {
  const cutoff = Date.now() - ALPACA_EVENT_ID_TTL_MS;
  for (const [id, ts] of _alpacaSeenEventIds) {
    if (ts < cutoff) _alpacaSeenEventIds.delete(id);
  }
}

async function appendJsonl(path: string, obj: unknown): Promise<void> {
  try {
    const fs = await import("fs");
    fs.appendFileSync(path, JSON.stringify(obj) + "\n");
  } catch (err) {
    console.error(`[alpaca-ingress] appendJsonl to ${path} failed: ${(err as Error)?.message ?? err}`);
  }
}

const HEALEY_FINANCE_COMPANY_ID = "75dc7a4e-ffa8-44d5-a27a-3f22470f848e";
const DALIO_AGENT_ID = "60388066-7525-4128-9800-27dfac33a697";
const ALPACA_INGRESS_LOG = `${process.env.HOME}/.mattclaw/data/logs/alpaca-ingress.jsonl`;
const ALPACA_DLQ_LOG = `${process.env.HOME}/.mattclaw/data/logs/alpaca-dlq.jsonl`;

/**
 * Start the Bun HTTP server alongside the grammy bot.
 * Provides two endpoints:
 *   POST /alpaca/webhook  — Alpaca trade_update event ingress
 *   POST /approval/callback — Internal: surface an approval card to Telegram
 *
 * Port: 18795 (bridge-specific; not collision with v2=18791 or dashboard=18790).
 */
export function startHttpServer(
  client: PaperclipBridgeClient,
  bot: Bot,
): { port: number; close: () => void } {
  const webhookSecret = process.env.ALPACA_WEBHOOK_SECRET ?? "";
  const port = parseInt(process.env.BRIDGE_HTTP_PORT ?? "18795", 10);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // -----------------------------------------------------------------------
      // POST /alpaca/webhook
      // -----------------------------------------------------------------------
      if (req.method === "POST" && url.pathname === "/alpaca/webhook") {
        // Auth verification
        const authHeader = req.headers.get("authorization") ?? "";
        if (webhookSecret && authHeader !== `Bearer ${webhookSecret}`) {
          console.warn("[alpaca-ingress] 401 unauthorized webhook");
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: Record<string, unknown>;
        try {
          payload = (await req.json()) as Record<string, unknown>;
        } catch {
          return new Response("Bad JSON", { status: 400 });
        }

        const eventId = String(payload.event_id ?? payload.id ?? `${Date.now()}-${Math.random()}`);
        const eventType = String(payload.event ?? "unknown");
        const receivedAt = new Date().toISOString();

        // Telemetry — log every webhook regardless of processing outcome
        await appendJsonl(ALPACA_INGRESS_LOG, { eventId, eventType, receivedAt, payload });

        // Idempotency check
        pruneAlpacaEventIds();
        if (_alpacaSeenEventIds.has(eventId)) {
          console.log(`[alpaca-ingress] duplicate eventId=${eventId} — skipped`);
          return new Response(JSON.stringify({ ok: true, skipped: true, reason: "duplicate" }), {
            headers: { "content-type": "application/json" },
          });
        }
        _alpacaSeenEventIds.set(eventId, Date.now());

        // Only dispatch on trade_update events (Alpaca's primary trade event type)
        if (eventType !== "trade_update" && !eventType.startsWith("trade_")) {
          console.log(`[alpaca-ingress] eventId=${eventId} type=${eventType} — not a trade_update, skipped`);
          return new Response(JSON.stringify({ ok: true, skipped: true, reason: "not_trade_update" }), {
            headers: { "content-type": "application/json" },
          });
        }

        // Create Paperclip issue assigned to Dalio
        try {
          const issue = await client.createIssue(HEALEY_FINANCE_COMPANY_ID, {
            title: `Alpaca trade_update: ${eventType} ${eventId}`,
            description: `**Alpaca webhook received**\n\neventId: \`${eventId}\`\neventType: \`${eventType}\`\nreceivedAt: \`${receivedAt}\`\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
            status: "todo",
            priority: "high",
            assigneeAgentId: DALIO_AGENT_ID,
          });
          // Wake Dalio to handle it
          try {
            await client.wakeAgent(DALIO_AGENT_ID, {
              reason: `alpaca-webhook:${eventId}`,
              source: "automation",
            });
          } catch (wakeErr: any) {
            if (!String(wakeErr?.message ?? "").includes("409")) throw wakeErr;
            console.warn(`[alpaca-ingress] wakeup 409 for Dalio — issue ${issue.id} will be picked up on next heartbeat`);
          }
          console.log(`[alpaca-ingress] eventId=${eventId} → issue=${issue.id}`);
          return new Response(JSON.stringify({ ok: true, issueId: issue.id }), {
            headers: { "content-type": "application/json" },
          });
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          console.error(`[alpaca-ingress] issue creation failed for eventId=${eventId}: ${msg}`);
          await appendJsonl(ALPACA_DLQ_LOG, {
            eventId,
            eventType,
            receivedAt,
            error: msg,
            payload,
          });
          return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      }

      // -----------------------------------------------------------------------
      // POST /approval/surface  — called by Dalio's run via comment marker detection
      // -----------------------------------------------------------------------
      if (req.method === "POST" && url.pathname === "/approval/surface") {
        let body: { card: ApprovalCardSurface; issueId: string; companyId: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return new Response("Bad JSON", { status: 400 });
        }
        const result = await maybeSurfaceApproval(body.card, bot, body.issueId, body.companyId);
        return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
      }

      // -----------------------------------------------------------------------
      // GET /health
      // -----------------------------------------------------------------------
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, service: "paperclip-telegram-bridge", ts: new Date().toISOString() }), {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`[telegram-bridge] HTTP server listening on port ${port}`);
  return { port, close: () => server.stop() };
}

// ---------------------------------------------------------------------------
// Outbound: detect APPROVAL_REQUEST: marker in Paperclip comments
// ---------------------------------------------------------------------------

/**
 * Parse an APPROVAL_REQUEST: marker from a Paperclip comment body.
 * Format (from Dalio's run):
 *   APPROVAL_REQUEST: {"approvalId":"...","prompt":"...","buttons":[...],"ttlSec":60}
 *
 * Returns null if no marker found or JSON is invalid.
 */
export function parseApprovalRequest(
  body: string,
): (Omit<ApprovalCardSurface, "chatId"> & { chatId?: string }) | null {
  const idx = body.indexOf("APPROVAL_REQUEST:");
  if (idx === -1) return null;
  const jsonStr = body.slice(idx + "APPROVAL_REQUEST:".length).trim();
  // Take up to end of first JSON object
  const end = jsonStr.indexOf("\n");
  const candidate = end === -1 ? jsonStr : jsonStr.slice(0, end);
  try {
    return JSON.parse(candidate);
  } catch {
    console.warn(`[approval] APPROVAL_REQUEST: marker found but JSON parse failed: ${candidate.slice(0, 200)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entry point — bot loop wired up
// ---------------------------------------------------------------------------

export async function main(): Promise<number> {
  console.log(`[telegram-bridge] starting. quiet-hours=${isQuietHours()}`);

  const apiUrl = process.env.PAPERCLIP_API_URL ?? "http://localhost:3100";
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const client = new PaperclipBridgeClient(apiUrl, apiKey);

  const mappings = await loadChatMappings();
  console.log(`[telegram-bridge] loaded ${mappings.length} chat mappings`);
  if (mappings.length === 0) {
    console.error("[telegram-bridge] no chat mappings — check workspace-file frontmatter (paperclip_company_id + telegram_chats)");
    return 2;
  }

  // issueToChat memo is the ONLY source-of-truth for outbound routing.
  // Maps issue UUID → originating mapping + original message info. The
  // message info lets us set a 👍 reaction on Matt's original message when
  // Karl's first reply lands. No "company default chat" fallback. After
  // the 2026-04-29 outbound-flood incident: better to miss a comment than
  // to spam DMs with status churn from agents the bridge doesn't own.
  //
  // PERSISTED to ~/.mattclaw/data/bridge-issue-memo.json so a bridge restart
  // doesn't lose the routing for in-flight issues. Without this, Karl's reply
  // to a message sent before the restart silently disappears (the 2026-05-03
  // bug). Saved on every set; loaded on startup.
  type IssueOriginInfo = {
    mapping: ChatToCompanyMapping;
    originatingMessageId: number;
    logicalTaskId?: string;
    /** Whether we've already set 👍 on the originating message. */
    completionAcked: boolean;
  };
  const issueToChat = new Map<string, IssueOriginInfo>();
  // Reverse map: outbound Telegram message ID → issue UUID.
  // Populated when we send a comment back to Telegram. Lets us thread user
  // replies to bot messages directly back to the originating issue without
  // relying on the time-window heuristic in findRecentOpenIssue.
  const outboundMsgToIssue = new Map<number, string>();
  const memoPath = `${process.env.HOME}/.mattclaw/data/bridge-issue-memo.json`;
  try {
    const fs = await import("fs");
    if (fs.existsSync(memoPath)) {
      const raw = fs.readFileSync(memoPath, "utf-8");
      const obj = JSON.parse(raw) as { issues?: Record<string, IssueOriginInfo>; outbound?: Record<string, string> };
      // Support old format (plain Record<string, IssueOriginInfo>) and new format.
      const issuesObj: Record<string, IssueOriginInfo> = obj.issues ?? (obj as any);
      for (const [k, v] of Object.entries(issuesObj)) issueToChat.set(k, v);
      for (const [k, v] of Object.entries(obj.outbound ?? {})) outboundMsgToIssue.set(Number(k), v);
      console.log(`[telegram-bridge] loaded ${issueToChat.size} issue entries, ${outboundMsgToIssue.size} outbound msg entries from memo`);
    }
  } catch (err) {
    console.error(`[telegram-bridge] failed to load issue memo: ${(err as Error)?.message ?? err}`);
  }
  const persistMemo = async () => {
    try {
      const fs = await import("fs");
      const issuesObj: Record<string, IssueOriginInfo> = {};
      for (const [k, v] of issueToChat.entries()) issuesObj[k] = v;
      const outboundObj: Record<string, string> = {};
      for (const [k, v] of outboundMsgToIssue.entries()) outboundObj[String(k)] = v;
      fs.writeFileSync(memoPath, JSON.stringify({ issues: issuesObj, outbound: outboundObj }));
    } catch (err) {
      console.error(`[telegram-bridge] failed to persist issue memo: ${(err as Error)?.message ?? err}`);
    }
  };

  const bot = createTelegramBot({
    onMessage: async (msg) => {
      const mapping = findMappingForChat(mappings, msg.chatId, msg.threadId);
      if (!mapping) {
        console.log(`[telegram-bridge] message from unknown chat ${msg.chatId}; ignoring`);
        return;
      }
      const fm = await loadAgentForChat(mapping);

      // Classify the message to decide: quick reply or tracked issue?
      const { classifyMessage } = await import("./message-classifier.js");
      const classification = classifyMessage(msg.text);
      console.log(
        `[telegram-bridge] classified: intent=${classification.intent} confidence=${classification.confidence} reason="${classification.reason}" text="${(msg.text ?? "").slice(0, 60)}"`,
      );

      // Conversational messages → local LLM shortcut (no Paperclip issue).
      if (classification.intent === "conversational" && classification.confidence >= 0.5) {
        const { answerConversational } = await import("./local-llm.js");
        const result = await answerConversational(msg.text ?? "");
        if (result.ok) {
          console.log(`[telegram-bridge] conversational reply (model=${result.model}): "${result.text.slice(0, 80)}"`);
          const { sendMarkdownMessage } = await import("./telegram-bot.js");
          await sendMarkdownMessage(bot, mapping.chatId, result.text, mapping.threadId, msg.messageId);
          return;
        }
        // LLM shortcut failed — fall through to Paperclip issue path
        const errMsg: string = (result as any).error ?? "unknown";
        console.warn(`[telegram-bridge] conversational LLM failed: ${errMsg} — falling back to issue`);
      }

      // Content capture → silent vault capture (no Paperclip issue).
      // Reacts 👀, fetches content, classifies, writes to vault, confirms briefly.
      if (classification.intent === "content_capture") {
        const { captureContent } = await import("./content-capture.js");
        const chatIdNum = typeof msg.chatId === "string" ? parseInt(msg.chatId, 10) : msg.chatId;
        const result = await captureContent(
          msg.text ?? "",
          bot,
          chatIdNum,
          msg.messageId,
          mapping.threadId,
        );
        if (result.ok) {
          console.log(
            `[telegram-bridge] content capture: chat=${msg.chatId} → ${result.vaultPath} "${result.title}"`,
          );
        } else {
          console.error(`[telegram-bridge] content capture failed: ${(result as any).error}`);
        }
        return;
      }

      // Task / ephemeral / fallback → Paperclip.
      // THREADING: if there's a recent open issue for this agent, add the
      // follow-up as a comment instead of creating a duplicate issue.
      const existingIssue = await client.findRecentOpenIssue(mapping.companyId, fm.defaultAgentId, 30);
      if (existingIssue) {
        try {
          await client.createComment(existingIssue.id, `**Follow-up:** ${msg.text ?? ""}`);
          // Re-wake the agent so it processes the new comment
          await client.wakeAgent(fm.defaultAgentId, {
            reason: `telegram-followup:${existingIssue.identifier}`,
            source: "on_demand",
          });
          // Map the existing issue to this chat for outbound routing
          issueToChat.set(existingIssue.id, {
            mapping,
            originatingMessageId: msg.messageId,
            logicalTaskId: `telegram:${msg.chatId}:${msg.messageId}`,
            completionAcked: false,
          });
          startTyping(existingIssue.id, mapping.chatId);
          await persistMemo();
          console.log(
            `[telegram-bridge] follow-up: chat=${msg.chatId} → existing issue ${existingIssue.identifier} (${existingIssue.id.slice(0, 8)})`,
          );
          return;
        } catch (err: any) {
          console.warn(`[telegram-bridge] follow-up comment failed, creating new issue: ${err?.message || err}`);
          // Fall through to create a new issue
        }
      }

      // No recent open issue → create a new one
      const req = buildIssueRequest(msg, mapping);
      req.agentId = fm.defaultAgentId;
      // Ephemeral messages (needs tools but not board clutter) get interactive originKind.
      if (classification.intent === "ephemeral") {
        req.originKind = "interactive";
      }
      try {
        const issueId = await postIssueAndWakeup(req, client);
        issueToChat.set(issueId, {
          mapping,
          originatingMessageId: msg.messageId,
          logicalTaskId: req.logicalTaskId,
          completionAcked: false,
        });
        startTyping(issueId, mapping.chatId);
        await persistMemo();
        console.log(
          `[telegram-bridge] inbound: chat=${msg.chatId} workspace=${mapping.workspace} agent=${fm.defaultAgentId} → issue=${issueId} logical=${req.logicalTaskId} origin=${req.originKind || "manual"}`,
        );
      } catch (err: any) {
        console.error(`[telegram-bridge] postIssueAndWakeup failed: ${err?.message || err}`);
      }
    },
    onError: (err, where) => {
      console.error(`[telegram-bridge] error in ${where}:`, err);
    },
    commandDeps: {
      client,
      findMapping: (chatId: string, threadId?: number) =>
        findMappingForChat(mappings, chatId, threadId),
      verbose: process.env.MATTCLAW_VERBOSE === "1",
    },
  });

  // Start HTTP server (Alpaca webhooks + approval surface endpoint).
  // Must be started AFTER bot is created so approval surface can call bot.api.
  startHttpServer(client, bot);

  // ---------------------------------------------------------------------------
  // Typing indicator manager — keeps "typing..." alive until first reply
  // ---------------------------------------------------------------------------
  // Telegram's sendChatAction("typing") expires after 5 seconds. Agents
  // typically take 30s–5min to respond. This manager refreshes the typing
  // indicator every 4 seconds for each pending issue. It stops when:
  //   1. The first outbound comment for that issue is delivered (via stopTyping)
  //   2. The issue hasn't had a comment after TYPING_TIMEOUT_MS (avoids
  //      perpetual typing for abandoned/dead issues).
  const TYPING_INTERVAL_MS = 4_000;
  const TYPING_TIMEOUT_MS = 5 * 60 * 1_000; // 5 min — stop typing if no reply
  const pendingTyping = new Map<string, { chatId: string; startedAt: number }>();

  /** Start refreshing the typing indicator for a pending issue. */
  const startTyping = (issueId: string, chatId: string) => {
    pendingTyping.set(issueId, { chatId, startedAt: Date.now() });
  };

  /** Stop the typing indicator for an issue (called when first reply lands). */
  const stopTyping = (issueId: string) => {
    pendingTyping.delete(issueId);
  };

  // Periodic refresh loop — sends typing action for all pending issues.
  const typingInterval = setInterval(async () => {
    const now = Date.now();
    for (const [issueId, info] of pendingTyping) {
      if (now - info.startedAt > TYPING_TIMEOUT_MS) {
        pendingTyping.delete(issueId);
        continue;
      }
      try {
        await bot.api.sendChatAction(info.chatId, "typing");
      } catch {
        /* best-effort — chat may have been deleted */
      }
    }
  }, TYPING_INTERVAL_MS);
  // Don't let the interval keep the process alive unnecessarily
  if (typingInterval.unref) typingInterval.unref();

  // Wire up Telegram callback_query handler for approval inline keyboard buttons.
  // Fires when Matt presses Approve/Reject on an approval card, or action buttons
  // on issue cards (rework, verify, escalate).
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const queryId = ctx.callbackQuery.id;
    if (data.startsWith("approve:") || data.startsWith("reject:")) {
      try {
        await handleApprovalCallback(data, queryId, bot, client);
      } catch (err: any) {
        console.error(`[approval] callback handler error: ${err?.message ?? err}`);
        try {
          await bot.api.answerCallbackQuery(queryId, { text: "Error processing approval. Check logs." });
        } catch { /* ignore */ }
      }
    } else if (data.startsWith("action:")) {
      try {
        await handleActionCallback(data, queryId, bot, client);
      } catch (err: any) {
        console.error(`[action] callback handler error: ${err?.message ?? err}`);
        try {
          await bot.api.answerCallbackQuery(queryId, { text: "Error processing action." });
        } catch { /* ignore */ }
      }
    }
  });

  // Outbound poller — wakes every 10s, fetches new comments per company,
  // forwards ONLY for issues bridge itself created (via issueToChat memo).
  startOutboundPoller(bot, client, mappings, issueToChat, persistMemo, stopTyping).catch((err) => {
    console.error("[telegram-bridge] outbound poller crashed:", err);
  });

  console.log("[telegram-bridge] starting grammy long-poll");
  // Bridge polls Telegram for inbound (message + callback_query + reactions).
  // 2026-05-07 evening: v2's grammy poller was hitting persistent 409 conflicts.
  // Reverted to bridge-as-poller (the original architecture). v2 still keeps its
  // lock-based poller code for the future, but bridge wins the inbound race
  // when active. To run v2 as the poller instead, set
  // BRIDGE_DISABLE_INBOUND_POLLING=1 to bring this back to callback-only mode.
  const inboundPollingDisabled = process.env.BRIDGE_DISABLE_INBOUND_POLLING === "1";
  bot.start({
    onStart: (info) => {
      console.log(`[telegram-bridge] bot live as @${info.username}${inboundPollingDisabled ? " (callback-only mode)" : ""}`);
    },
    ...(inboundPollingDisabled
      ? { allowed_updates: ["callback_query", "message_reaction"] as const }
      : {}),
  }).catch((err) => {
    console.error(`[telegram-bridge] bot.start failed: ${(err as Error)?.message ?? err}`);
  });
  // Keep the process alive forever — outbound poller is the load-bearing
  // path. Without this await, main() returns and the process exits.
  await new Promise<void>(() => {});
  return 0;
}

/**
 * Resolve the agent UUID for a given chat mapping. Reads the workspace
 * file's `paperclip_default_agent_id` frontmatter (added in P1A-4).
 * Cached per mapping during the bot lifetime.
 */
async function loadAgentForChat(
  mapping: ChatToCompanyMapping,
): Promise<{ defaultAgentId: string }> {
  // Fast path: workspace frontmatter already has the agent UUID.
  if (mapping.defaultAgentId) return { defaultAgentId: mapping.defaultAgentId };

  const cached = AGENT_ID_CACHE.get(mapping.companyId);
  if (cached) return { defaultAgentId: cached };
  const apiUrl = process.env.PAPERCLIP_API_URL ?? "http://localhost:3100";
  const res = await fetch(`${apiUrl}/api/companies/${mapping.companyId}/agents`);
  const list = (await res.json()) as Array<{ id: string; name: string }>;
  const agent = list.find((a) => a.name.toLowerCase() === mapping.defaultAgent.toLowerCase());
  if (!agent) throw new Error(`no '${mapping.defaultAgent}' agent in company ${mapping.companyId}`);
  AGENT_ID_CACHE.set(mapping.companyId, agent.id);
  return { defaultAgentId: agent.id };
}

const AGENT_ID_CACHE = new Map<string, string>();

const POLL_INTERVAL_MS = 2_000;

type IssueOriginInfo = {
  mapping: ChatToCompanyMapping;
  originatingMessageId: number;
  logicalTaskId?: string;
  completionAcked: boolean;
};

async function startOutboundPoller(
  bot: Bot,
  client: PaperclipBridgeClient,
  mappings: ChatToCompanyMapping[],
  issueToChat: Map<string, IssueOriginInfo>,
  persistMemo: () => Promise<void> = async () => {},
  onStopTyping?: (issueId: string) => void,
): Promise<void> {
  // Dedupe ledger of comment IDs we've already forwarded. Persisted to disk
  // so restarts don't replay comments. Caps at 5000 entries (FIFO eviction).
  // This is the sole forwarding gate — no time cursor. A time cursor across
  // all issues races: another issue's comment can advance the cursor past a
  // fresh comment that hasn't arrived yet, causing silent drops.
  const seenPath = `${process.env.HOME}/.mattclaw/data/bridge-seen-comments.json`;
  const seenComments = new Set<string>();
  const seenOrder: string[] = [];
  const SEEN_CAP = 5000;
  try {
    const fs = await import("fs");
    if (fs.existsSync(seenPath)) {
      const ids = JSON.parse(fs.readFileSync(seenPath, "utf-8")) as string[];
      for (const id of ids) { seenComments.add(id); seenOrder.push(id); }
      console.log(`[telegram-bridge] loaded ${seenComments.size} seen comment IDs from disk`);
    }
  } catch (err) {
    console.error(`[telegram-bridge] seen-comments load failed: ${(err as Error)?.message ?? err}`);
  }
  const persistSeen = () => {
    try {
      const fs = require("fs");
      fs.writeFileSync(seenPath, JSON.stringify(seenOrder.slice(-SEEN_CAP)));
    } catch { /* swallow */ }
  };
  const recordSeen = (id: string) => {
    if (seenComments.has(id)) return false;
    seenComments.add(id);
    seenOrder.push(id);
    if (seenOrder.length > SEEN_CAP) {
      const evict = seenOrder.shift();
      if (evict) seenComments.delete(evict);
    }
    return true;
  };

  // Lookback window: fetch issues updated in the last 10 minutes. Wide enough
  // to catch slow agents; seenComments dedupe prevents replay.
  const LOOKBACK_MS = 10 * 60 * 1000;

  while (true) {
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
    for (const mapping of mappings) {
      const companyId = mapping.companyId;
      // Only process each company once even if multiple chat mappings share it.
      if (mappings.findIndex((m) => m.companyId === companyId) !== mappings.indexOf(mapping)) continue;
      try {
        const comments = await pollNewComments(companyId, since, client);
        for (const c of comments) {
          const isNew = recordSeen(c.id);
          if (!isNew) continue;

          let origin = issueToChat.get(c.issueId);
          if (!origin) {
            // Routine/cron issues are NOT auto-forwarded any more. The agent
            // owns delivery via the telegram_send tool inside the run; the
            // issue comment is for the audit trail only. Auto-forwarding here
            // produced a duplicate Telegram message per cron run (one polished
            // alert from telegram_send, one raw transcript from this bridge).
            // 2026-05-13 incident: position-monitor delivered twice to the
            // trading group.
            //
            // The `deliver:telegram` label remains a manual opt-in for legacy
            // routines that explicitly want bridge delivery instead of tool
            // delivery. Set this only when the agent has no telegram_send
            // capability in the run.
            const issue = await client.getIssue(c.issueId).catch(() => null);
            const explicitDeliverLabel = (issue?.labels as string[] | undefined)?.includes?.("deliver:telegram");
            if (issue && explicitDeliverLabel) {
              const wsMapping = mappings.find((m) => m.companyId === issue.companyId);
              if (wsMapping) {
                origin = {
                  mapping: wsMapping,
                  originatingMessageId: 0,
                  completionAcked: true,
                };
                issueToChat.set(c.issueId, origin);
                await persistMemo();
              }
            }
            if (!origin) {
              console.log(`[telegram-bridge] outbound skip: no inbound mapping for issue=${c.issueId} (originKind=${issue?.originKind ?? "?"})`);
              continue;
            }
          }

          console.log(`[telegram-bridge] outbound: issue=${c.issueId} comment=${c.id} chat=${origin.mapping.chatId}`);

          // Stop typing indicator — first reply for this issue is landing.
          onStopTyping?.(c.issueId);

          // Thread the reply under the originating message if we have one.
          const replyToMsgId = origin.originatingMessageId || undefined;

          // Gap 2: detect APPROVAL_REQUEST: marker in comment body.
          // If present, surface an approval card instead of forwarding the raw comment.
          const approvalReq = parseApprovalRequest(c.body);
          if (approvalReq) {
            const card: ApprovalCardSurface = {
              chatId: origin.mapping.chatId,
              threadId: origin.mapping.threadId,
              approvalId: approvalReq.approvalId ?? `auto-${c.id}`,
              prompt: approvalReq.prompt ?? c.body,
              buttons: approvalReq.buttons?.length
                ? approvalReq.buttons
                : [
                    { label: "Approve", callbackData: `approve:${approvalReq.approvalId ?? c.id}` },
                    { label: "Reject", callbackData: `reject:${approvalReq.approvalId ?? c.id}` },
                  ],
              ttlSec: approvalReq.ttlSec ?? 60,
            };
            const surfaceResult = await maybeSurfaceApproval(card, bot, c.issueId, companyId);
            if (!surfaceResult.surfaced) {
              // Surfacing was suppressed — forward the raw comment so Matt still sees it
              await sendTelegramReply(c, origin.mapping, bot, replyToMsgId);
            }
          } else {
            await sendTelegramReply(c, origin.mapping, bot, replyToMsgId);
          }
          persistSeen();
          if (origin.logicalTaskId) {
            getDispatchBudget().markCompleted(origin.logicalTaskId, c.issueId);
          }
          if (!origin.completionAcked) {
            try {
              await bot.api.setMessageReaction(
                origin.mapping.chatId,
                origin.originatingMessageId,
                [{ type: "emoji", emoji: "👍" }],
              );
              origin.completionAcked = true;
            } catch {
              /* reaction is best-effort */
            }
          }
        }
      } catch (err: any) {
        console.error(`[telegram-bridge] poll error for company ${companyId}:`, err?.message || err);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[telegram-bridge] fatal: ${err?.message || err}`);
      process.exit(1);
    });
}
