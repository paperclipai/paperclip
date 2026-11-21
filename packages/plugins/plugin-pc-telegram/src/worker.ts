import {
  definePlugin,
  runOutsidePluginInvocation,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import {
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
  publicConnection,
  upsertConnection,
} from "./connections.js";
import { dialogOriginId, inboundMediaAllowed, ingestInboundMessage, parseDialogOriginId, reopenDialogForInbound } from "./inbound.js";
import { createDialogCache, preferCachedPhoto } from "./dialog-cache.js";
import { boundLatestHistory, historyCacheKey, historyHitIsFresh, patchHistoryMessages, removeHistoryMessages } from "./history-slice.js";
import { createInboxLive } from "./inbox-live.js";
import { publicForward } from "./forward.js";
import type { ChatBubble } from "./thread.js";
import {
  decideDialogFollowup,
  outboundTextHash,
  readStoredOutbound,
  refuseOperatorReport,
  TELEGRAM_OUTBOUND_NAMESPACE,
  TELEGRAM_OUTBOUND_STATE_KEY,
} from "./relay.js";
import { publicLoginStatus, reduceLogin } from "./login.js";
import { redactValue } from "./redaction.js";
import { authorizeSendText } from "./send.js";
import {
  deleteAccountSession,
  getAccountSession,
  putAccountSession,
  resolveTelegramAppCredentials,
} from "./secrets.js";
import { publicPhoto } from "./peer-card.js";
import { createGramJsClientFactory, telegramSessionDeviceModel } from "./telegram-gramjs.js";
import type {
  InboxPeerUpdate,
  LiveTelegramAccount,
  LoginStatus,
  ResolveAppCredentials,
  TelegramClientFactory,
} from "./types.js";
import {
  isInvocationScopeError,
  readString,
  registerTelegramBoard,
  requireCompanyId,
  type DialogCard,
  type PendingLogin,
  type SettledLogin,
} from "./worker-board.js";

const INBOX_STREAM = "telegram-inbox";

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

export type TelegramPluginDeps = {
  createClient?: TelegramClientFactory;
  resolveAppCredentials?: ResolveAppCredentials;
};

export function createTelegramUserClientPlugin(deps: TelegramPluginDeps = {}) {
  const createClient = deps.createClient ?? createGramJsClientFactory();
  const liveByAccount = new Map<string, LiveTelegramAccount>();
  const pendingLogins = new Map<string, PendingLogin>();
  const loginResults = new Map<string, SettledLogin>();
  let shuttingDown = false;
  const peerLabels = new Map<string, string>();
  const dialogCards = new Map<string, { cards: Map<string, DialogCard> }>();
  const dialogPhotos = new Map<string, string>();
  const dialogPhotoIds = new Map<string, string>();
  const dialogCache = createDialogCache();
  const historyRefresh = new Set<string>();
  const cardRefresh = new Map<string, Promise<void>>();
  const slots = {
    refreshDialogCards(_companyId: string, _accountId: string) {},
    scheduleDialogPersist(_companyId: string, _accountId: string) {},
    scheduleHistoryPersist(_accountId: string, _peerId: string) {},
  };
  const cardJobs = new Map<string, Promise<Map<string, DialogCard>>>();
  const historyCache = new Map<string, { at: number; messages: ChatBubble[] }>();
  const historyJobs = new Map<string, Promise<ChatBubble[]>>();
  const pendingLatest = new Map<string, ChatBubble[]>();
  const issueRefs = new Map<string, string>();
  const inboxLive = new Map<string, ReturnType<typeof createInboxLive>>();
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
    const channel = `${LOGIN_STREAM_CHANNEL}:${companyId}`;
    ctx.streams.open(channel, companyId);
    ctx.streams.emit(channel, { companyId, status: publicLoginStatus(status) });
    if ("loginId" in status && status.loginId) {
      const privateChannel = `${channel}:${status.loginId}`;
      ctx.streams.open(privateChannel, companyId);
      ctx.streams.emit(privateChannel, { companyId, status });
    }
  }

  function loginStillCurrent(pending: PendingLogin): boolean {
    return !shuttingDown && !pending.cancelled && pendingLogins.get(pending.loginId) === pending;
  }

  function companyInbox(companyId: string) {
    const current = inboxLive.get(companyId);
    if (current) return current;
    const created = createInboxLive();
    inboxLive.set(companyId, created);
    return created;
  }

  function emitInbox(companyId: string, event: Record<string, unknown>) {
    companyInbox(companyId).push(event);
    const ctx = pluginContext;
    if (!ctx) return;
    try {
      ctx.streams.open(INBOX_STREAM, companyId);
      ctx.streams.emit(INBOX_STREAM, event);
    } catch {
      // The parked inbox-wait read delivers the same event when the host drops the push.
    }
  }

  function cardBucket(companyId: string, accountId: string): Map<string, DialogCard> | null {
    return dialogCards.get(`${companyId}:${accountId}`)?.cards ?? null;
  }

  function dialogPhotoKey(companyId: string, accountId: string, peerId: string): string {
    return `${companyId}:${accountId}:${peerId}`;
  }

  function keepDialogPhoto(
    companyId: string,
    accountId: string,
    peerId: string,
    photo: string | null,
    replace: boolean,
    photoId = "",
  ): string | null {
    const key = dialogPhotoKey(companyId, accountId, peerId);
    const current = dialogPhotos.get(key) ?? null;
    if (!replace && current) return current;
    const currentId = dialogPhotoIds.get(key) ?? "";
    const chosen = preferCachedPhoto(current, publicPhoto(photo), currentId, photoId);
    if (!chosen) return null;
    const nextId = photoId || currentId;
    if (chosen !== current) {
      dialogPhotos.set(key, chosen);
      if (nextId) dialogPhotoIds.set(key, nextId);
      void dialogCache.writeAvatar(companyId, accountId, peerId, { photoId: nextId, dataUrl: chosen }).catch(() => undefined);
    } else if (photoId && photoId !== currentId) {
      dialogPhotoIds.set(key, photoId);
      void dialogCache.writeAvatar(companyId, accountId, peerId, { photoId, dataUrl: chosen }).catch(() => undefined);
    }
    return chosen;
  }

  function dropHistoryMemory(accountId: string) {
    const prefix = `${accountId}:`;
    for (const key of historyCache.keys()) {
      if (key.startsWith(prefix)) historyCache.delete(key);
    }
    for (const key of historyJobs.keys()) {
      if (key.startsWith(prefix)) historyJobs.delete(key);
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

  function evictStaleHistoryPages(now = Date.now()) {
    for (const [key, entry] of historyCache) {
      const marker = key.slice(key.lastIndexOf(":") + 1);
      if (marker === "latest") continue;
      if (!historyHitIsFresh(marker, entry.at, now)) historyCache.delete(key);
    }
  }

  function patchPeerHistory(accountId: string, peerId: string, bubble: ChatBubble, inserted: boolean): boolean {
    evictStaleHistoryPages();
    const prefix = `${accountId}:${peerId}:`;
    let seen = false;
    let hasLatest = false;
    for (const [key, entry] of historyCache) {
      if (!key.startsWith(prefix)) continue;
      if (key.endsWith(":latest")) hasLatest = true;
      const has = entry.messages.some((message) => message.id === bubble.id);
      if (!has && !key.endsWith(":latest")) continue;
      if (has) seen = true;
      const patched = patchHistoryMessages(entry.messages, [bubble]);
      historyCache.set(key, {
        at: key.endsWith(":latest") ? entry.at : Date.now(),
        messages: key.endsWith(":latest") ? boundLatestHistory(patched) : patched,
      });
      if (key.endsWith(":latest")) slots.scheduleHistoryPersist(accountId, peerId);
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
      if (preview) {
        card.preview = preview;
        card.previewPlaceholder = update.bubble.placeholder === true;
      }
      card.activityAt = at;
    }
    if (update.inserted && !already && update.bubble.direction === "in") card.unread += 1;
    if (update.inserted && !already && update.bubble.direction === "out") card.unread = 0;
    slots.scheduleDialogPersist(update.companyId, update.accountId);
    return card;
  }

  function applyInboxUpdate(update: InboxPeerUpdate, knownRef = "") {
    if (update.type === "gap") {
      dropHistoryMemory(update.accountId);
      slots.refreshDialogCards(update.companyId, update.accountId);
      emitInbox(update.companyId, { companyId: update.companyId, kind: "gap" });
      return;
    }
    if (update.type === "photo") {
      const before = dialogPhotos.get(dialogPhotoKey(update.companyId, update.accountId, update.peerId)) ?? null;
      const photo = keepDialogPhoto(update.companyId, update.accountId, update.peerId, update.photo, true, update.photoId ?? "");
      if (!photo || photo === before) return;
      const card = cardBucket(update.companyId, update.accountId)?.get(update.peerId);
      if (card) card.photo = photo;
      void issueRefFor(update.companyId, update.accountId, update.peerId, knownRef).then((issueRef) => {
        emitInbox(update.companyId, {
          companyId: update.companyId,
          kind: "dialog",
          accountId: update.accountId,
          issueRef,
          peerId: update.peerId,
          photo,
          preview: card?.preview ?? "",
          previewPlaceholder: card?.previewPlaceholder === true,
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
        void persistDeletedHistory(update.companyId, update.accountId, peerId, update.messageIds).catch(() => undefined);
        void issueRefFor(update.companyId, update.accountId, peerId, knownRef).then((issueRef) => {
          emitInbox(update.companyId, {
            companyId: update.companyId,
            kind: "delete",
            accountId: update.accountId,
            issueRef,
            peerId,
            messageIds: update.messageIds,
          });
        });
      }
      return;
    }
    const already = patchPeerHistory(update.accountId, update.peerId, update.bubble, update.inserted);
    const card = touchDialogCard(update, already);
    void issueRefFor(update.companyId, update.accountId, update.peerId, knownRef).then((issueRef) => {
      emitInbox(update.companyId, {
        companyId: update.companyId,
        kind: "message",
        accountId: update.accountId,
        issueRef,
        peerId: update.peerId,
        bubble: update.bubble,
        preview: card?.preview ?? update.bubble.text.replace(/\s+/g, " ").trim().slice(0, 80),
        previewPlaceholder: card?.previewPlaceholder === true,
        unread: card?.unread ?? 0,
        activityAt: card?.activityAt || update.bubble.at,
      });
    });
  }

  async function allowLiveInboundMedia(companyId: string, accountId: string, peerId: string, declaredBytes: number): Promise<boolean> {
    const ctx = pluginContext;
    if (!ctx) return false;
    const connection = await findConnection(ctx, companyId, accountId, liveAccountIds());
    if (!connection) return false;
    return inboundMediaAllowed(ctx, connection, peerId, declaredBytes);
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
      if (!loginStillCurrent(pending)) return;
      const stored = pending.sessionSecretId && pending.sessionConfigPath
        ? { secretId: pending.sessionSecretId, configPath: pending.sessionConfigPath }
        : await putAccountSession(ctx, pending.companyId, signedIn.session);
      if (!loginStillCurrent(pending)) {
        await deleteAccountSession(ctx, pending.companyId, stored.secretId);
        return;
      }
      pending.sessionSecretId = stored.secretId;
      pending.sessionConfigPath = stored.configPath;
      await upsertConnection(ctx, {
        companyId: pending.companyId,
        account: signedIn.account,
        sessionSecretId: stored.secretId,
        sessionConfigPath: stored.configPath,
      });
      if (!loginStillCurrent(pending)) {
        await deleteAccountSession(ctx, pending.companyId, stored.secretId);
        return;
      }
      pending.persisted = true;
      pending.status = reduceLogin(pending.status, {
        type: "connected",
        loginId: pending.loginId,
        account: signedIn.account,
      });
      loginResults.set(pending.loginId, { companyId: pending.companyId, status: pending.status });
      try {
        emitLogin(pending.companyId, pending.status);
      } catch {
        // The login action has already finished, so its invocation can no longer emit.
        // The next status or overview read still returns the stored account.
      }
      try {
        const credentials = await resolveCredentials(pending.companyId);
        const deviceModel = await deviceModelForCompany(pending.companyId);
        const live = await runOutsidePluginInvocation(() => createClient.connectFromSession({
          companyId: pending.companyId,
          credentials,
          session: signedIn.session,
          deviceModel,
          onInbound: handleInbound,
          onInboxUpdate: (update) => applyInboxUpdate(update),
          allowInboundMedia: ({ accountId, peerId, declaredBytes }) => allowLiveInboundMedia(pending.companyId, accountId, peerId, declaredBytes),
        }));
        if (!loginStillCurrent(pending)) {
          await live.disconnect().catch(() => undefined);
          await deleteAccountSession(ctx, pending.companyId, stored.secretId);
          return;
        }
        await attachLiveSession(pending.companyId, live);
        emitInbox(pending.companyId, { companyId: pending.companyId, kind: "accounts" });
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
      if (pendingLogins.get(pending.loginId) === pending) pendingLogins.delete(pending.loginId);
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

  async function persistDeletedHistory(companyId: string, accountId: string, peerId: string, messageIds: string[]) {
    const key = historyCacheKey(accountId, peerId, "");
    let messages = historyCache.get(key)?.messages;
    if (!messages) {
      const disk = await dialogCache.readHistory(companyId, accountId, peerId);
      messages = (disk ?? []).map((message) => ({
        id: message.id,
        direction: message.direction,
        text: message.text,
        at: message.at,
        forward: message.forward,
        placeholder: message.placeholder === true,
      }));
    }
    const next = boundLatestHistory(removeHistoryMessages(messages, messageIds));
    historyCache.set(key, { at: historyCache.get(key)?.at ?? Date.now(), messages: next });
    await dialogCache.writeHistory(companyId, accountId, peerId, next);
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
      const session = await getAccountSession(
        ctx,
        companyId,
        connection.sessionSecretId,
        connection.sessionConfigPath || `plugin-secret.${connection.sessionSecretId}`,
      );
      if (!session) continue;
      try {
        const credentials = await resolveCredentials(companyId);
        const deviceModel = await deviceModelForCompany(companyId);
        const live = await runOutsidePluginInvocation(() => createClient.connectFromSession({
          companyId,
          credentials,
          session,
          deviceModel,
          onInbound: handleInbound,
          onInboxUpdate: (update) => applyInboxUpdate(update),
          allowInboundMedia: ({ accountId, peerId, declaredBytes }) => allowLiveInboundMedia(companyId, accountId, peerId, declaredBytes),
        }));
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

      const board = registerTelegramBoard(ctx, log, {
        liveByAccount,
        pendingLogins,
        loginResults,
        peerLabels,
        dialogCards,
        dialogPhotos,
        dialogPhotoIds,
        dialogCache,
        historyRefresh,
        cardRefresh,
        slots,
        cardJobs,
        historyCache,
        historyJobs,
        resolveCredentials,
        createClient,
        liveAccountIds,
        emitLogin,
        loginStillCurrent,
        companyInbox,
        emitInbox,
        cardBucket,
        dialogPhotoKey,
        keepDialogPhoto,
        dropHistoryMemory,
        takePendingBubbles,
        stripPending,
        rememberIssueRef,
        issueRefFor,
        persistSignedIn,
        flushSignedInAccounts,
        deviceModelForCompany,
        rememberOutbound,
        persistDeletedHistory,
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
            required: ["text", "issueId"],
          },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const payload = (params ?? {}) as {
            text?: string;
            accountId?: string;
            peerId?: string;
            issueId?: string;
          };
          if (!payload.issueId) return { error: "A Telegram task is required." };
          const connections = await listConnections(ctx, runCtx.companyId, liveAccountIds());
          const issue = await ctx.issues.get(payload.issueId, runCtx.companyId);
          if (!issue || issue.originKind !== DIALOG_ORIGIN_KIND || !issue.originId) {
            return { error: "This issue is not a Telegram dialog." };
          }
          const authorized = authorizeSendText(connections, {
            companyId: runCtx.companyId,
            agentId: runCtx.agentId,
            accountId: payload.accountId,
            peerId: payload.peerId,
            issueOriginId: issue.originId,
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
      void reconnectAll(ctx)
        .then(async () => {
          await syncDialogFollowups(ctx, log);
          for (const live of liveByAccount.values()) {
            void board.cardsForAccount(live.companyId, live.account.telegramUserId).catch(() => undefined);
          }
        })
        .catch((error: unknown) => {
          try {
            log.error("Telegram session reconnect failed", {
              message: error instanceof Error ? error.message : "unknown error",
            });
          } catch {
            // A host call can be rejected while the settings page is still polling.
          }
        });
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
      shuttingDown = true;
      for (const pending of pendingLogins.values()) {
        pending.cancelled = true;
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
