import { randomUUID } from "node:crypto";
import { runOutsidePluginInvocation, type PluginContext } from "@paperclipai/plugin-sdk";
import {
  ACTION_CANCEL_LOGIN,
  ACTION_DISCONNECT,
  ACTION_SET_PAUSED,
  ACTION_START_LOGIN,
  ACTION_SUBMIT_PASSWORD,
  ACTION_UPDATE_CONNECTION,
  DATA_LOGIN_STATUS,
  DIALOG_ORIGIN_KIND,
} from "./constants.js";
import {
  findConnection,
  listConnections,
  patchConnection,
  publicConnection,
  upsertConnection,
} from "./connections.js";
import { chatListLabel, normalizeAllowedPeerIds, parseDialogOriginId } from "./inbound.js";
import { createDialogCache, type CacheScope } from "./dialog-cache.js";
import { HISTORY_PAGE_SIZE, boundLatestHistory, historyCacheKey, historyContentChanged, historyHitIsFresh, patchHistoryMessages, reconcileFetchedHistory, removeHistoryMessages } from "./history-slice.js";
import { createInboxLive } from "./inbox-live.js";
import { bubbleFromStoredBody, type ChatBubble } from "./thread.js";
import { idleLoginStatus, publicLoginStatus, reduceLogin } from "./login.js";
import { reactionEmoji, telegramMessageIds } from "./message-menu.js";
import { authorizeDialogForActor, authorizeOperatorReply, authorizeSendText } from "./send.js";
import { deleteAccountSession } from "./secrets.js";
import { publicChannelTitle, publicPhoto, publicPresence, publicSharedChats, unreadCount, type PeerSummary } from "./peer-card.js";
import { refuseOperatorReport } from "./relay.js";
import type {
  LiveTelegramAccount,
  LoginStatus,
  QrLoginHandle,
  ResolveAppCredentials,
  SignedInSession,
  TelegramClientFactory,
} from "./types.js";

export type PendingLogin = {
  companyId: string;
  loginId: string;
  handle: QrLoginHandle;
  status: LoginStatus;
  signedIn: SignedInSession | null;
  sessionSecretId: string | null;
  sessionConfigPath: string;
  persisted: boolean;
  persistTask: Promise<void> | null;
  cancelled: boolean;
};

export type SettledLogin = {
  companyId: string;
  status: LoginStatus;
};


const INVOCATION_SCOPE_DENIED = -32005;

export type DialogCard = {
  name: string;
  preview: string;
  unread: number;
  photo: string | null;
  presence: ReturnType<typeof publicPresence>;
  activityAt: string;
  previewPlaceholder?: boolean;
};

export function isInvocationScopeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code === INVOCATION_SCOPE_DENIED) return true;
  return error instanceof Error && error.message.includes("Missing or unknown invocation scope");
}

export function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function requireCompanyId(value: unknown, fallback?: string | null): string {
  const companyId = readString(value) || readString(fallback);
  if (!companyId) throw new Error("companyId is required.");
  return companyId;
}

export function assertConnectionManager(actor: { type?: string } | undefined): void {
  if (actor?.type !== "user") {
    throw new Error("Only a board user can change Telegram account access.");
  }
}


export type TelegramBoardSlots = {
  refreshDialogCards: (companyId: string, accountId: string) => void;
  scheduleDialogPersist: (companyId: string, accountId: string) => void;
  scheduleHistoryPersist: (accountId: string, peerId: string) => void;
};

