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
  return {
    key: navigation?.key,
    ready,
    initialPosition(root: Element, viewportTop: number, scrollTop: number): number | null {
      if (!navigation) return null;
      if (navigation.restore && positions.has(navigation.key)) {
        const saved = positions.get(navigation.key)!;
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
      if (!navigation || !ready) return;
      positions.set(navigation.key, { top, anchor });
      if (positions.size > 100) positions.delete(positions.keys().next().value!);
    },
  };
}
