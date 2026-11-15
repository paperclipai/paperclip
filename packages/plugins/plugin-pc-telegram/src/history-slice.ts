import type { ChatBubble } from "./thread.js";

export const BEFORE_PAGE_TTL_MS = 60_000;

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
  return [...byId.values()].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
}

export function removeHistoryMessages(messages: ChatBubble[], ids: string[]): ChatBubble[] {
  if (ids.length === 0) return messages;
  const drop = new Set(ids);
  return messages.filter((message) => !drop.has(message.id));
}
