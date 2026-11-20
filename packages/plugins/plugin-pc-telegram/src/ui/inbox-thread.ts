import { mergeThreadMessages, rememberCacheKey } from "./inbox-model.js";

export type PresenceView = { code?: string | null; at?: string | null } | null;

export type TelegramChatRow = {
  issueId: string;
  identifier: string | null;
  label: string;
  status: string;
  updatedAt: string;
  preview?: string | null;
  previewPlaceholder?: boolean;
  unread?: number | null;
  photo?: string | null;
  presence?: PresenceView;
  accountId?: string | null;
  peerId?: string | null;
};

export type ChatBubbleView = {
  id: string;
  direction: "in" | "out";
  text: string;
  at: string;
  forward?: { kind?: string | null; name?: string | null; author?: string | null } | null;
  placeholder?: boolean;
};

export type ChatThreadData = {
  found?: boolean;
  live?: boolean;
  hasMore?: boolean;
  label?: string;
  issueId?: string;
  identifier?: string | null;
  peerId?: string | null;
  accountId?: string | null;
  photo?: string | null;
  presence?: PresenceView;
  messages?: ChatBubbleView[];
};

export type ThreadView = {
  messages: ChatBubbleView[];
  live: boolean;
  label: string;
  photo: string | null;
  presence: PresenceView;
  hasMore: boolean;
  exhausted: boolean;
  issueId: string;
  identifier: string | null;
};

export const threadCache = new Map<string, ThreadView>();
export const threadCacheOrder: string[] = [];
export const streamAhead = new Map<string, ChatBubbleView[]>();
export const THREAD_CACHE_LIMIT = 8;

export function storeThread(key: string, view: ThreadView) {
  threadCache.set(key, view);
  const evicted = rememberCacheKey(threadCacheOrder, key, THREAD_CACHE_LIMIT);
  if (evicted) {
    threadCache.delete(evicted);
    streamAhead.delete(evicted);
  }
}

export function queueStreamBubble(key: string, bubble: ChatBubbleView) {
  streamAhead.set(key, mergeThreadMessages(streamAhead.get(key) ?? [], [bubble]));
}

export function absorbStreamAhead(key: string, messages: ChatBubbleView[]): ChatBubbleView[] {
  const ahead = streamAhead.get(key);
  if (!ahead?.length) return messages;
  streamAhead.delete(key);
  return mergeThreadMessages(messages, ahead);
}

export type ChatProfileData = {
  found?: boolean;
  name?: string;
  username?: string | null;
  phone?: string | null;
  about?: string | null;
  photo?: string | null;
  presence?: PresenceView;
  channel?: string | null;
  sharedChats?: number | null;
};

export type InboxStreamEvent = {
  companyId?: string;
  kind?: string;
  issueRef?: string;
  accountId?: string;
  peerId?: string;
  bubble?: ChatBubbleView;
  messageIds?: string[];
  preview?: string;
  previewPlaceholder?: boolean;
  unread?: number;
  activityAt?: string;
  photo?: string | null;
};

/** Worker parks inbox-wait for 12s. The abort sits past that plus a slow-link RTT, under the 30s host RPC cap. */
export const INBOX_ABORT_MS = 28_000;

export type RowPatch = {
  preview?: string | null;
  previewPlaceholder?: boolean;
  unread?: number;
  updatedAt?: string;
  photo?: string | null;
};

export function bubbleNode(element: HTMLElement, id: string): HTMLElement | null {
  const nodes = element.querySelectorAll<HTMLElement>("[data-mid]");
  for (const node of nodes) {
    if (node.dataset.mid === id) return node;
  }
  return null;
}

export function captureFeedAnchor(element: HTMLElement): { id: string; offset: number } | null {
  const rootTop = element.getBoundingClientRect().top;
  const nodes = element.querySelectorAll<HTMLElement>("[data-mid]");
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= rootTop + 1) continue;
    const id = node.dataset.mid;
    if (!id) continue;
    return { id, offset: rect.top - rootTop };
  }
  return null;
}
