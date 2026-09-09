import { type ThreadScrollAnchor, threadScrollAnchorDelta } from "./scroll-anchor";
import { createContext, useContext } from "react";

export const TaskChatScrollNavigation = createContext<{ key: string; restore: boolean; hash: string } | null>(null);
export const TaskChatScrollReady = createContext(true);

// Scoped to browser-history entries, not issues: opening the same task from a
// new Inbox click starts at latest, while Back restores the previous reading.
const positions = new Map<string, { top: number; anchor: ThreadScrollAnchor | null }>();

export function useTaskChatScrollNavigation() {
  const navigation = useContext(TaskChatScrollNavigation);
  const ready = useContext(TaskChatScrollReady);
  // Native hash links can reuse React Router's history key. Keep those entries
  // separate so their POP event does not restore the previous hash's position.
  const positionKey = navigation ? JSON.stringify([navigation.key, navigation.hash]) : null;
  return {
    key: navigation?.key,
    hash: navigation?.hash,
    ready,
    initialPosition(root: Element, viewportTop: number, scrollTop: number): number | null {
      if (!navigation) return null;
      if (navigation.restore && positionKey && positions.has(positionKey)) {
        const saved = positions.get(positionKey)!;
        if (saved.anchor && [...root.querySelectorAll<HTMLElement>("[data-thread-anchor]")].some((row) => row.dataset.threadAnchor === saved.anchor?.id)) {
          return scrollTop + threadScrollAnchorDelta(root, saved.anchor, viewportTop);
        }
        return saved.top;
      }
      if (navigation.hash) {
        let id: string;
        try { id = decodeURIComponent(navigation.hash.slice(1)); } catch { return null; }
        const target = document.getElementById(id);
        if (target && root.contains(target)) return scrollTop + target.getBoundingClientRect().top - viewportTop;
      }
      return null;
    },
    remember(top: number, anchor: ThreadScrollAnchor | null) {
      if (!positionKey || !ready) return;
      positions.set(positionKey, { top, anchor });
      if (positions.size > 100) positions.delete(positions.keys().next().value!);
    },
  };
}