export type TelegramBoardHost = {
  liveByAccount: Map<string, LiveTelegramAccount>;
  pendingLogins: Map<string, PendingLogin>;
  loginResults: Map<string, SettledLogin>;
  peerLabels: Map<string, string>;
  dialogCards: Map<string, { cards: Map<string, DialogCard> }>;
  dialogPhotos: Map<string, string>;
  dialogPhotoIds: Map<string, string>;
  dialogCache: ReturnType<typeof createDialogCache>;
  historyRefresh: Set<string>;
  cardRefresh: Map<string, Promise<void>>;
  slots: TelegramBoardSlots;
  cardJobs: Map<string, Promise<Map<string, DialogCard>>>;
  historyCache: Map<string, { at: number; messages: ChatBubble[] }>;
  historyJobs: Map<string, Promise<ChatBubble[]>>;
  resolveCredentials: ResolveAppCredentials;
  createClient: TelegramClientFactory;
  liveAccountIds: () => Set<string>;
  emitLogin: (companyId: string, status: LoginStatus) => void;
  loginStillCurrent: (pending: PendingLogin) => boolean;
  companyInbox: (companyId: string) => ReturnType<typeof createInboxLive>;
  emitInbox: (companyId: string, event: Record<string, unknown>) => void;
  cardBucket: (companyId: string, accountId: string) => Map<string, DialogCard> | null;
  dialogPhotoKey: (companyId: string, accountId: string, peerId: string) => string;
  keepDialogPhoto: (
    companyId: string,
    accountId: string,
    peerId: string,
    photo: string | null,
    replace: boolean,
    photoId?: string,
  ) => string | null;
  dropHistoryMemory: (accountId: string) => void;
  takePendingBubbles: (accountId: string, peerId: string) => ChatBubble[];
  stripPending: (accountId: string, peerId: string | null, ids: string[]) => void;
  rememberIssueRef: (companyId: string, accountId: string, peerId: string, issueRef: string) => void;
  issueRefFor: (companyId: string, accountId: string, peerId: string, known?: string) => Promise<string>;
  persistSignedIn: (pending: PendingLogin) => Promise<void>;
  flushSignedInAccounts: (companyId: string) => Promise<void>;
  deviceModelForCompany: (companyId: string) => Promise<string>;
  rememberOutbound: (ctx: PluginContext, issueId: string, text: string) => Promise<void>;
  persistDeletedHistory: (companyId: string, accountId: string, peerId: string, messageIds: string[]) => Promise<void>;
};

