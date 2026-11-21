import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
} from "@paperclipai/plugin-sdk/ui";
import { isTelegramMessageId, menuPosition } from "../message-menu.js";
import {
  feedIsCompact,
  filterChats,
  formatClock,
  formatListTime,
  groupThread,
  keepShownPhoto,
  isNearBottom,
  issueRefFromPath,
  mergeThreadMessages,
  oldestNumericId,
  parseTime,
  sameThreadTop,
  shellIsNarrow,
  shiftFeedRange,
  slideFeedRange,
  tailFeedRange,
  unreadLabel,
  type FeedRange,
} from "./inbox-model.js";
import { errorMessage, isRuLocale, uiText } from "./locale.js";
import { TG_CSS } from "./inbox-styles.js";
import {
  INBOX_ABORT_MS,
  absorbStreamAhead,
  mergeLoadedChats,
  profileEventMatches,
  bubbleNode,
  captureFeedAnchor,
  queueStreamBubble,
  storeThread,
  streamAhead,
  threadCache,
  type ChatProfileData,
  type ChatThreadData,
  type InboxStreamEvent,
  type RowPatch,
  type TelegramChatRow,
  type ThreadView,
} from "./inbox-thread.js";
import {
  Avatar,
  BackIcon,
  SearchIcon,
  SendIcon,
  forwardLine,
  hideHostBack,
  presenceText,
  resizeComposer,
  safePhoto,
  useObservedWidth,
} from "./inbox-widgets.js";
import { InboxMenu, InboxProfile, type MessageMenuState } from "./inbox-overlays.js";

