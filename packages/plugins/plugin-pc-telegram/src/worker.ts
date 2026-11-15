import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import {
  ACTION_CANCEL_LOGIN,
  ACTION_DISCONNECT,
  ACTION_SET_PAUSED,
  ACTION_START_LOGIN,
  ACTION_SUBMIT_PASSWORD,
  ACTION_UPDATE_CONNECTION,
  DATA_LOGIN_STATUS,
  DATA_OVERVIEW,
  DIALOG_ORIGIN_KIND,
  LOGIN_STREAM_CHANNEL,
  PLUGIN_ID,
  TOOL_SEND_TEXT,
} from "./constants.js";
import {
  findConnection,
  listConnections,
  listKnownCompanyIds,
  patchConnection,
  publicConnection,
  upsertConnection,
} from "./connections.js";
import { chatListLabel, dialogOriginId, ingestInboundMessage, parseDialogOriginId, reopenDialogForInbound } from "./inbound.js";
import { historyCacheKey, historyHitIsFresh, patchHistoryMessages, removeHistoryMessages } from "./history-slice.js";
import { publicForward } from "./forward.js";
import { bubbleFromStoredBody, type ChatBubble } from "./thread.js";
import {
  decideDialogFollowup,
  outboundTextHash,
  readStoredOutbound,
  refuseOperatorReport,
  TELEGRAM_OUTBOUND_NAMESPACE,
  TELEGRAM_OUTBOUND_STATE_KEY,
} from "./relay.js";
import { idleLoginStatus, reduceLogin } from "./login.js";
import { redactValue } from "./redaction.js";
import { reactionEmoji, telegramMessageIds } from "./message-menu.js";
import { authorizeOperatorDialog, authorizeOperatorReply, authorizeSendText } from "./send.js";
import {
  deleteAccountSession,
  getAccountSession,
  newSessionSecretId,
  putAccountSession,
  resolveTelegramAppCredentials,
} from "./secrets.js";
import { publicChannelTitle, publicPhoto, publicPresence, publicSharedChats, unreadCount } from "./peer-card.js";
import { createGramJsClientFactory, telegramSessionDeviceModel } from "./telegram-gramjs.js";
import type {
  InboxPeerUpdate,
  LiveTelegramAccount,
  LoginStatus,
  QrLoginHandle,
  ResolveAppCredentials,
  SignedInSession,
  TelegramClientFactory,
} from "./types.js";

export type TelegramPluginDeps = {
  createClient?: TelegramClientFactory;
  resolveAppCredentials?: ResolveAppCredentials;
};

type PendingLogin = {
  companyId: string;
  loginId: string;
  handle: QrLoginHandle;
  status: LoginStatus;
  signedIn: SignedInSession | null;
  sessionSecretId: string | null;
  persisted: boolean;
  persistTask: Promise<void> | null;
};

const INVOCATION_SCOPE_DENIED = -32005;
const INBOX_STREAM = "telegram-inbox";

type DialogCard = {
  name: string;
  preview: string;
  unread: number;
  photo: string | null;
  presence: ReturnType<typeof publicPresence>;
  activityAt: string;
};

function isInvocationScopeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code === INVOCATION_SCOPE_DENIED) return true;
  return error instanceof Error && error.message.includes("Missing or unknown invocation scope");
}

