import type { ChatBubble } from "./thread.js";

const NUMERIC_TELEGRAM_ID = /^\d{1,16}$/;

export const BEFORE_PAGE_TTL_MS = 60_000;

/** Same-second Telegram ids are numeric. `"100"` must not sort before `"99"`. */
export function compareTelegramIds(left: string, right: string): number {
  if (NUMERIC_TELEGRAM_ID.test(left) && NUMERIC_TELEGRAM_ID.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  return left.localeCompare(right);
}

export function compareTelegramMessageOrder(
  left: { at: string; id: string },
  right: { at: string; id: string },
): number {
  return left.at.localeCompare(right.at) || compareTelegramIds(left.id, right.id);
}

export function historyCacheKey(accountId: string, peerId: string, beforeId: string): string {
  return `${accountId}:${peerId}:${beforeId || "latest"}`;
}

/** The latest page stays until an update or a gap drops it. Older pages expire. */
export function historyHitIsFresh(beforeId: string, storedAt: number, now: number): boolean {
  if (!beforeId) return true;
  return now - storedAt < BEFORE_PAGE_TTL_MS;
}

export function patchHistoryMessages(messages: ChatBubble[], incoming: ChatBubble[]): ChatBubble[] {
  if (incoming.length === 0) return messages;
  const byId = new Map<string, ChatBubble>();
  for (const message of messages) byId.set(message.id, message);
  for (const message of incoming) {
    const previous = byId.get(message.id);
    byId.set(message.id, previous ? { ...previous, ...message, forward: message.forward ?? previous.forward } : message);
  }
  return [...byId.values()].sort(compareTelegramMessageOrder);
}

export function removeHistoryMessages(messages: ChatBubble[], ids: string[]): ChatBubble[] {
  if (ids.length === 0) return messages;
  const drop = new Set(ids);
  return messages.filter((message) => !drop.has(message.id));
}

export const HISTORY_PAGE_SIZE = 40;

/** The latest key is one page. Older messages come back through beforeId. */
export function boundLatestHistory(messages: ChatBubble[]): ChatBubble[] {
  if (messages.length <= HISTORY_PAGE_SIZE) return messages;
  return messages.slice(-HISTORY_PAGE_SIZE);
}

export function reconcileFetchedHistory(
  previous: ChatBubble[],
  fetched: ChatBubble[],
  queued: ChatBubble[] = [],
): ChatBubble[] {
  if (fetched.length === 0) return boundLatestHistory(patchHistoryMessages([], queued));
  const numeric = fetched
    .map((message) => Number(message.id))
    .filter((id) => Number.isFinite(id));
  const max = Math.max(...numeric);
  const fetchedIds = new Set(fetched.map((message) => message.id));
  const kept = previous.filter((message) => {
    if (fetchedIds.has(message.id)) return true;
    const id = Number(message.id);
    if (!Number.isFinite(id) || numeric.length === 0) return true;
    return id > max;
  });
  return boundLatestHistory(patchHistoryMessages(patchHistoryMessages(kept, fetched), queued));
}

export function historyContentChanged(previous: ChatBubble[], next: ChatBubble[]): boolean {
  if (previous.length !== next.length) return true;
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (!left || !right) return true;
    if (left.id !== right.id || left.text !== right.text || left.direction !== right.direction) return true;
  }
  return false;
}