export function TelegramInboxPage({
  context,
}: {
  context?: { companyId?: string | null; companyPrefix?: string | null } | null;
}) {
  const companyId = context?.companyId ?? "";
  const prefix = context?.companyPrefix ?? "";
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const issueRef = issueRefFromPath(prefix, location.pathname);
  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  const [feed, setFeed] = useState<HTMLDivElement | null>(null);
  const shellWidth = useObservedWidth(shell);
  const feedWidth = useObservedWidth(feed);
  const narrow = shellIsNarrow(shellWidth);
  const [listCursor, setListCursor] = useState("");
  const [listCompany, setListCompany] = useState(companyId);
  const [loadedChats, setLoadedChats] = useState<TelegramChatRow[]>([]);
  const [nextChatCursor, setNextChatCursor] = useState<string | null>(null);
  if (listCompany !== companyId) {
    setListCompany(companyId);
    setListCursor("");
    setLoadedChats([]);
    setNextChatCursor(null);
  }
  const chats = usePluginData<{ chats?: TelegramChatRow[]; nextCursor?: string | null }>(
    "chats",
    companyId ? { companyId } : undefined,
  );
  const olderChats = usePluginData<{ chats?: TelegramChatRow[]; nextCursor?: string | null }>(
    "chats",
    companyId && listCursor ? { companyId, cursor: listCursor } : undefined,
  );
  const thread = usePluginData<ChatThreadData>(
    "chat-thread",
    companyId && issueRef ? { companyId, issueRef } : undefined,
  );
  const cacheKey = companyId && issueRef ? `${companyId}:${issueRef}` : "";
  const openCacheKey = useRef(cacheKey);
  openCacheKey.current = cacheKey;
  const [transcript, setTranscript] = useState<ThreadView | null>(() => (cacheKey ? threadCache.get(cacheKey) ?? null : null));
  const [readyKey, setReadyKey] = useState("");
  const [olderBefore, setOlderBefore] = useState<string | null>(null);
  const [olderFault, setOlderFault] = useState<string | null>(null);
  const failedOlder = useRef<string | null>(null);
  const older = usePluginData<ChatThreadData>(
    "chat-thread",
    companyId && issueRef ? { companyId, issueRef, beforeId: olderBefore ?? "0" } : undefined,
  );
  const [profileRef, setProfileRef] = useState<string | null>(null);
  const profile = usePluginData<ChatProfileData>(
    "chat-profile",
    companyId && profileRef ? { companyId, issueRef: profileRef } : undefined,
  );
  const sendReply = usePluginAction("send-chat-reply");
  const menuAction = usePluginAction("chat-message-menu");
  const refreshThread = useRef(thread.refresh);
  const refreshChats = useRef(chats.refresh);
  const refreshProfile = useRef(profile.refresh);
  const openProfile = useRef({ issueRef: "", accountId: "", peerId: "" });
  refreshThread.current = thread.refresh;
  refreshChats.current = chats.refresh;
  refreshProfile.current = profile.refresh;
  const draftsRef = useRef<Record<string, string>>({});
  const issueRefLive = useRef(issueRef);
  const previousIssueRef = useRef(issueRef);
  issueRefLive.current = issueRef;
  const [draft, setDraftValue] = useState("");
  const draftLive = useRef(draft);
  draftLive.current = draft;
  function setDraft(value: string) {
    if (issueRef) draftsRef.current[issueRef] = value;
    setDraftValue(value);
  }
  const [query, setQuery] = useState("");
  const [rowPatches, setRowPatches] = useState<Record<string, RowPatch>>({});
  const shownListPhotos = useRef<Record<string, string>>({});
  const [feedRange, setFeedRange] = useState<FeedRange | null>(null);
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MessageMenuState | null>(null);
  const [reply, setReply] = useState<{ id: string; text: string } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [reactions, setReactions] = useState<Record<string, string>>({});
  const [pinned, setPinned] = useState<string[]>([]);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef(transcript);
  const olderBeforeRef = useRef(olderBefore);
  const sawLoading = useRef(false);
  const olderSeen = useRef("");
  const stickRef = useRef(true);
  const holdScroll = useRef<{ height: number; top: number } | null>(null);
  const pendingAnchor = useRef<{ id: string; offset: number } | null>(null);
  const feedNode = useRef<HTMLDivElement | null>(null);
  const feedRangeRef = useRef(feedRange);
  const requestOlderRef = useRef(() => {});
  const hiddenIds = useRef(new Set<string>());
  const openPeer = useRef("");
  const openAccount = useRef("");
  const belowRef = useRef(0);
  const [below, setBelow] = useState(0);
  belowRef.current = below;
  transcriptRef.current = transcript;
  olderBeforeRef.current = olderBefore;
  feedNode.current = feed;
  feedRangeRef.current = feedRange;
  requestOlderRef.current = () => {
    const view = transcriptRef.current;
    const element = feedNode.current;
    if (!view || !view.hasMore || view.exhausted || olderBeforeRef.current || !element) return;
    if (feedRangeRef.current && feedRangeRef.current.start > 0) return;
    const id = oldestNumericId(view.messages);
    if (!id) return;
    if (feedRangeRef.current) {
      pendingAnchor.current = captureFeedAnchor(element);
      holdScroll.current = null;
    } else {
      holdScroll.current = { height: element.scrollHeight, top: element.scrollTop };
    }
    olderBeforeRef.current = id;
    setOlderBefore(id);
  };
  const messages = (transcript?.messages ?? []).filter((item) => !hiddenIds.current.has(item.id));
  const visibleMessages = feedRange ? messages.slice(feedRange.start, feedRange.end) : messages;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const ru = isRuLocale();
  const now = new Date();
  const applyInboxRef = useRef<(event: InboxStreamEvent) => void>(() => {});
  applyInboxRef.current = (event) => {
    if (event.companyId && companyId && event.companyId !== companyId) return;
    const sameOpenChat = Boolean(
      event.accountId
      && openAccount.current
      && event.accountId === openAccount.current
      && event.peerId
      && event.peerId === openPeer.current,
    );
    if (event.kind === "gap") {
      refreshThread.current();
      refreshChats.current();
      return;
    }
    if (event.kind === "refresh-thread") {
      const refreshRef = event.issueRef ?? "";
      if (refreshRef) {
        if (refreshRef === issueRefLive.current) refreshThread.current();
      } else if (sameOpenChat) {
        refreshThread.current();
      }
      return;
    }
    const ref = event.issueRef ?? "";
    const forOpen = !ref && sameOpenChat;
    const knownChats = loadedChats.length > 0 ? loadedChats : (chats.data?.chats ?? []);
    if (ref && !knownChats.some((chat) => (chat.identifier || chat.issueId) === ref)) {
      refreshChats.current();
    }
    if (profileEventMatches(event, openProfile.current)) refreshProfile.current();
    if (ref && (event.preview != null || event.activityAt || event.photo !== undefined || typeof event.unread === "number")) {
      setRowPatches((current) => ({
        ...current,
        [ref]: {
          ...current[ref],
          preview: event.preview ?? current[ref]?.preview,
          previewPlaceholder: typeof event.previewPlaceholder === "boolean"
            ? event.previewPlaceholder
            : current[ref]?.previewPlaceholder,
          unread: typeof event.unread === "number" ? event.unread : current[ref]?.unread,
          updatedAt: event.activityAt || current[ref]?.updatedAt,
          photo: event.photo === undefined ? current[ref]?.photo : keepShownPhoto(current[ref]?.photo, event.photo),
        },
      }));
    }
    const key = ref && companyId ? `${companyId}:${ref}` : forOpen ? cacheKey : "";
    if (!key) return;
    if (event.kind === "delete" && event.messageIds?.length) {
      const drop = new Set(event.messageIds);
      if (key === openCacheKey.current) {
        for (const id of event.messageIds) hiddenIds.current.add(id);
      }
      const base = threadCache.get(key);
      if (!base) return;
      const next = { ...base, messages: base.messages.filter((item) => !drop.has(item.id)) };
      storeThread(key, next);
      if (key === cacheKey) setTranscript(next);
      return;
    }
    if (event.kind === "message" && event.bubble) {
      const base = threadCache.get(key);
      if (!base) {
        queueStreamBubble(key, event.bubble);
        return;
      }
      const fresh = !base.messages.some((item) => item.id === event.bubble?.id);
      const merged = absorbStreamAhead(key, mergeThreadMessages(base.messages, [event.bubble]));
      const next = {
        ...base,
        messages: key === openCacheKey.current ? merged.filter((item) => !hiddenIds.current.has(item.id)) : merged,
      };
      storeThread(key, next);
      if (key === cacheKey) {
        setTranscript(next);
        if (stickRef.current) {
          setFeedRange(tailFeedRange(next.messages.length));
          setBelow(0);
        } else if (fresh) {
          setBelow((count) => count + 1);
        }
      }
    }
  };

  useEffect(() => {
    if (!companyId) return undefined;
    let stopped = false;
    let since = 0;
    let failures = 0;
    let control: AbortController | null = null;
    let hiddenWait: (() => void) | null = null;
    const waitVisible = () => {
      if (!document.hidden) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          document.removeEventListener("visibilitychange", done);
          hiddenWait = null;
          resolve();
        };
        hiddenWait = done;
        document.addEventListener("visibilitychange", done);
      });
    };
    const run = async () => {
      while (!stopped) {
        await waitVisible();
        if (stopped) return;
        control = new AbortController();
        const timer = window.setTimeout(() => control?.abort(), INBOX_ABORT_MS);
        try {
          const response = await fetch("/api/plugins/andhash.plugin-pc-telegram/data/inbox-wait", {
            method: "POST",
            credentials: "include",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ companyId, params: { companyId, since } }),
            signal: control.signal,
          });
          window.clearTimeout(timer);
          if (!response.ok) throw new Error(String(response.status));
          const payload = await response.json() as { data?: { seq?: number; reset?: boolean; events?: InboxStreamEvent[] } };
          const data = payload.data ?? {};
          if (typeof data.seq === "number") since = data.seq;
          if (data.reset) {
            refreshThread.current();
            refreshChats.current();
          }
          for (const event of data.events ?? []) applyInboxRef.current(event);
          failures = 0;
        } catch {
          window.clearTimeout(timer);
          if (stopped) return;
          failures += 1;
          const delay = Math.min(8000, 1000 * 2 ** Math.min(failures, 3));
          await new Promise((resolve) => window.setTimeout(resolve, delay));
        }
      }
    };
    void run();
    return () => {
      stopped = true;
      control?.abort();
      const pending = hiddenWait;
      hiddenWait = null;
      if (pending) {
        document.removeEventListener("visibilitychange", pending);
        pending();
      }
    };
  }, [companyId]);

  useEffect(() => {
    if (!profileRef) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileRef(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [profileRef]);

  useLayoutEffect(() => {
    if (!shell) return undefined;
    const restore = hideHostBack(shell);
    const fit = () => {
      const top = shell.getBoundingClientRect().top;
      if (top <= 0 || top > window.innerHeight * 0.6) return;
      const next = Math.max(320, Math.round(window.innerHeight - top - 16));
      shell.style.height = `${next}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
      shell.style.height = "";
      restore();
    };
  }, [shell]);

  useLayoutEffect(() => {
    sawLoading.current = false;
    olderSeen.current = "";
    stickRef.current = true;
    holdScroll.current = null;
    pendingAnchor.current = null;
    const cached = cacheKey ? threadCache.get(cacheKey) ?? null : null;
    setTranscript(cached);
    setReadyKey(cached ? cacheKey : "");
    setFeedRange(tailFeedRange(cached?.messages.length ?? 0));
    setOlderBefore(null);
    setOlderFault(null);
    failedOlder.current = null;
    hiddenIds.current = new Set();
    const previous = previousIssueRef.current;
    if (previous && previous !== issueRef) draftsRef.current[previous] = draftLive.current;
    previousIssueRef.current = issueRef;
    setDraftValue(issueRef ? draftsRef.current[issueRef] ?? "" : "");
    setMenu(null);
    setReply(null);
    setSelecting(false);
    setSelected([]);
    setReactions({});
    setPinned([]);
    setBelow(0);
  }, [cacheKey]);

  useEffect(() => {
    if (chats.loading || chats.error || !chats.data) return;
    const page = chats.data.chats ?? [];
    setLoadedChats((current) => mergeLoadedChats(current, page, "latest"));
    if (!listCursor) setNextChatCursor(chats.data.nextCursor ?? null);
  }, [chats.loading, chats.error, chats.data, listCursor]);

  useEffect(() => {
    if (!listCursor || olderChats.loading || olderChats.error || !olderChats.data) return;
    const page = olderChats.data.chats ?? [];
    setLoadedChats((current) => mergeLoadedChats(current, page, "older"));
    setNextChatCursor(olderChats.data.nextCursor ?? null);
  }, [listCursor, olderChats.loading, olderChats.error, olderChats.data]);

  useEffect(() => {
    if (!cacheKey) return;
    if (typeof thread.data?.peerId === "string") openPeer.current = thread.data.peerId;
    if (typeof thread.data?.accountId === "string") openAccount.current = thread.data.accountId;
    if (thread.error) return;
    if (thread.loading) {
      sawLoading.current = true;
      return;
    }
    if (!sawLoading.current || !thread.data) return;
    if (thread.data.found === false) {
      const empty: ThreadView = {
        messages: [],
        live: false,
        label: "",
        photo: null,
        presence: null,
        hasMore: false,
        exhausted: true,
        issueId: "",
        identifier: null,
      };
      storeThread(cacheKey, empty);
      setTranscript(empty);
      setReadyKey(cacheKey);
      return;
    }
    const incoming = thread.data.messages ?? [];
    const incomingHasMore = typeof thread.data.hasMore === "boolean" ? thread.data.hasMore : incoming.length >= 40;
    const cached = threadCache.get(cacheKey);
    const ahead = streamAhead.get(cacheKey) ?? [];
    if (cached && ahead.length === 0 && sameThreadTop(cached.messages, incoming)) {
      const next: ThreadView = {
        ...cached,
        live: thread.data.live !== false,
        label: thread.data.label || cached.label,
        photo: thread.data.photo ?? cached.photo,
        presence: thread.data.presence ?? cached.presence,
        issueId: thread.data.issueId || cached.issueId,
        identifier: thread.data.identifier ?? cached.identifier,
      };
      storeThread(cacheKey, next);
      setTranscript(next);
      setReadyKey(cacheKey);
      return;
    }
    const base = threadCache.get(cacheKey) ?? transcriptRef.current;
    const next: ThreadView = {
      messages: absorbStreamAhead(cacheKey, mergeThreadMessages(base?.messages ?? [], incoming)).filter((item) => !hiddenIds.current.has(item.id)),
      live: thread.data.live !== false,
      label: thread.data.label || base?.label || "",
      photo: thread.data.photo ?? base?.photo ?? null,
      presence: thread.data.presence ?? base?.presence ?? null,
      hasMore: base?.exhausted ? false : incomingHasMore,
      exhausted: base?.exhausted ?? false,
      issueId: thread.data.issueId || base?.issueId || "",
      identifier: thread.data.identifier ?? base?.identifier ?? null,
    };
    storeThread(cacheKey, next);
    setTranscript(next);
    setReadyKey(cacheKey);
  }, [cacheKey, thread.loading, thread.data, thread.error]);

  useEffect(() => {
    if (!olderBefore || !cacheKey) return;
    if (older.loading) {
      olderSeen.current = olderBefore;
      return;
    }
    if (older.error) {
      if (olderSeen.current !== olderBefore) return;
      failedOlder.current = olderBefore;
      setOlderFault(errorMessage(older.error));
      olderSeen.current = "";
      setOlderBefore(null);
      return;
    }
    if (olderSeen.current !== olderBefore || !older.data) return;
    const page = older.data.messages ?? [];
    const element = feedNode.current;
    if (element && feedRangeRef.current) pendingAnchor.current = captureFeedAnchor(element);
    setTranscript((current) => {
      const base = current ?? threadCache.get(cacheKey) ?? null;
      if (!base) return current;
      const merged = mergeThreadMessages(base.messages, page).filter((item) => !hiddenIds.current.has(item.id));
      const exhausted = page.length < 40 || merged.length === base.messages.length;
      const next: ThreadView = {
        ...base,
        messages: merged,
        hasMore: !exhausted && base.hasMore,
        exhausted: exhausted || base.exhausted,
      };
      storeThread(cacheKey, next);
      setFeedRange((range) => shiftFeedRange(range, merged.length - base.messages.length));
      return next;
    });
    olderSeen.current = "";
    failedOlder.current = null;
    setOlderFault(null);
    setOlderBefore(null);
  }, [older.loading, older.data, older.error, olderBefore, cacheKey]);

  useEffect(() => {
    const element = feed;
    if (!element) return undefined;
    const onScroll = () => {
      const nearBottom = isNearBottom(element.scrollTop, element.scrollHeight, element.clientHeight);
      stickRef.current = nearBottom;
      const list = messagesRef.current;
      if (nearBottom) {
        if (belowRef.current > 0) setBelow(0);
        const tail = tailFeedRange(list.length);
        const range = feedRangeRef.current;
        if (tail && range && (range.end < list.length || range.start !== tail.start)) {
          pendingAnchor.current = null;
          setFeedRange(tail);
        }
      } else if (list.length > 40) {
        const anchor = captureFeedAnchor(element);
        if (anchor) {
          const index = list.findIndex((item) => item.id === anchor.id);
          const next = slideFeedRange(list.length, index, feedRangeRef.current);
          if (next && next !== feedRangeRef.current) {
            pendingAnchor.current = anchor;
            setFeedRange(next);
          }
        }
      }
      if (element.scrollTop < 240) requestOlderRef.current();
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [feed]);

  useLayoutEffect(() => {
    const element = feed;
    if (!element) return;
    const anchor = pendingAnchor.current;
    if (anchor) {
      const node = bubbleNode(element, anchor.id);
      if (node) {
        const delta = node.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
        element.scrollTop += delta;
      }
      pendingAnchor.current = null;
      return;
    }
    const hold = holdScroll.current;
    if (hold) {
      element.scrollTop = hold.top + Math.max(0, element.scrollHeight - hold.height);
      holdScroll.current = null;
      return;
    }
    if (stickRef.current) element.scrollTop = element.scrollHeight;
  }, [feed, messages, cacheKey, feedRange]);

  useEffect(() => {
    const element = feed;
    const view = transcriptRef.current;
    if (!element || !view?.hasMore || view.exhausted || olderBefore) return;
    if (element.scrollHeight > element.clientHeight + 8) return;
    const range = feedRangeRef.current;
    if (range && range.start > 0) {
      setFeedRange({ start: Math.max(0, range.start - 20), end: range.end });
      return;
    }
    requestOlderRef.current();
  }, [feed, messages.length, olderBefore, transcript?.hasMore, transcript?.exhausted, feedRange]);

  useLayoutEffect(() => {
    if (composerRef.current) resizeComposer(composerRef.current);
  }, [draft, issueRef]);

  async function submit() {
    const text = draft.trim();
    const submittedRef = issueRef;
    if (!text || !companyId || !submittedRef || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const replyTo = reply && isTelegramMessageId(reply.id) ? reply.id : "";
      await sendReply({ companyId, issueRef: submittedRef, text, ...(replyTo ? { replyTo } : {}) });
      delete draftsRef.current[submittedRef];
      if (issueRefLive.current === submittedRef) {
        setDraftValue("");
        setReply(null);
      }
      refreshThread.current();
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  function openMenu(clientX: number, clientY: number, message: { id: string; text: string }) {
    const node = shell;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setMenu({
      ids: [message.id],
      text: message.text,
      x: clientX - rect.left,
      y: clientY - rect.top,
      page: "menu",
    });
  }

  function holdMessage(event: ReactPointerEvent<HTMLDivElement>, message: { id: string; text: string }) {
    if (event.pointerType === "mouse" || selecting) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const node = event.currentTarget;
    const timer = window.setTimeout(() => openMenu(startX, startY, message), 420);
    const stop = () => {
      window.clearTimeout(timer);
      node.removeEventListener("pointerup", stop);
      node.removeEventListener("pointercancel", stop);
      node.removeEventListener("pointermove", move);
    };
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 8 || Math.abs(ev.clientY - startY) > 8) stop();
    };
    node.addEventListener("pointerup", stop);
    node.addEventListener("pointercancel", stop);
    node.addEventListener("pointermove", move);
  }

  async function copyMessage(text: string) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error("copy");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setMenu(null);
  }

  async function runMenu(
    op: "react" | "pin" | "unpin" | "delete" | "forward",
    extra: { emoji?: string; revoke?: boolean; targetIssueRef?: string },
  ) {
    if (!menu || !companyId || !issueRef || acting) return;
    const ids = menu.ids.filter(isTelegramMessageId);
    if (ids.length === 0) return;
    setActing(true);
    setSendError(null);
    try {
      const targetKey = openCacheKey.current;
      await menuAction({ companyId, issueRef, op, messageIds: ids, ...extra });
      if (op === "delete") {
        const drop = new Set(ids);
        const stillOpen = Boolean(targetKey) && targetKey === openCacheKey.current;
        if (stillOpen) {
          for (const id of ids) hiddenIds.current.add(id);
        }
        const base = targetKey ? threadCache.get(targetKey) ?? null : null;
        if (base) {
          const next = { ...base, messages: base.messages.filter((item) => !drop.has(item.id)) };
          storeThread(targetKey, next);
          if (stillOpen) setTranscript(next);
        }
        setSelecting(false);
        setSelected([]);
      } else if (op === "react") {
        setReactions((current) => ({ ...current, [ids[0] ?? ""]: extra.emoji ?? "" }));
      } else if (op === "pin") {
        setPinned((current) => current.includes(ids[0] ?? "") ? current : [...current, ids[0] ?? ""]);
      } else if (op === "unpin") {
        setPinned((current) => current.filter((id) => id !== ids[0]));
      }
      setMenu(null);
      refreshThread.current();
    } catch (error) {
      setSendError(errorMessage(error));
      setMenu(null);
    } finally {
      setActing(false);
    }
  }

  if (!companyId || !prefix) return null;
  const chatSource = loadedChats.length > 0 ? loadedChats : (chats.data?.chats ?? []);
  const listed = chatSource.map((chat) => {
    const ref = chat.identifier || chat.issueId;
    const patch = rowPatches[ref];
    const photo = keepShownPhoto(shownListPhotos.current[ref], patch?.photo ?? chat.photo);
    if (photo) shownListPhotos.current[ref] = photo;
    if (!patch && photo === (chat.photo ?? null)) return chat;
    return {
      ...chat,
      preview: patch?.preview ?? chat.preview,
      previewPlaceholder: patch?.previewPlaceholder ?? chat.previewPlaceholder,
      unread: patch?.unread ?? chat.unread,
      updatedAt: patch?.updatedAt || chat.updatedAt,
      photo,
    };
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const rows = filterChats(listed, query);
  const showList = !narrow || !issueRef;
  const showThread = !narrow || Boolean(issueRef);
  const openChat = listed.find((chat) => (chat.identifier || chat.issueId) === issueRef);
  if (openChat?.peerId) openPeer.current = openChat.peerId;
  if (openChat?.accountId) openAccount.current = openChat.accountId;
  const label = openChat?.label || transcript?.label || uiText("Telegram");
  const headerPhoto = safePhoto(transcript?.photo) || safePhoto(openChat?.photo);
  const headerPresence = transcript?.presence || openChat?.presence || null;
  const headerStatus = presenceText(headerPresence, ru);
  const profileChat = listed.find((chat) => (chat.identifier || chat.issueId) === profileRef);
  openProfile.current = {
    issueRef: profileRef ?? "",
    accountId: profileChat?.accountId || (profileRef && profileRef === issueRef ? openAccount.current : "") || "",
    peerId: profileChat?.peerId || (profileRef && profileRef === issueRef ? openPeer.current : "") || "",
  };
  const profileName = profile.data?.name || profileChat?.label || (profileRef === issueRef ? label : uiText("Telegram"));
  const profilePhoto = safePhoto(profile.data?.photo) || safePhoto(profileChat?.photo) || (profileRef === issueRef ? headerPhoto : null);
  const profilePresence = profile.data?.presence || profileChat?.presence || (profileRef === issueRef ? headerPresence : null);
  const profileStatus = presenceText(profilePresence, ru);
  const profilePhone = (profile.data?.phone ?? "").trim();
  const profileUser = (profile.data?.username ?? "").trim();
  const profileAbout = (profile.data?.about ?? "").trim();
  const profileChannel = (profile.data?.channel ?? "").trim();
  const sharedChats = profile.data?.sharedChats ?? 0;
  const days = groupThread(visibleMessages, now, ru);
  const taskHref = `/${prefix}/issues/${encodeURIComponent(openChat?.identifier || transcript?.identifier || issueRef)}`;
  const menuBox = menu?.page === "forward" ? 300 : menu?.page === "reactions" ? 430 : menu?.page === "delete" ? 160 : 340;
  const menuPos = menu
    ? menuPosition(
      { x: menu.x, y: menu.y },
      { width: shellWidth || shell?.clientWidth || 360, height: shell?.clientHeight || 640 },
      { width: 220, height: menuBox },
    )
    : null;
  const menuMutable = Boolean(menu && menu.ids.length > 0 && menu.ids.every(isTelegramMessageId));
  const menuPinned = Boolean(menu?.ids[0] && pinned.includes(menu.ids[0]));

  return (
    <>
      <style>{TG_CSS}</style>
      <div className={narrow ? "tg-shell is-narrow" : "tg-shell"} ref={setShell}>
      {showList ? (
        <div className="tg-list">
          <div className="tg-search">
            <div className="tg-search-field">
              <span className="tg-search-icon"><SearchIcon /></span>
              <input
                className="tg-search-input"
                type="search"
                value={query}
                placeholder={uiText("Search")}
                aria-label={uiText("Search")}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          {chats.error && rows.length === 0 ? (
            <div className="tg-list-empty" role="alert">
              <div>{errorMessage(chats.error)}</div>
              <button type="button" onClick={() => chats.refresh()}>{uiText("Retry")}</button>
            </div>
          ) : rows.length === 0 && !chats.loading && !nextChatCursor ? (
            <div className="tg-list-empty">{uiText("No chats")}</div>
          ) : (
            <div className="tg-rows">
              {rows.map((chat) => {
                const ref = chat.identifier || chat.issueId;
                const selected = !narrow && ref === issueRef;
                const badge = unreadLabel(chat.unread);
                const preview = chat.preview?.trim() ?? "";
                const previewText = preview && chat.previewPlaceholder ? uiText(preview) : preview;
                return (
                  <div
                    key={chat.issueId}
                    className={selected ? "tg-row is-selected" : "tg-row"}
                  >
                    <button
                      type="button"
                      className="tg-avatar-btn"
                      aria-label={uiText("User Info")}
                      onClick={() => setProfileRef(ref)}
                    >
                      <Avatar
                        id={chat.issueId}
                        name={chat.label}
                        photo={chat.photo}
                        online={chat.presence?.code === "online"}
                      />
                    </button>
                    <a
                      className="tg-row-body"
                      {...navigation.linkProps(`/${prefix}/telegram-inbox/${encodeURIComponent(ref)}`)}
                      aria-current={selected ? "page" : undefined}
                    >
                      <span className="tg-row-top">
                        <span className="tg-row-name">{chat.label}</span>
                        <span className="tg-row-time">{formatListTime(chat.updatedAt, now, ru)}</span>
                      </span>
                      {preview || badge ? (
                        <span className="tg-row-bottom">
                          <span className="tg-row-preview">{previewText}</span>
                          {badge ? <span className="tg-badge">{badge}</span> : null}
                        </span>
                      ) : null}
                    </a>
                  </div>
                );
              })}
              {nextChatCursor ? (
                <button type="button" onClick={() => setListCursor(nextChatCursor)} disabled={chats.loading || olderChats.loading}>
                  {uiText("Load older chats")}
                </button>
              ) : null}
              {(olderChats.error || chats.error) && rows.length > 0 ? (
                <div role="alert">
                  <div>{errorMessage(olderChats.error ?? chats.error)}</div>
                  <button type="button" onClick={() => (olderChats.error ? olderChats : chats).refresh()}>{uiText("Retry")}</button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      {showThread ? (
        <div className="tg-thread">
          {!issueRef ? (
            <div className="tg-empty">{uiText("Select a chat")}</div>
          ) : (
            <>
              <header className="tg-topbar">
                {narrow ? (
                  <a className="tg-back" {...navigation.linkProps(`/${prefix}/telegram-inbox`)} aria-label={uiText("Back")}>
                    <BackIcon />
                  </a>
                ) : null}
                <button
                  type="button"
                  className="tg-peer-btn"
                  aria-label={uiText("User Info")}
                  onClick={() => setProfileRef(issueRef)}
                >
                  <Avatar
                    id={openChat?.issueId || transcript?.issueId || issueRef}
                    name={label}
                    photo={headerPhoto}
                    topbar
                    online={headerPresence?.code === "online"}
                  />
                  <span className="tg-peer-copy">
                    <span className="tg-peer-name">{label}</span>
                    {headerStatus ? (
                      <span className={headerPresence?.code === "online" ? "tg-peer-status is-online" : "tg-peer-status"}>
                        {headerStatus}
                      </span>
                    ) : null}
                  </span>
                </button>
                <a className="tg-task" {...navigation.linkProps(taskHref)}>{uiText("Task")}</a>
              </header>
              {thread.error && messages.length > 0 ? (
                <div className="tg-offline" role="alert">
                  {errorMessage(thread.error)}
                  <button type="button" onClick={() => thread.refresh()}>{uiText("Retry")}</button>
                </div>
              ) : null}
              {olderFault ? (
                <div className="tg-offline" role="alert">
                  {olderFault}
                  <button
                    type="button"
                    onClick={() => {
                      const id = failedOlder.current;
                      if (!id) return;
                      setOlderFault(null);
                      setOlderBefore(id);
                    }}
                  >{uiText("Retry")}</button>
                </div>
              ) : null}
              {readyKey === cacheKey && transcript && transcript.live === false && !thread.error ? (
                <div className="tg-offline">
                  {uiText("The Telegram account is offline. Showing messages already saved on the task.")}
                </div>
              ) : null}
              {below > 0 ? (
                <button
                  type="button"
                  className="tg-jump"
                  onClick={() => {
                    stickRef.current = true;
                    setBelow(0);
                    const element = feedNode.current;
                    setFeedRange(tailFeedRange(messagesRef.current.length));
                    if (element) element.scrollTop = element.scrollHeight;
                  }}
                >
                  {below}
                </button>
              ) : null}
              <div className={feedIsCompact(feedWidth) ? "tg-feed is-compact" : "tg-feed"} ref={setFeed}>
                {olderBefore ? <div className="tg-history" aria-hidden="true"><i /></div> : null}
                {messages.length === 0 && thread.error ? (
                  <div className="tg-empty" role="alert">
                    <div>{errorMessage(thread.error)}</div>
                    <button type="button" onClick={() => thread.refresh()}>{uiText("Retry")}</button>
                  </div>
                ) : messages.length === 0 && readyKey === cacheKey ? (
                  <div className="tg-empty">{uiText("No messages")}</div>
                ) : days.map((day) => (
                  <div className="tg-day" key={day.key}>
                    {day.label ? <div className="tg-date">{day.label}</div> : null}
                    {day.groups.map((group) => (
                      <div className={`tg-group ${group.direction}`} key={group.key}>
                        {group.messages.map((message) => {
                          const at = parseTime(message.at);
                          return (
                            <div
                              className={`tg-bubble ${message.direction} ${message.position}${selecting && selected.includes(message.id) ? " is-picked" : ""}`}
                              key={message.id}
                              data-mid={message.id}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                if (!selecting) openMenu(event.clientX, event.clientY, message);
                              }}
                              onPointerDown={(event) => holdMessage(event, message)}
                              onClick={() => {
                                if (!selecting || !isTelegramMessageId(message.id)) return;
                                setSelected((current) => (
                                  current.includes(message.id)
                                    ? current.filter((id) => id !== message.id)
                                    : [...current, message.id]
                                ));
                              }}
                            >
                              {message.forward ? <span className="tg-forward">{forwardLine(message.forward)}</span> : null}
                              {message.text ? (message.placeholder ? uiText(message.text) : message.text) : null}
                              {at ? <span className="tg-bubble-time">{formatClock(at)}</span> : null}
                              {reactions[message.id] ? <span className="tg-react-badge">{reactions[message.id]}</span> : null}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              {selecting ? (
                <div className="tg-selectbar">
                  <button type="button" onClick={() => { setSelecting(false); setSelected([]); }}>{uiText("Cancel")}</button>
                  <span>{selected.length}</span>
                  <button
                    type="button"
                    disabled={selected.length === 0 || acting}
                    onClick={() => {
                      const node = shell;
                      const rect = node?.getBoundingClientRect();
                      setMenu({
                        ids: selected,
                        text: "",
                        x: 16,
                        y: rect ? Math.max(16, rect.height - 280) : 16,
                        page: "forward",
                      });
                    }}
                  >{uiText("Forward")}</button>
                  <button
                    type="button"
                    className="is-danger"
                    disabled={selected.length === 0 || acting}
                    onClick={() => {
                      const node = shell;
                      const rect = node?.getBoundingClientRect();
                      setMenu({
                        ids: selected,
                        text: "",
                        x: 16,
                        y: rect ? Math.max(16, rect.height - 180) : 16,
                        page: "delete",
                      });
                    }}
                  >{uiText("Delete")}</button>
                </div>
              ) : (
              <div className="tg-composer-wrap">
                {reply ? (
                  <div className="tg-reply">
                    <span className="tg-reply-text">{reply.text || uiText("Message")}</span>
                    <button type="button" className="tg-reply-x" aria-label={uiText("Close")} onClick={() => setReply(null)}>×</button>
                  </div>
                ) : null}
                <form
                  className="tg-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <textarea
                    ref={composerRef}
                    className="tg-composer-input"
                    value={draft}
                    rows={1}
                    placeholder={uiText("Message")}
                    aria-label={uiText("Message")}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <button
                    type="submit"
                    className="tg-send"
                    aria-label={uiText("Send")}
                    disabled={sending || draft.trim().length === 0}
                  >
                    <SendIcon />
                  </button>
                </form>
                {sendError ? <div role="alert" className="tg-send-error">{sendError}</div> : null}
              </div>
              )}
            </>
          )}
        </div>
      ) : null}
      <InboxProfile
        profileRef={profileRef}
        profileChat={profileChat}
        profileName={profileName}
        profilePhoto={profilePhoto}
        profilePresence={profilePresence}
        profileStatus={profileStatus}
        profileChannel={profileChannel}
        profilePhone={profilePhone}
        profileUser={profileUser}
        profileAbout={profileAbout}
        sharedChats={sharedChats}
        profileFailed={Boolean(profile.error && !profile.data)}
        onClose={() => setProfileRef(null)}
      />
      <InboxMenu
        menu={menu}
        menuPos={menuPos}
        setMenu={setMenu}
        menuMutable={menuMutable}
        acting={acting}
        runMenu={runMenu}
        reactions={reactions}
        chats={chatSource}
        setReply={setReply}
        composerRef={composerRef}
        setSelecting={setSelecting}
        setSelected={setSelected}
        copyMessage={copyMessage}
        menuPinned={menuPinned}
      />
      </div>
    </>
  );
}