function wrapLogger(ctx: PluginContext): PluginContext["logger"] {
  return {
    info(message, meta) {
      ctx.logger.info(message, redactValue(meta) as Record<string, unknown> | undefined);
    },
    warn(message, meta) {
      ctx.logger.warn(message, redactValue(meta) as Record<string, unknown> | undefined);
    },
    error(message, meta) {
      ctx.logger.error(message, redactValue(meta) as Record<string, unknown> | undefined);
    },
    debug(message, meta) {
      ctx.logger.debug(message, redactValue(meta) as Record<string, unknown> | undefined);
    },
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireCompanyId(value: unknown, fallback?: string | null): string {
  const companyId = readString(value) || readString(fallback);
  if (!companyId) throw new Error("companyId is required.");
  return companyId;
}

export function createTelegramUserClientPlugin(deps: TelegramPluginDeps = {}) {
  const createClient = deps.createClient ?? createGramJsClientFactory();
  const liveByAccount = new Map<string, LiveTelegramAccount>();
  const pendingLogins = new Map<string, PendingLogin>();
  const peerLabels = new Map<string, string>();
  const dialogCards = new Map<string, { cards: Map<string, DialogCard> }>();
  const dialogPhotos = new Map<string, string>();
  const cardJobs = new Map<string, Promise<Map<string, DialogCard>>>();
  const historyCache = new Map<string, { at: number; messages: ChatBubble[] }>();
  const historyJobs = new Map<string, Promise<ChatBubble[]>>();
  const pendingLatest = new Map<string, ChatBubble[]>();
  const issueRefs = new Map<string, string>();
  const outboundMemory = new Map<string, { hash: string; at: number; sentHashes: string[] }>();
  const pendingOutbound = new Map<string, string>();
  const followupChains = new Map<string, Promise<void>>();
  const wokenComments = new Set<string>();
  let pluginContext: PluginContext | null = null;

  const resolveCredentials: ResolveAppCredentials = async (companyId) => {
    if (deps.resolveAppCredentials) return deps.resolveAppCredentials(companyId);
    if (!pluginContext) throw new Error("Plugin is not started.");
    return resolveTelegramAppCredentials(pluginContext, companyId);
  };

  function liveAccountIds(): Set<string> {
    return new Set(liveByAccount.keys());
  }

  function emitLogin(companyId: string, status: LoginStatus) {
    const ctx = pluginContext;
    if (!ctx) return;
    ctx.streams.emit(LOGIN_STREAM_CHANNEL, { companyId, status });
  }

  function emitInbox(companyId: string, event: Record<string, unknown>) {
    const ctx = pluginContext;
    if (!ctx) return;
    try {
      ctx.streams.open(INBOX_STREAM, companyId);
      ctx.streams.emit(INBOX_STREAM, event);
    } catch {
      // The open dialog still refreshes from the worker slice when the stream is down.
    }
  }

  function cardBucket(companyId: string, accountId: string): Map<string, DialogCard> | null {
    return dialogCards.get(`${companyId}:${accountId}`)?.cards ?? null;
  }

  function dialogPhotoKey(companyId: string, accountId: string, peerId: string): string {
    return `${companyId}:${accountId}:${peerId}`;
  }

  function keepDialogPhoto(companyId: string, accountId: string, peerId: string, photo: string | null, replace: boolean): string | null {
    const key = dialogPhotoKey(companyId, accountId, peerId);
    const safe = publicPhoto(photo);
    if (safe && (replace || !dialogPhotos.has(key))) dialogPhotos.set(key, safe);
    return dialogPhotos.get(key) ?? null;
  }

  function dropAccountCache(accountId: string) {
    const prefix = `${accountId}:`;
    for (const key of historyCache.keys()) {
      if (key.startsWith(prefix)) historyCache.delete(key);
    }
    for (const key of dialogCards.keys()) {
      if (key.endsWith(`:${accountId}`)) dialogCards.delete(key);
    }
    for (const key of cardJobs.keys()) {
      if (key.endsWith(`:${accountId}`)) cardJobs.delete(key);
    }
    for (const key of pendingLatest.keys()) {
      if (key.startsWith(prefix)) pendingLatest.delete(key);
    }
  }

  function pendingHistoryKey(accountId: string, peerId: string): string {
    return `${accountId}:${peerId}`;
  }

  function stashPendingBubble(accountId: string, peerId: string, bubble: ChatBubble) {
    const key = pendingHistoryKey(accountId, peerId);
    pendingLatest.set(key, patchHistoryMessages(pendingLatest.get(key) ?? [], [bubble]));
  }

  function takePendingBubbles(accountId: string, peerId: string): ChatBubble[] {
    const key = pendingHistoryKey(accountId, peerId);
    const rows = pendingLatest.get(key) ?? [];
    pendingLatest.delete(key);
    return rows;
  }

  function stripPending(accountId: string, peerId: string | null, ids: string[]) {
    for (const [key, rows] of pendingLatest) {
      const match = peerId ? key === pendingHistoryKey(accountId, peerId) : key.startsWith(`${accountId}:`);
      if (!match) continue;
      const next = removeHistoryMessages(rows, ids);
      if (next.length === 0) pendingLatest.delete(key);
      else pendingLatest.set(key, next);
    }
  }

  function rememberIssueRef(companyId: string, accountId: string, peerId: string, issueRef: string) {
    if (!issueRef) return;
    issueRefs.set(`${companyId}:${accountId}:${peerId}`, issueRef);
  }

  async function issueRefFor(companyId: string, accountId: string, peerId: string, known = ""): Promise<string> {
    if (known) {
      rememberIssueRef(companyId, accountId, peerId, known);
      return known;
    }
    const key = `${companyId}:${accountId}:${peerId}`;
    const cached = issueRefs.get(key);
    if (cached) return cached;
    const ctx = pluginContext;
    if (!ctx) return "";
    try {
      const issues = await ctx.issues.list({
        companyId,
        originKind: DIALOG_ORIGIN_KIND,
        originId: dialogOriginId(accountId, peerId),
        limit: 1,
      });
      const issue = issues[0];
      const ref = issue?.identifier || issue?.id || "";
      rememberIssueRef(companyId, accountId, peerId, ref);
      return ref;
    } catch {
      return "";
    }
  }

  function patchPeerHistory(accountId: string, peerId: string, bubble: ChatBubble, inserted: boolean): boolean {
    const prefix = `${accountId}:${peerId}:`;
    let seen = false;
    let hasLatest = false;
    for (const [key, entry] of historyCache) {
      if (!key.startsWith(prefix)) continue;
      if (key.endsWith(":latest")) hasLatest = true;
      const has = entry.messages.some((message) => message.id === bubble.id);
      if (!has && !key.endsWith(":latest")) continue;
      if (has) seen = true;
      historyCache.set(key, {
        at: key.endsWith(":latest") ? entry.at : Date.now(),
        messages: patchHistoryMessages(entry.messages, [bubble]),
      });
    }
    const queued = (pendingLatest.get(pendingHistoryKey(accountId, peerId)) ?? []).some((message) => message.id === bubble.id);
    if (!hasLatest && inserted) stashPendingBubble(accountId, peerId, bubble);
    return seen || queued;
  }

  function touchDialogCard(update: Extract<InboxPeerUpdate, { type: "upsert" }>, already: boolean) {
    const card = cardBucket(update.companyId, update.accountId)?.get(update.peerId);
    if (!card) return null;
    const at = update.bubble.at || new Date().toISOString();
    if (!card.activityAt || at >= card.activityAt) {
      const preview = update.bubble.text.replace(/\s+/g, " ").trim().slice(0, 80);
      if (preview) card.preview = preview;
      card.activityAt = at;
    }
    if (update.inserted && !already && update.bubble.direction === "in") card.unread += 1;
    if (update.inserted && !already && update.bubble.direction === "out") card.unread = 0;
    return card;
  }

  function applyInboxUpdate(update: InboxPeerUpdate, knownRef = "") {
    if (update.type === "gap") {
      dropAccountCache(update.accountId);
      emitInbox(update.companyId, { companyId: update.companyId, kind: "gap" });
      return;
    }
    if (update.type === "photo") {
      const photo = keepDialogPhoto(update.companyId, update.accountId, update.peerId, update.photo, true);
      if (!photo) return;
      const card = cardBucket(update.companyId, update.accountId)?.get(update.peerId);
      if (card) card.photo = photo;
      void issueRefFor(update.companyId, update.accountId, update.peerId, knownRef).then((issueRef) => {
        if (!issueRef) return;
        emitInbox(update.companyId, {
          companyId: update.companyId,
          kind: "dialog",
          issueRef,
          photo,
          preview: card?.preview ?? "",
          unread: card?.unread ?? 0,
          activityAt: card?.activityAt ?? "",
        });
      });
      return;
    }
    if (update.type === "delete") {
      const prefix = update.peerId ? `${update.accountId}:${update.peerId}:` : `${update.accountId}:`;
      const peers = new Set<string>();
      for (const [key, entry] of historyCache) {
        if (!key.startsWith(prefix)) continue;
        const next = removeHistoryMessages(entry.messages, update.messageIds);
        if (next.length === entry.messages.length) continue;
        historyCache.set(key, { at: entry.at, messages: next });
        const parts = key.split(":");
        const peerId = parts[1] ?? "";
        if (peerId) peers.add(peerId);
      }
      stripPending(update.accountId, update.peerId, update.messageIds);
      const targets = update.peerId ? [update.peerId] : [...peers];
      for (const peerId of targets) {
        void issueRefFor(update.companyId, update.accountId, peerId, knownRef).then((issueRef) => {
          if (!issueRef) return;
          emitInbox(update.companyId, {
            companyId: update.companyId,
            kind: "delete",
            issueRef,
            messageIds: update.messageIds,
          });
        });
      }
      return;
    }
    const already = patchPeerHistory(update.accountId, update.peerId, update.bubble, update.inserted);
    const card = touchDialogCard(update, already);
    void issueRefFor(update.companyId, update.accountId, update.peerId, knownRef).then((issueRef) => {
      if (!issueRef) return;
      emitInbox(update.companyId, {
        companyId: update.companyId,
        kind: "message",
        issueRef,
        bubble: update.bubble,
        preview: card?.preview ?? update.bubble.text.replace(/\s+/g, " ").trim().slice(0, 80),
        unread: card?.unread ?? 0,
        activityAt: card?.activityAt || update.bubble.at,
        photo: keepDialogPhoto(update.companyId, update.accountId, update.peerId, card?.photo ?? null, false),
      });
    });
  }

  async function handleInbound(message: Parameters<typeof ingestInboundMessage>[2]) {
    const ctx = pluginContext;
    if (!ctx) return;
    const log = wrapLogger(ctx);
    const connection = await findConnection(ctx, message.companyId, message.accountId, liveAccountIds());
    if (!connection) {
      log.warn("Dropped inbound Telegram message for an unknown account", {
        companyId: message.companyId,
        accountId: message.accountId,
      });
      return;
    }
    let issue: { identifier?: string | null; id: string } | null = null;
    try {
      issue = await ingestInboundMessage(ctx, connection, message);
    } catch (error) {
      log.error("Failed to ingest Telegram inbound message", {
        companyId: message.companyId,
        accountId: message.accountId,
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
    const text = message.text.replace(/\s+/g, " ").trim().slice(0, 4000);
    if (!message.messageId || (!text && !message.forward)) return;
    applyInboxUpdate({
      type: "upsert",
      companyId: message.companyId,
      accountId: message.accountId,
      peerId: message.peerId,
      inserted: true,
      bubble: {
        id: message.messageId,
        direction: "in",
        text,
        at: new Date().toISOString(),
        forward: message.forward ? publicForward(message.forward) : null,
      },
    }, issue?.identifier || issue?.id || "");
  }

  async function attachLiveSession(companyId: string, live: LiveTelegramAccount) {
    const existing = liveByAccount.get(live.account.telegramUserId);
    if (existing && existing.companyId !== companyId) {
      await live.disconnect().catch(() => undefined);
      throw new Error("That Telegram account is already connected.");
    }
    if (existing && existing !== live) {
      await existing.disconnect().catch(() => undefined);
    }
    liveByAccount.set(live.account.telegramUserId, live);
  }

  async function persistSignedIn(pending: PendingLogin): Promise<void> {
    if (pending.persisted) return;
    if (pending.persistTask) return pending.persistTask;
    const signedIn = pending.signedIn;
    const ctx = pluginContext;
    if (!signedIn || !ctx) return;
    const task = (async () => {
      if (!pending.sessionSecretId) pending.sessionSecretId = newSessionSecretId();
      await putAccountSession(ctx, pending.companyId, pending.sessionSecretId, signedIn.session);
      await upsertConnection(ctx, {
        companyId: pending.companyId,
        account: signedIn.account,
        sessionSecretId: pending.sessionSecretId,
      });
      pending.persisted = true;
      pending.status = reduceLogin(pending.status, {
        type: "connected",
        loginId: pending.loginId,
        account: signedIn.account,
      });
      try {
        emitLogin(pending.companyId, pending.status);
      } catch {
        // The login action has already finished, so its invocation can no longer emit.
        // The next status or overview read still returns the stored account.
      }
      try {
        const credentials = await resolveCredentials(pending.companyId);
        const live = await createClient.connectFromSession({
          companyId: pending.companyId,
          credentials,
          session: signedIn.session,
          deviceModel: await deviceModelForCompany(pending.companyId),
          onInbound: handleInbound,
          onInboxUpdate: (update) => applyInboxUpdate(update),
        });
        await attachLiveSession(pending.companyId, live);
      } catch (error) {
        wrapLogger(ctx).error("Telegram account saved but the live connection failed", {
          companyId: pending.companyId,
          message: error instanceof Error ? error.message : "unknown error",
        });
      }
      wrapLogger(ctx).info("Telegram account connected", {
        companyId: pending.companyId,
        telegramUserId: signedIn.account.telegramUserId,
      });
    })();
    const tracked = task.finally(() => {
      if (pending.persistTask === tracked) pending.persistTask = null;
    });
    pending.persistTask = tracked;
    return tracked;
  }

  async function flushSignedInAccounts(companyId: string): Promise<void> {
    for (const pending of pendingLogins.values()) {
      if (pending.companyId !== companyId || !pending.signedIn || pending.persisted) continue;
      try {
        await persistSignedIn(pending);
      } catch (error) {
        if (!isInvocationScopeError(error)) throw error;
      }
    }
  }

  async function deviceModelForCompany(companyId: string): Promise<string> {
    const current = pluginContext;
    if (!current) return telegramSessionDeviceModel(null);
    try {
      const company = await current.companies.get(companyId);
      return telegramSessionDeviceModel(company?.name);
    } catch (error) {
      wrapLogger(current).warn("Using the fallback Telegram session name", {
        companyId,
        message: error instanceof Error ? error.message : "unknown error",
      });
      return telegramSessionDeviceModel(null);
    }
  }

  async function reconnectCompany(ctx: PluginContext, companyId: string) {
    const log = wrapLogger(ctx);
    const connections = await listConnections(ctx, companyId, liveAccountIds());
    for (const connection of connections) {
      if (liveByAccount.has(connection.telegramUserId)) continue;
      if (!connection.sessionSecretId) continue;
      const session = await getAccountSession(ctx, companyId, connection.sessionSecretId);
      if (!session) continue;
      try {
        const credentials = await resolveCredentials(companyId);
        const live = await createClient.connectFromSession({
          companyId,
          credentials,
          session,
          deviceModel: await deviceModelForCompany(companyId),
          onInbound: handleInbound,
          onInboxUpdate: (update) => applyInboxUpdate(update),
        });
        await attachLiveSession(companyId, live);
        log.info("Reconnected Telegram account from stored session", {
          companyId,
          telegramUserId: connection.telegramUserId,
        });
      } catch (error) {
        log.error("Failed to reconnect Telegram account", {
          companyId,
          telegramUserId: connection.telegramUserId,
          message: error instanceof Error ? error.message : "unknown error",
        });
      }
    }
  }

  async function reconnectAll(ctx: PluginContext) {
    const companyIds = await listKnownCompanyIds(ctx);
    for (const companyId of companyIds) {
      await reconnectCompany(ctx, companyId);
    }
  }

  async function rememberOutbound(ctx: PluginContext, issueId: string, text: string) {
    const previous = outboundMemory.get(issueId) ?? await loadOutbound(ctx, issueId);
    const hash = outboundTextHash(text);
    const sentHashes = [...new Set([...(previous?.sentHashes ?? []), hash])].slice(-100);
    const record = { hash, at: Date.now(), sentHashes };
    outboundMemory.set(issueId, record);
    try {
      await ctx.state.set({
        scopeKind: "issue",
        scopeId: issueId,
        namespace: TELEGRAM_OUTBOUND_NAMESPACE,
        stateKey: TELEGRAM_OUTBOUND_STATE_KEY,
      }, record);
    } catch (error) {
      wrapLogger(ctx).warn("Failed to store Telegram outbound marker", {
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  async function loadOutbound(ctx: PluginContext, issueId: string) {
    const cached = outboundMemory.get(issueId);
    if (cached) return cached;
    const stored = readStoredOutbound(await ctx.state.get({
      scopeKind: "issue",
      scopeId: issueId,
      namespace: TELEGRAM_OUTBOUND_NAMESPACE,
      stateKey: TELEGRAM_OUTBOUND_STATE_KEY,
    }));
    if (stored) outboundMemory.set(issueId, stored);
    return stored;
  }

  function enqueueFollowup(issueId: string, work: () => Promise<void>): Promise<void> {
    const previous = followupChains.get(issueId) ?? Promise.resolve();
    const next = previous.then(work, work);
    followupChains.set(issueId, next.then(() => undefined, () => undefined));
    return next;
  }

  async function wakeDialog(ctx: PluginContext, issueId: string, companyId: string, status: string, commentId: string) {
    if (wokenComments.has(commentId)) return;
    wokenComments.add(commentId);
    try {
      const reopened = reopenDialogForInbound(status);
      if (reopened) await ctx.issues.update(issueId, { status: reopened }, companyId);
      await ctx.issues.requestWakeup(issueId, companyId, {
        reason: "telegram-followup",
        contextSource: "plugin-pc-telegram",
        idempotencyKey: `telegram-followup:${commentId}`,
      });
      wrapLogger(ctx).info("Queued Telegram dialog follow-up", { companyId, issueId });
    } catch (error) {
      wokenComments.delete(commentId);
      throw error;
    }
  }

  async function followDialog(
    ctx: PluginContext,
    issueId: string,
    companyId: string,
  ) {
    await enqueueFollowup(issueId, async () => {
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue || issue.originKind !== DIALOG_ORIGIN_KIND) return;
      const parsed = parseDialogOriginId(issue.originId);
      if (!parsed) return;
      const connection = await findConnection(ctx, companyId, parsed.accountId, liveAccountIds());
      if (!connection || connection.paused || connection.incomingMode !== "dialog_task" || !connection.assignedAgentId) return;
      if (issue.assigneeAgentId && issue.assigneeAgentId !== connection.assignedAgentId) return;
      const comments = await ctx.issues.listComments(issueId, companyId);
      const stored = await loadOutbound(ctx, issueId);
      const decision = decideDialogFollowup({
        comments,
        assignedAgentId: connection.assignedAgentId,
        lastOutboundAt: stored?.at ?? null,
        lastOutboundHash: stored?.hash ?? null,
        sentHashes: stored?.sentHashes ?? null,
      });
      if (decision.wake && decision.wakeCommentId) {
        await wakeDialog(ctx, issueId, companyId, issue.status, decision.wakeCommentId);
      }
    });
  }

  function bindDialogFollowup(ctx: PluginContext, log: PluginContext["logger"]) {
    ctx.events.on("agent.run.finished", async (event) => {
      try {
        const payload = event.payload && typeof event.payload === "object"
          ? event.payload as Record<string, unknown>
          : {};
        if (payload.status !== "succeeded") return;
        const issueId = readString(payload.issueId);
        if (!issueId) return;
        await followDialog(ctx, issueId, event.companyId);
      } catch (error) {
        log.error("Telegram dialog follow-up failed", {
          message: error instanceof Error ? error.message : "unknown error",
        });
      }
    });
  }

  async function syncDialogFollowups(ctx: PluginContext, log: PluginContext["logger"]) {
    const companyIds = await listKnownCompanyIds(ctx);
    for (const companyId of companyIds) {
      let issues;
      try {
        issues = await ctx.issues.list({
          companyId,
          originKind: DIALOG_ORIGIN_KIND,
          limit: 20,
        });
      } catch (error) {
        log.error("Telegram dialog list failed", {
          companyId,
          message: error instanceof Error ? error.message : "unknown error",
        });
        continue;
      }
      for (const issue of issues) {
        try {
          await followDialog(ctx, issue.id, companyId);
        } catch (error) {
          log.error("Telegram dialog sync failed", {
            companyId,
            message: error instanceof Error ? error.message : "unknown error",
          });
        }
      }
    }
  }

  const plugin = definePlugin({
    multiCompanyConfig: true,
    async setup(ctx) {
      pluginContext = ctx;
      const log = wrapLogger(ctx);

      ctx.data.register(DATA_OVERVIEW, async (params) => {
        const companyId = requireCompanyId(params.companyId);
        await flushSignedInAccounts(companyId);
        const connections = await listConnections(ctx, companyId, liveAccountIds());
        return {
          pluginId: PLUGIN_ID,
          credentialsConfigured: await credentialsConfigured(ctx, companyId),
          connections: connections.map(publicConnection),
        };
      });

      async function cardsForAccount(companyId: string, accountId: string): Promise<Map<string, DialogCard>> {
        const key = `${companyId}:${accountId}`;
        const stored = cardBucket(companyId, accountId);
        if (stored) return stored;
        const pending = cardJobs.get(key);
        if (pending) return pending;
        const live = liveByAccount.get(accountId);
        if (!live || live.companyId !== companyId) return new Map();
        const job = (async () => {
          try {
            const cards = new Map<string, DialogCard>();
            for (const row of await live.peerSummaries()) {
              if (!row?.id || !row.name) continue;
              cards.set(row.id, {
                name: row.name,
                preview: typeof row.preview === "string" ? row.preview.slice(0, 80) : "",
                unread: unreadCount(row.unread),
                photo: keepDialogPhoto(companyId, accountId, row.id, publicPhoto(row.photo), false),
                presence: publicPresence(row.presence),
                activityAt: typeof row.activityAt === "string" ? row.activityAt : "",
              });
            }
            dialogCards.set(key, { cards });
            return cards;
          } catch {
            log.warn("Telegram dialog cards are unavailable");
            return cardBucket(companyId, accountId) ?? new Map();
          }
        })();
        cardJobs.set(key, job);
        void job.finally(() => {
          if (cardJobs.get(key) === job) cardJobs.delete(key);
        });
        return job;
      }

      async function loadHistory(accountId: string, peerId: string, beforeId: string): Promise<ChatBubble[]> {
        const live = liveByAccount.get(accountId);
        if (!live) return [];
        const key = historyCacheKey(accountId, peerId, beforeId);
        const hit = historyCache.get(key);
        if (hit && historyHitIsFresh(beforeId, hit.at, Date.now())) return hit.messages;
        const pending = historyJobs.get(key);
        if (pending) return pending;
        const job = live.readHistory(peerId, 40, beforeId || undefined).then((messages) => {
          const current = historyCache.get(key);
          const fetched = current && !beforeId ? patchHistoryMessages(current.messages, messages) : messages;
          const pending = beforeId ? [] : takePendingBubbles(accountId, peerId);
          const merged = pending.length > 0 ? patchHistoryMessages(fetched, pending) : fetched;
          historyCache.set(key, { at: Date.now(), messages: merged });
          return merged;
        }).finally(() => {
          if (historyJobs.get(key) === job) historyJobs.delete(key);
        });
        historyJobs.set(key, job);
        return job;
      }

      async function resolveDialogLabel(companyId: string, issue: { title?: string | null; originId?: string | null }): Promise<string> {
        const titled = chatListLabel(issue.title ?? "");
        if (titled !== "Telegram") return titled;
        const parsed = parseDialogOriginId(issue.originId);
        if (!parsed) return titled;
        const key = `${companyId}:${parsed.accountId}:${parsed.peerId}`;
        const remembered = peerLabels.get(key);
        if (remembered) return remembered;
        let found = (await cardsForAccount(companyId, parsed.accountId)).get(parsed.peerId)?.name ?? "";
        if (!found) {
          const live = liveByAccount.get(parsed.accountId);
          if (live && live.companyId === companyId) {
            try {
              found = (await live.peerName(parsed.peerId)) ?? "";
            } catch {
              found = "";
            }
          }
        }
        if (!found) return titled;
        peerLabels.set(key, found);
        return found;
      }

      ctx.data.register("chats", async (params) => {
        const companyId = readString(params.companyId);
        if (!companyId) return { chats: [] };
        const issues = await ctx.issues.list({
          companyId,
          originKind: DIALOG_ORIGIN_KIND,
          limit: 50,
        });
        const chats = await Promise.all(issues.map(async (issue) => {
          const updatedAt = issue.updatedAt instanceof Date
            ? issue.updatedAt.toISOString()
            : typeof issue.updatedAt === "string"
              ? issue.updatedAt
              : "";
          const parsed = parseDialogOriginId(issue.originId);
          const card = parsed ? (await cardsForAccount(companyId, parsed.accountId)).get(parsed.peerId) : undefined;
          if (parsed) rememberIssueRef(companyId, parsed.accountId, parsed.peerId, issue.identifier || issue.id);
          const activityAt = card?.activityAt || updatedAt;
          return {
            issueId: issue.id,
            identifier: issue.identifier ?? null,
            label: card?.name || await resolveDialogLabel(companyId, issue),
            status: issue.status,
            updatedAt: activityAt,
            preview: card?.preview || null,
            unread: card?.unread || 0,
            photo: parsed
              ? keepDialogPhoto(companyId, parsed.accountId, parsed.peerId, card?.photo ?? null, false)
              : null,
            presence: card?.presence ?? null,
          };
        }));
        chats.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        const page = chats.slice(0, 30);
        let warming = 0;
        for (const row of page) {
          if (warming >= 3) break;
          const issue = issues.find((item) => item.id === row.issueId);
          const parsed = issue ? parseDialogOriginId(issue.originId) : null;
          if (!parsed) continue;
          const account = liveByAccount.get(parsed.accountId);
          if (!account || account.companyId !== companyId) continue;
          if (historyCache.has(historyCacheKey(parsed.accountId, parsed.peerId, ""))) continue;
          warming += 1;
          void loadHistory(parsed.accountId, parsed.peerId, "").catch(() => undefined);
        }
        return { chats: page };
      });

      async function findDialogIssue(companyId: string, issueRef: string) {
        const issues = await ctx.issues.list({
          companyId,
          originKind: DIALOG_ORIGIN_KIND,
          limit: 50,
        });
        const match = issues.find((issue) => issue.identifier === issueRef || issue.id === issueRef);
        if (match) return match;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issueRef)) return null;
        const issue = await ctx.issues.get(issueRef, companyId);
        if (!issue || issue.originKind !== DIALOG_ORIGIN_KIND) return null;
        return issue;
      }

      function threadTime(value: unknown): string {
        if (value instanceof Date) return value.toISOString();
        return typeof value === "string" ? value : "";
      }

      function pushStored(bubbles: ChatBubble[], id: string, body: string, at: string) {
        const parsed = bubbleFromStoredBody(body);
        if (!parsed.text && !parsed.forward) return;
        bubbles.push({ id, direction: "in", text: parsed.text, at, forward: parsed.forward });
      }

      async function storedThread(issue: { id: string; description?: string | null; createdAt?: unknown }, companyId: string): Promise<ChatBubble[]> {
        const bubbles: ChatBubble[] = [];
        pushStored(bubbles, "description", issue.description ?? "", threadTime(issue.createdAt));
        const comments = await ctx.issues.listComments(issue.id, companyId);
        for (const comment of comments) {
          if (comment.deletedAt || comment.authorAgentId || comment.authorUserId) continue;
          pushStored(bubbles, comment.id, comment.body ?? "", threadTime(comment.createdAt));
        }
        return bubbles;
      }

      ctx.data.register("chat-thread", async (params) => {
        const companyId = readString(params.companyId);
        const issueRef = readString(params.issueRef);
        if (readString(params.beforeId) === "0") return { found: true, live: true, hasMore: false, messages: [] };
        if (!companyId || !issueRef) return { found: false, live: false, messages: [] };
        const issue = await findDialogIssue(companyId, issueRef);
        if (!issue) return { found: false, live: false, messages: [] };
        const parsed = parseDialogOriginId(issue.originId);
        const beforeId = /^\d{1,16}$/.test(readString(params.beforeId)) ? readString(params.beforeId) : "";
        const card = parsed ? cardBucket(companyId, parsed.accountId)?.get(parsed.peerId) : undefined;
        const remembered = parsed ? peerLabels.get(`${companyId}:${parsed.accountId}:${parsed.peerId}`) ?? "" : "";
        const header = {
          found: true,
          label: card?.name || remembered || chatListLabel(issue.title ?? ""),
          issueId: issue.id,
          identifier: issue.identifier ?? null,
        };
        if (!header.label || header.label === "Telegram") {
          void resolveDialogLabel(companyId, issue).catch(() => undefined);
        }
        const face = {
          photo: parsed
            ? keepDialogPhoto(companyId, parsed.accountId, parsed.peerId, card?.photo ?? null, false)
            : null,
          presence: card?.presence ?? null,
        };
        const account = parsed ? liveByAccount.get(parsed.accountId) : undefined;
        if (account && parsed && account.companyId === companyId) {
          try {
            const messages = await loadHistory(parsed.accountId, parsed.peerId, beforeId);
            return { ...header, ...face, live: true, hasMore: messages.length >= 40, messages };
          } catch {
            log.warn("Telegram history is unavailable");
          }
        }
        if (beforeId) return { ...header, ...face, live: false, hasMore: false, messages: [] };
        return { ...header, ...face, live: false, hasMore: false, messages: await storedThread(issue, companyId) };
      });

      ctx.data.register("chat-profile", async (params) => {
        const companyId = readString(params.companyId);
        const issueRef = readString(params.issueRef);
        const empty = {
          found: false,
          name: "",
          username: null,
          phone: null,
          about: null,
          photo: null,
          presence: null,
          channel: null,
          sharedChats: 0,
        };
        if (!companyId || !issueRef) return empty;
        const issue = await findDialogIssue(companyId, issueRef);
        if (!issue) return empty;
        const name = await resolveDialogLabel(companyId, issue);
        const parsed = parseDialogOriginId(issue.originId);
        const live = parsed ? liveByAccount.get(parsed.accountId) : undefined;
        const base = { ...empty, found: true, name };
        if (!live || !parsed || live.companyId !== companyId) return base;
        try {
          const profile = await live.peerProfile(parsed.peerId);
          return {
            found: true,
            name: profile.name || name,
            username: profile.username,
            phone: profile.phone,
            about: profile.about,
            photo: publicPhoto(profile.photo, 400_000),
            presence: publicPresence(profile.presence),
            channel: publicChannelTitle(profile.channel),
            sharedChats: publicSharedChats(profile.sharedChats),
          };
        } catch {
          log.warn("Telegram profile is unavailable");
          return base;
        }
      });

      ctx.actions.register("send-chat-reply", async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const issueRef = readString(params.issueRef);
        const text = readString(params.text);
        const refused = refuseOperatorReport(text);
        if (refused) throw new Error(refused);
        const issue = await findDialogIssue(companyId, issueRef);
        if (!issue) throw new Error("This issue is not a Telegram dialog.");
        const connections = await listConnections(ctx, companyId, liveAccountIds());
        const authorized = authorizeOperatorReply(connections, {
          companyId,
          issueOriginId: issue.originId,
          text,
        });
        if (!authorized.ok) throw new Error(authorized.error);
        const live = liveByAccount.get(authorized.accountId);
        if (!live || live.companyId !== companyId) {
          throw new Error("That Telegram account is not live in the plugin worker.");
        }
        const replyTo = /^\d{1,16}$/.test(readString(params.replyTo)) ? readString(params.replyTo) : "";
        await live.sendText(authorized.peerId, text.trim(), replyTo || undefined);
        await rememberOutbound(ctx, issue.id, text);
        return { sent: true };
      });

      ctx.actions.register("chat-message-menu", async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const issueRef = readString(params.issueRef);
        const op = readString(params.op);
        if (op !== "react" && op !== "pin" && op !== "unpin" && op !== "delete" && op !== "forward") {
          throw new Error("Unknown message action.");
        }
        const issue = await findDialogIssue(companyId, issueRef);
        if (!issue) throw new Error("This issue is not a Telegram dialog.");
        const connections = await listConnections(ctx, companyId, liveAccountIds());
        const authorized = authorizeOperatorDialog(connections, {
          companyId,
          issueOriginId: issue.originId,
        });
        if (!authorized.ok) throw new Error(authorized.error);
        const live = liveByAccount.get(authorized.accountId);
        if (!live || live.companyId !== companyId) {
          throw new Error("That Telegram account is not live in the plugin worker.");
        }
        const ids = telegramMessageIds(params.messageIds);
        if (ids.length === 0) throw new Error("Message id is required.");
        if (op === "react") {
          const raw = readString(params.emoji);
          const emoji = (raw ? reactionEmoji(raw) : "") ?? "";
          if (raw && !emoji) throw new Error("Reaction is unavailable.");
          await live.messageAction(authorized.peerId, { op: "react", messageId: ids[0]!, emoji });
        } else if (op === "pin" || op === "unpin") {
          await live.messageAction(authorized.peerId, { op: "pin", messageId: ids[0]!, unpin: op === "unpin" });
        } else if (op === "delete") {
          await live.messageAction(authorized.peerId, {
            op: "delete",
            messageIds: ids,
            revoke: params.revoke === true,
          });
          const prefix = `${authorized.accountId}:${authorized.peerId}:`;
          for (const [key, entry] of historyCache) {
            if (!key.startsWith(prefix)) continue;
            historyCache.set(key, { at: entry.at, messages: removeHistoryMessages(entry.messages, ids) });
          }
          stripPending(authorized.accountId, authorized.peerId, ids);
        } else {
          const target = await findDialogIssue(companyId, readString(params.targetIssueRef));
          if (!target) throw new Error("This issue is not a Telegram dialog.");
          const targetAuth = authorizeOperatorDialog(connections, {
            companyId,
            issueOriginId: target.originId,
          });
          if (!targetAuth.ok) throw new Error(targetAuth.error);
          if (targetAuth.accountId !== authorized.accountId) {
            throw new Error("That Telegram account is not connected.");
          }
          await live.messageAction(authorized.peerId, {
            op: "forward",
            messageIds: ids,
            targetPeerId: targetAuth.peerId,
          });
        }
        return { ok: true };
      });

      ctx.data.register(DATA_LOGIN_STATUS, async (params) => {
        const companyId = requireCompanyId(params.companyId);
        await flushSignedInAccounts(companyId);
        const loginId = readString(params.loginId);
        if (loginId) {
          const pending = pendingLogins.get(loginId);
          if (pending && pending.companyId === companyId) return pending.status;
        }
        const pending = [...pendingLogins.values()].find((entry) => entry.companyId === companyId);
        return pending?.status ?? idleLoginStatus();
      });

      ctx.actions.register(ACTION_START_LOGIN, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const credentials = await resolveCredentials(companyId);
        const stale = [...pendingLogins.entries()].filter(([, entry]) => entry.companyId === companyId);
        for (const [id, entry] of stale) {
          pendingLogins.delete(id);
          await entry.handle.abort().catch(() => undefined);
        }
        const loginId = randomUUID();
        const pending: PendingLogin = {
          companyId,
          loginId,
          signedIn: null,
          sessionSecretId: null,
          persisted: false,
          persistTask: null,
          handle: {
            async submitPassword() {
              throw new Error("Telegram login is still starting.");
            },
            async waitUntilSignedIn() {
              throw new Error("Telegram login is still starting.");
            },
            async abort() {},
          },
          status: reduceLogin(idleLoginStatus(), { type: "start", loginId }),
        };
        pendingLogins.set(loginId, pending);
        emitLogin(companyId, pending.status);
        const handle = await createClient.startQrLogin({
          credentials,
          deviceModel: await deviceModelForCompany(companyId),
          onQr: (qr) => {
            const current = pendingLogins.get(loginId);
            if (!current) return;
            current.status = reduceLogin(current.status, { type: "qr", loginId, qr });
            emitLogin(companyId, current.status);
          },
          onPasswordRequired: (hint, message) => {
            const current = pendingLogins.get(loginId);
            if (!current) return;
            current.status = reduceLogin(current.status, {
              type: "password_required",
              loginId,
              hint,
              message: message ?? null,
            });
            emitLogin(companyId, current.status);
          },
        });
        pending.handle = handle;
        void handle.waitUntilSignedIn()
          .then(async (signedIn) => {
            const current = pendingLogins.get(loginId);
            if (!current) return;
            if (!signedIn.session) throw new Error("Telegram session was empty after login.");
            current.signedIn = signedIn;
            try {
              await persistSignedIn(current);
            } catch (error) {
              if (isInvocationScopeError(error)) {
                log.warn("Telegram sign-in is waiting for a live board request before it can be stored", {
                  companyId,
                });
                return;
              }
              throw error;
            }
          })
          .catch((error: unknown) => {
            const current = pendingLogins.get(loginId);
            if (!current) return;
            const message = error instanceof Error ? error.message : "Telegram login failed.";
            log.error("Telegram login failed", { companyId, message });
            void current.handle.abort().catch(() => undefined);
            current.status = reduceLogin(current.status, {
              type: "error",
              loginId,
              message,
            });
            emitLogin(companyId, current.status);
          });
        return { loginId, status: pending.status };
      });

      ctx.actions.register(ACTION_SUBMIT_PASSWORD, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const loginId = readString(params.loginId);
        const password = typeof params.password === "string" ? params.password : "";
        const pending = pendingLogins.get(loginId);
        if (!pending || pending.companyId !== companyId) {
          throw new Error("No Telegram login is waiting for a password.");
        }
        if (!password) throw new Error("Cloud password is required.");
        await pending.handle.submitPassword(password);
        return { loginId, status: pending.status };
      });

      ctx.actions.register(ACTION_CANCEL_LOGIN, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const loginId = readString(params.loginId);
        const pending = pendingLogins.get(loginId);
        if (!pending || pending.companyId !== companyId) return { status: idleLoginStatus() };
        await pending.handle.abort().catch(() => undefined);
        pendingLogins.delete(loginId);
        const status = reduceLogin(pending.status, { type: "cancel", loginId });
        emitLogin(companyId, status);
        return { status };
      });

      ctx.actions.register(ACTION_UPDATE_CONNECTION, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const telegramUserId = readString(params.telegramUserId);
        const assignedAgentId = params.assignedAgentId === null
          ? null
          : readString(params.assignedAgentId) || undefined;
        const connection = await patchConnection(ctx, companyId, telegramUserId, {
          assignedAgentId: assignedAgentId === undefined ? undefined : assignedAgentId,
        }, liveAccountIds());
        return publicConnection(connection);
      });

      ctx.actions.register(ACTION_SET_PAUSED, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const telegramUserId = readString(params.telegramUserId);
        const paused = Boolean(params.paused);
        const connection = await patchConnection(ctx, companyId, telegramUserId, { paused }, liveAccountIds());
        return publicConnection(connection);
      });

      ctx.actions.register(ACTION_DISCONNECT, async (params, actionCtx) => {
        const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
        const telegramUserId = readString(params.telegramUserId);
        const connection = await findConnection(ctx, companyId, telegramUserId, liveAccountIds());
        if (!connection) return { disconnected: false };
        const live = liveByAccount.get(telegramUserId);
        if (live && live.companyId === companyId) {
          await live.disconnect().catch(() => undefined);
          liveByAccount.delete(telegramUserId);
        }
        if (connection.sessionSecretId) {
          await deleteAccountSession(ctx, companyId, connection.sessionSecretId);
        }
        await upsertConnection(ctx, {
          companyId,
          account: {
            telegramUserId: connection.telegramUserId,
            username: connection.username,
            displayName: connection.displayName,
          },
          sessionSecretId: "",
          assignedAgentId: connection.assignedAgentId,
          paused: true,
        });
        return { disconnected: true };
      });

      ctx.tools.register(
        TOOL_SEND_TEXT,
        {
          displayName: "Send Telegram text",
          description: "Send one plain customer reply to the Telegram chat bound to the current issue. The customer sees only this text. Do not include task ids, task links, task status, or an operator report.",
          parametersSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
              accountId: { type: "string" },
              peerId: { type: "string" },
              issueId: { type: "string" },
            },
            required: ["text"],
          },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const payload = (params ?? {}) as {
            text?: string;
            accountId?: string;
            peerId?: string;
            issueId?: string;
          };
          const connections = await listConnections(ctx, runCtx.companyId, liveAccountIds());
          let issueOriginId: string | null = null;
          if (payload.issueId) {
            const issue = await ctx.issues.get(payload.issueId, runCtx.companyId);
            if (!issue || issue.originKind !== DIALOG_ORIGIN_KIND) {
              return { error: "This issue is not a Telegram dialog." };
            }
            issueOriginId = issue.originId ?? null;
          }
          const authorized = authorizeSendText(connections, {
            companyId: runCtx.companyId,
            agentId: runCtx.agentId,
            accountId: payload.accountId,
            peerId: payload.peerId,
            issueOriginId,
            text: payload.text ?? "",
          });
          if (!authorized.ok) return { error: authorized.error };
          const live = liveByAccount.get(authorized.accountId);
          if (!live || live.companyId !== runCtx.companyId) {
            return { error: "That Telegram account is not live in the plugin worker." };
          }
          const text = payload.text!.trim();
          const refused = refuseOperatorReport(text);
          if (refused) return { error: refused };
          if (payload.issueId) pendingOutbound.set(payload.issueId, outboundTextHash(text));
          try {
            await live.sendText(authorized.peerId, text);
            if (payload.issueId) await rememberOutbound(ctx, payload.issueId, text);
          } finally {
            if (payload.issueId && pendingOutbound.get(payload.issueId) === outboundTextHash(text)) {
              pendingOutbound.delete(payload.issueId);
            }
          }
          return {
            content: "Sent Telegram message.",
            data: {
              accountId: authorized.accountId,
              peerId: authorized.peerId,
            },
          };
        },
      );

      bindDialogFollowup(ctx, log);
      log.info("Telegram plugin setup");
      try {
        await reconnectAll(ctx);
        await syncDialogFollowups(ctx, log);
      } catch (error) {
        try {
          log.error("Telegram session reconnect failed", {
            message: error instanceof Error ? error.message : "unknown error",
          });
        } catch {
          // A host call can be rejected while the settings page is still polling.
        }
      }
    },

    async onHealth(): Promise<PluginHealthDiagnostics> {
      return {
        status: "ok",
        message: "Telegram plugin ready",
        details: {
          liveAccounts: liveByAccount.size,
          pendingLogins: pendingLogins.size,
        },
      };
    },

    async onConfigChanged(_config, context) {
      if (!pluginContext) return;
      if (context?.companyId) await reconnectCompany(pluginContext, context.companyId);
      else await reconnectAll(pluginContext);
    },

    async onIdleDrain() {
      return liveByAccount.size > 0 || pendingLogins.size > 0 ? "present" : "none";
    },

    async onShutdown() {
      for (const pending of pendingLogins.values()) {
        await pending.handle.abort().catch(() => undefined);
      }
      pendingLogins.clear();
      for (const live of liveByAccount.values()) {
        await live.disconnect().catch(() => undefined);
      }
      liveByAccount.clear();
    },
  });

  return plugin;
}

async function credentialsConfigured(ctx: PluginContext, companyId: string): Promise<boolean> {
  try {
    await resolveTelegramAppCredentials(ctx, companyId);
    return true;
  } catch {
    return false;
  }
}

const plugin = createTelegramUserClientPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