export function registerTelegramBoard(ctx: PluginContext, log: PluginContext["logger"], host: TelegramBoardHost) {
  const {
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
  } = host;
  async function hydrateDialogCards(companyId: string, accountId: string): Promise<Map<string, DialogCard> | null> {
    const rows = await dialogCache.readDialogs(companyId, accountId);
    if (!rows || rows.length === 0) return null;
    const cards = new Map<string, DialogCard>();
    for (const row of rows) {
      const key = dialogPhotoKey(companyId, accountId, row.id);
      const avatar = await dialogCache.readAvatar(companyId, accountId, row.id);
      if (avatar?.dataUrl) {
        dialogPhotos.set(key, avatar.dataUrl);
        if (avatar.photoId) dialogPhotoIds.set(key, avatar.photoId);
      } else if (row.photoId) {
        dialogPhotoIds.set(key, row.photoId);
      }
      cards.set(row.id, {
        name: row.name,
        preview: row.preview,
        unread: row.unread,
        photo: dialogPhotos.get(key) ?? null,
        presence: row.presence,
        activityAt: row.activityAt,
        previewPlaceholder: row.previewPlaceholder === true,
      });
    }
    return cards;
  }

  async function persistDialogCards(companyId: string, accountId: string, cards: Map<string, DialogCard>): Promise<void> {
    const rows = [...cards.entries()].map(([id, card]) => ({
      id,
      name: card.name,
      preview: card.preview,
      unread: card.unread,
      photoId: dialogPhotoIds.get(dialogPhotoKey(companyId, accountId, id)) ?? "",
      presence: card.presence,
      activityAt: card.activityAt,
      previewPlaceholder: card.previewPlaceholder === true,
    }));
    await dialogCache.writeDialogs(companyId, accountId, rows);
  }

  async function applySummaries(companyId: string, accountId: string, rows: PeerSummary[]): Promise<Map<string, DialogCard>> {
    const key = `${companyId}:${accountId}`;
    const previous = cardBucket(companyId, accountId) ?? new Map<string, DialogCard>();
    if (rows.length === 0 && previous.size > 0) return previous;
    const cards = new Map<string, DialogCard>();
    for (const row of rows) {
      if (!row?.id || !row.name) continue;
      const prior = previous.get(row.id);
      const photoId = typeof row.photoId === "string" ? row.photoId : "";
      const beforePhoto = dialogPhotos.get(dialogPhotoKey(companyId, accountId, row.id)) ?? null;
      const photo = keepDialogPhoto(companyId, accountId, row.id, publicPhoto(row.photo), true, photoId);
      const summaryPreview = typeof row.preview === "string" ? row.preview.slice(0, 80) : "";
      const preview = summaryPreview || prior?.preview || "";
      const samePreview = Boolean(prior) && preview === prior?.preview;
      const next: DialogCard = {
        name: row.name,
        preview,
        previewPlaceholder: samePreview ? prior?.previewPlaceholder === true : false,
        unread: unreadCount(row.unread),
        photo,
        presence: publicPresence(row.presence),
        activityAt: typeof row.activityAt === "string" && row.activityAt ? row.activityAt : prior?.activityAt ?? "",
      };
      cards.set(row.id, next);
      if (!prior) continue;
      const photoChanged = Boolean(photo) && photo !== beforePhoto;
      const textChanged = next.preview !== prior.preview || next.unread !== prior.unread || next.activityAt !== prior.activityAt;
      if (!photoChanged && !textChanged) continue;
      const issueRef = await issueRefFor(companyId, accountId, row.id);
      emitInbox(companyId, {
        companyId,
        kind: "dialog",
        accountId,
        issueRef,
        peerId: row.id,
        preview: next.preview,
        previewPlaceholder: next.previewPlaceholder === true,
        unread: next.unread,
        activityAt: next.activityAt,
        ...(photoChanged ? { photo } : {}),
      });
    }
    if (cards.size === 0) return previous;
    dialogCards.set(key, { cards });
    await persistDialogCards(companyId, accountId, cards).catch(() => undefined);
    return cards;
  }

  function refreshDialogCardsJob(companyId: string, accountId: string): Promise<void> {
    const key = `${companyId}:${accountId}`;
    const pending = cardRefresh.get(key);
    if (pending) return pending;
    const job = (async () => {
      const live = liveByAccount.get(accountId);
      if (!live || live.companyId !== companyId) return;
      try {
        await applySummaries(companyId, accountId, await live.peerSummaries());
      } catch {
        log.warn("Telegram dialog cards are unavailable");
      }
    })().finally(() => {
      if (cardRefresh.get(key) === job) cardRefresh.delete(key);
    });
    cardRefresh.set(key, job);
    return job;
  }

  async function cardsForAccount(companyId: string, accountId: string): Promise<Map<string, DialogCard>> {
    const key = `${companyId}:${accountId}`;
    const stored = cardBucket(companyId, accountId);
    if (stored) return stored;
    const pending = cardJobs.get(key);
    if (pending) return pending;
    const job = (async () => {
      try {
        const hydrated = await hydrateDialogCards(companyId, accountId);
        if (hydrated && hydrated.size > 0) {
          dialogCards.set(key, { cards: hydrated });
          return { cards: hydrated, fromDisk: true };
        }
      } catch {
        log.warn("Telegram dialog cache is unavailable");
      }
      const live = liveByAccount.get(accountId);
      if (!live || live.companyId !== companyId) {
        return { cards: cardBucket(companyId, accountId) ?? new Map<string, DialogCard>(), fromDisk: false };
      }
      try {
        const cards = await applySummaries(companyId, accountId, await live.peerSummaries());
        return { cards, fromDisk: false };
      } catch {
        log.warn("Telegram dialog cards are unavailable");
        return { cards: cardBucket(companyId, accountId) ?? new Map<string, DialogCard>(), fromDisk: false };
      }
    })();
    const mapped = job.then((result) => result.cards);
    cardJobs.set(key, mapped);
    void job.finally(() => {
      if (cardJobs.get(key) === mapped) cardJobs.delete(key);
    });
    const result = await job;
    if (result.fromDisk) void refreshDialogCardsJob(companyId, accountId);
    return result.cards;
  }

  function refreshHistory(companyId: string, accountId: string, peerId: string) {
    const token = `${accountId}:${peerId}`;
    if (historyRefresh.has(token)) return;
    historyRefresh.add(token);
    void (async () => {
      try {
        const live = liveByAccount.get(accountId);
        if (!live || live.companyId !== companyId) return;
        const fetched = await live.readHistory(peerId, HISTORY_PAGE_SIZE);
        const key = historyCacheKey(accountId, peerId, "");
        const previous = historyCache.get(key)?.messages ?? [];
        const queued = takePendingBubbles(accountId, peerId);
        const merged = boundLatestHistory(reconcileFetchedHistory(previous, fetched, queued));
        historyCache.set(key, { at: Date.now(), messages: merged });
        await dialogCache.writeHistory(companyId, accountId, peerId, merged);
        if (historyContentChanged(previous, merged)) {
          const issueRef = await issueRefFor(companyId, accountId, peerId);
          emitInbox(companyId, { companyId, kind: "refresh-thread", accountId, issueRef, peerId });
        }
      } catch {
        log.warn("Telegram history is unavailable");
      } finally {
        historyRefresh.delete(token);
      }
    })();
  }

  async function loadHistory(companyId: string, accountId: string, peerId: string, beforeId: string): Promise<ChatBubble[]> {
    const now = Date.now();
    for (const [cachedKey, entry] of historyCache) {
      const marker = cachedKey.slice(cachedKey.lastIndexOf(":") + 1);
      if (marker === "latest") continue;
      if (!historyHitIsFresh(marker, entry.at, now)) historyCache.delete(cachedKey);
    }
    const live = liveByAccount.get(accountId);
    const key = historyCacheKey(accountId, peerId, beforeId);
    const hit = historyCache.get(key);
    if (hit && historyHitIsFresh(beforeId, hit.at, now)) return beforeId ? hit.messages : boundLatestHistory(hit.messages);
    if (!beforeId) {
      try {
        const disk = await dialogCache.readHistory(companyId, accountId, peerId);
        if (disk && !historyCache.has(key)) {
          const messages = boundLatestHistory(disk.map((message) => ({
            id: message.id,
            direction: message.direction,
            text: message.text,
            at: message.at,
            forward: message.forward,
            placeholder: message.placeholder === true,
          })));
          historyCache.set(key, { at: Date.now(), messages });
          refreshHistory(companyId, accountId, peerId);
          return messages;
        }
      } catch {
        log.warn("Telegram dialog cache is unavailable");
      }
    }
    if (!live || live.companyId !== companyId) return historyCache.get(key)?.messages ?? [];
    const pending = historyJobs.get(key);
    if (pending) return pending;
    const task = live.readHistory(peerId, HISTORY_PAGE_SIZE, beforeId || undefined).then((messages) => {
      const current = historyCache.get(key)?.messages ?? [];
      const queued = beforeId ? [] : takePendingBubbles(accountId, peerId);
      const merged = beforeId
        ? patchHistoryMessages(current, messages)
        : boundLatestHistory(reconcileFetchedHistory(current, messages, queued));
      historyCache.set(key, { at: Date.now(), messages: merged });
      if (!beforeId) void dialogCache.writeHistory(companyId, accountId, peerId, merged).catch(() => undefined);
      return merged;
    }).finally(() => {
      if (historyJobs.get(key) === task) historyJobs.delete(key);
    });
    historyJobs.set(key, task);
    return task;
  }

  slots.refreshDialogCards = (companyId, accountId) => {
    void refreshDialogCardsJob(companyId, accountId);
  };
  const dialogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  slots.scheduleDialogPersist = (companyId, accountId) => {
    const token = `${companyId}:${accountId}`;
    const existing = dialogTimers.get(token);
    if (existing) clearTimeout(existing);
    dialogTimers.set(token, setTimeout(() => {
      dialogTimers.delete(token);
      const cards = cardBucket(companyId, accountId);
      if (!cards || cards.size === 0) return;
      void persistDialogCards(companyId, accountId, cards).catch(() => undefined);
    }, 400));
  };
  const historyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  slots.scheduleHistoryPersist = (accountId, peerId) => {
    const companyId = liveByAccount.get(accountId)?.companyId ?? "";
    if (!companyId) return;
    const token = `${companyId}:${accountId}:${peerId}`;
    const existing = historyTimers.get(token);
    if (existing) clearTimeout(existing);
    historyTimers.set(token, setTimeout(() => {
      historyTimers.delete(token);
      const messages = historyCache.get(historyCacheKey(accountId, peerId, ""))?.messages;
      if (!messages) return;
      void dialogCache.writeHistory(companyId, accountId, peerId, messages).catch(() => undefined);
    }, 500));
  };

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

  const CHAT_PAGE_SIZE = 30;
  const DIALOG_LIST_CAP = 500;

  async function listDialogIssues(companyId: string, needed: number) {
    const cap = Math.min(DIALOG_LIST_CAP, Math.max(1, Math.floor(needed)));
    // The host applies limit in SQL and again when it windows the page.
    // Ask for the prefix in one limit and slice here. Do not pass offset.
    const batch = await ctx.issues.list({
      companyId,
      originKind: DIALOG_ORIGIN_KIND,
      limit: cap,
    });
    return batch.slice(0, cap);
  }

  ctx.data.register("chats", async (params) => {
    const companyId = readString(params.companyId);
    if (!companyId) return { chats: [], nextCursor: null };
    const rawCursor = Number(params.cursor);
    const cursor = Number.isFinite(rawCursor) && rawCursor > 0 ? Math.floor(rawCursor) : 0;
    // The host prefix is not Telegram activity order. Load one capped snapshot,
    // sort it, then slice, so a later page cannot skip a chat that sorts ahead.
    const issues = await listDialogIssues(companyId, DIALOG_LIST_CAP);
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
        previewPlaceholder: card?.previewPlaceholder === true,
        unread: card?.unread || 0,
        photo: parsed
          ? keepDialogPhoto(companyId, parsed.accountId, parsed.peerId, card?.photo ?? null, false)
          : null,
        presence: card?.presence ?? null,
        accountId: parsed?.accountId ?? null,
        peerId: parsed?.peerId ?? null,
      };
    }));
    chats.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const page = chats.slice(cursor, cursor + CHAT_PAGE_SIZE);
    const nextCursor = chats.length > cursor + CHAT_PAGE_SIZE ? String(cursor + CHAT_PAGE_SIZE) : null;
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
      void loadHistory(companyId, parsed.accountId, parsed.peerId, "").catch(() => undefined);
    }
    return { chats: page, nextCursor };
  });

  async function findDialogIssue(companyId: string, issueRef: string) {
    let scanned = 0;
    while (scanned < DIALOG_LIST_CAP) {
      const needed = Math.min(DIALOG_LIST_CAP, scanned + 100);
      const issues = await listDialogIssues(companyId, needed);
      const match = issues.slice(scanned).find((issue) => issue.identifier === issueRef || issue.id === issueRef);
      if (match) return match;
      if (issues.length < needed) break;
      scanned = issues.length;
    }
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
    bubbles.push({ id, direction: "in", text: parsed.text, at, forward: parsed.forward, placeholder: parsed.placeholder });
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

  ctx.data.register("inbox-wait", async (params) => {
    const companyId = readString(params.companyId);
    if (!companyId) return { seq: 0, reset: false, events: [] };
    const sinceRaw = Number(params.since);
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
    return companyInbox(companyId).wait(since, 12_000);
  });

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
      peerId: parsed?.peerId ?? null,
      accountId: parsed?.accountId ?? null,
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
        const messages = await loadHistory(companyId, parsed.accountId, parsed.peerId, beforeId);
        return { ...header, ...face, live: true, hasMore: messages.length >= HISTORY_PAGE_SIZE, messages };
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

  function accountIdsForCompany(companyId: string): string[] {
    const ids = new Set<string>();
    for (const [accountId, live] of liveByAccount) {
      if (live.companyId === companyId) ids.add(accountId);
    }
    const prefix = `${companyId}:`;
    for (const key of dialogCards.keys()) {
      if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
    }
    return [...ids];
  }

  function forgetCompanyCache(companyId: string, scope: CacheScope) {
    const prefix = `${companyId}:`;
    const accounts = accountIdsForCompany(companyId);
    if (scope === "all" || scope === "dialogs") {
      for (const key of [...dialogCards.keys()]) if (key.startsWith(prefix)) dialogCards.delete(key);
      for (const key of [...cardJobs.keys()]) if (key.startsWith(prefix)) cardJobs.delete(key);
      for (const key of [...peerLabels.keys()]) if (key.startsWith(prefix)) peerLabels.delete(key);
      for (const accountId of accounts) dropHistoryMemory(accountId);
    }
    if (scope === "all" || scope === "avatars") {
      for (const key of [...dialogPhotos.keys()]) if (key.startsWith(prefix)) dialogPhotos.delete(key);
      for (const key of [...dialogPhotoIds.keys()]) if (key.startsWith(prefix)) dialogPhotoIds.delete(key);
      for (const [key, bucket] of dialogCards) {
        if (!key.startsWith(prefix)) continue;
        for (const card of bucket.cards.values()) card.photo = null;
      }
    }
  }

  ctx.data.register("cache-status", async (params) => {
    const companyId = readString(params.companyId);
    const empty = { enabled: true, bytes: 0, dialogs: 0, avatars: 0, maxBytes: 64 * 1024 * 1024, updatedAt: null };
    if (!companyId) return empty;
    try {
      return await dialogCache.status(companyId);
    } catch {
      log.warn("Telegram dialog cache is unavailable");
      return empty;
    }
  });

  ctx.actions.register("cache-save", async (params, actionCtx) => {
    assertConnectionManager(actionCtx.actor);
    const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
    const patch: { enabled?: boolean; maxBytes?: number } = {};
    if (typeof params.enabled === "boolean") patch.enabled = params.enabled;
    if (typeof params.maxBytes === "number") patch.maxBytes = params.maxBytes;
    return dialogCache.saveSettings(companyId, patch);
  });

  ctx.actions.register("cache-clear", async (params, actionCtx) => {
    assertConnectionManager(actionCtx.actor);
    const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
    const scope = params.scope === "avatars" || params.scope === "dialogs" || params.scope === "all" ? params.scope : "";
    if (!scope) throw new Error("Unknown cache scope.");
    const accounts = accountIdsForCompany(companyId);
    await dialogCache.clear(companyId, scope);
    forgetCompanyCache(companyId, scope);
    if (scope === "avatars") {
      for (const accountId of accounts) slots.refreshDialogCards(companyId, accountId);
    }
    emitInbox(companyId, { companyId, kind: "gap" });
    return dialogCache.status(companyId);
  });

  ctx.actions.register("send-chat-reply", async (params, actionCtx) => {
    const board = actionCtx.actor?.type === "user";
    const agentId = actionCtx.actor?.type === "agent" ? readString(actionCtx.actor.agentId) : "";
    if (!board && !agentId) assertConnectionManager(actionCtx.actor);
    const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
    const issueRef = readString(params.issueRef);
    const text = readString(params.text);
    const refused = refuseOperatorReport(text);
    if (refused) throw new Error(refused);
    const issue = await findDialogIssue(companyId, issueRef);
    if (!issue) throw new Error("This issue is not a Telegram dialog.");
    const connections = await listConnections(ctx, companyId, liveAccountIds());
    const authorized = board
      ? authorizeOperatorReply(connections, {
        companyId,
        issueOriginId: issue.originId,
        text,
      })
      : authorizeSendText(connections, {
        companyId,
        agentId,
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
    const op = readString(params.op);
    if (op !== "react" && op !== "pin" && op !== "unpin" && op !== "delete" && op !== "forward") {
      throw new Error("Unknown message action.");
    }
    const board = actionCtx.actor?.type === "user";
    const agentId = actionCtx.actor?.type === "agent" ? readString(actionCtx.actor.agentId) : "";
    if (!board && (op === "react" || op === "pin" || op === "unpin" || !agentId)) {
      assertConnectionManager(actionCtx.actor);
    }
    const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
    const issueRef = readString(params.issueRef);
    const issue = await findDialogIssue(companyId, issueRef);
    if (!issue) throw new Error("This issue is not a Telegram dialog.");
    const connections = await listConnections(ctx, companyId, liveAccountIds());
    const authorized = authorizeDialogForActor(connections, {
      companyId,
      board,
      agentId,
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
        if (!key.startsWith(prefix) || key.endsWith(":latest")) continue;
        const messages = removeHistoryMessages(entry.messages, ids);
        historyCache.set(key, { at: entry.at, messages });
      }
      await persistDeletedHistory(companyId, authorized.accountId, authorized.peerId, ids);
      stripPending(authorized.accountId, authorized.peerId, ids);
    } else {
      const target = await findDialogIssue(companyId, readString(params.targetIssueRef));
      if (!target) throw new Error("This issue is not a Telegram dialog.");
      const targetAuth = authorizeDialogForActor(connections, {
        companyId,
        board,
        agentId,
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
      const settled = loginResults.get(loginId);
      if (settled && settled.companyId === companyId) return settled.status;
      return idleLoginStatus();
    }
    const pending = [...pendingLogins.values()].find((entry) => entry.companyId === companyId);
    if (pending) return publicLoginStatus(pending.status);
    const settled = [...loginResults.values()].reverse().find((entry) => entry.companyId === companyId);
    return publicLoginStatus(settled?.status ?? idleLoginStatus());
  });

  ctx.actions.register(ACTION_START_LOGIN, async (params, actionCtx) => {
    assertConnectionManager(actionCtx.actor);
    const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
    const credentials = await resolveCredentials(companyId);
    const stale = [...pendingLogins.entries()].filter(([, entry]) => entry.companyId === companyId);
    for (const [id, entry] of stale) {
      entry.cancelled = true;
      pendingLogins.delete(id);
      await entry.handle.abort().catch(() => undefined);
    }
    const loginId = randomUUID();
    const pending: PendingLogin = {
      companyId,
      loginId,
      signedIn: null,
      sessionSecretId: null,
      sessionConfigPath: "",
      persisted: false,
      persistTask: null,
      cancelled: false,
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
    const deviceModel = await deviceModelForCompany(companyId);
    await runOutsidePluginInvocation(async () => {
      const handle = await createClient.startQrLogin({
        credentials,
        deviceModel,
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
          if (!loginStillCurrent(pending)) return;
          const current = pending;
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
          if (!loginStillCurrent(pending)) return;
          const current = pending;
          const message = error instanceof Error ? error.message : "Telegram login failed.";
          log.error("Telegram login failed", { companyId, message });
          void current.handle.abort().catch(() => undefined);
          current.status = reduceLogin(current.status, {
            type: "error",
            loginId,
            message,
          });
          loginResults.set(loginId, { companyId, status: current.status });
          if (pendingLogins.get(loginId) === current) pendingLogins.delete(loginId);
          emitLogin(companyId, current.status);
        });
    });
    return { loginId, status: pending.status };
  });

  ctx.actions.register(ACTION_SUBMIT_PASSWORD, async (params, actionCtx) => {
    assertConnectionManager(actionCtx.actor);
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
    assertConnectionManager(actionCtx.actor);
    const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
    const loginId = readString(params.loginId);
    const pending = pendingLogins.get(loginId);
    if (!pending || pending.companyId !== companyId) return { status: idleLoginStatus() };
    pending.cancelled = true;
    await pending.handle.abort().catch(() => undefined);
    pendingLogins.delete(loginId);
    const status = reduceLogin(pending.status, { type: "cancel", loginId });
    loginResults.set(loginId, { companyId, status });
    emitLogin(companyId, status);
    return { status };
  });

  ctx.actions.register(ACTION_UPDATE_CONNECTION, async (params, actionCtx) => {
    assertConnectionManager(actionCtx.actor);
    const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
    const telegramUserId = readString(params.telegramUserId);
    const assignedAgentId = params.assignedAgentId === null
      ? null
      : readString(params.assignedAgentId) || undefined;
    const acceptUnlistedSenders = typeof params.acceptUnlistedSenders === "boolean"
      ? params.acceptUnlistedSenders
      : undefined;
    const allowedPeerIds = Array.isArray(params.allowedPeerIds)
      ? normalizeAllowedPeerIds(params.allowedPeerIds)
      : undefined;
    const connection = await patchConnection(ctx, companyId, telegramUserId, {
      assignedAgentId: assignedAgentId === undefined ? undefined : assignedAgentId,
      acceptUnlistedSenders,
      allowedPeerIds,
    }, liveAccountIds());
    return publicConnection(connection);
  });

  ctx.actions.register(ACTION_SET_PAUSED, async (params, actionCtx) => {
    assertConnectionManager(actionCtx.actor);
    const companyId = requireCompanyId(params.companyId, actionCtx.companyId);
    const telegramUserId = readString(params.telegramUserId);
    const paused = Boolean(params.paused);
    const connection = await patchConnection(ctx, companyId, telegramUserId, { paused }, liveAccountIds());
    return publicConnection(connection);
  });

  ctx.actions.register(ACTION_DISCONNECT, async (params, actionCtx) => {
    assertConnectionManager(actionCtx.actor);
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
      sessionConfigPath: "",
      assignedAgentId: connection.assignedAgentId,
      paused: true,
    });
    return { disconnected: true };
  });

  return { cardsForAccount };
}
