import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isUuidLike } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

type Seen = { id: string; at: number };
const ChatReadContext = createContext<((message: Seen) => void) | null>(null);

export function AgentChatReadProvider({ issueId, companyId, userId, children }: {
  issueId?: string; companyId: string; userId: string | null; children: ReactNode;
}) {
  const client = useQueryClient();
  const [error, setError] = useState(false);
  const scope = useMemo(() => ({ active: true, pending: null as Seen | null, sentIds: new Set<string>(), sentAt: -Infinity, busy: false }), [issueId, companyId, userId]);
  useEffect(() => { scope.active = true; setError(false); return () => { scope.active = false; }; }, [scope]);
  const seen = useCallback((message: Seen) => {
    if (!issueId || !scope.active || scope.sentIds.has(message.id) || message.at < scope.sentAt) return;
    if (!scope.pending || message.at >= scope.pending.at) scope.pending = message;
    if (scope.busy) return;
    scope.busy = true;
    queueMicrotask(async () => {
      try {
        while (scope.active && scope.pending) {
          const next = scope.pending;
          scope.pending = null;
          await issuesApi.markRead(issueId, next.id);
          if (!scope.active) return;
          scope.sentAt = Math.max(scope.sentAt, next.at);
          scope.sentIds.add(next.id);
          setError(false);
          void client.invalidateQueries({ queryKey: queryKeys.agentChats.list(companyId, userId) });
          void client.invalidateQueries({ queryKey: ["agent-chat", companyId, userId] });
        }
      } catch {
        if (scope.active) setError(true);
      } finally { scope.busy = false; }
    });
  }, [issueId, companyId, userId, client, scope]);
  return <ChatReadContext.Provider value={issueId ? seen : null}>
    {error && <p role="alert" className="text-sm text-destructive">Couldn’t mark this chat read. Reopen the chat to retry.</p>}
    {children}
  </ChatReadContext.Provider>;
}

export function useAgentChatRead(id: string, createdAt: string | undefined, enabled: boolean) {
  const seen = useContext(ChatReadContext);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!seen || !enabled || !element || !isUuidLike(id) || !createdAt) return;
    const at = new Date(createdAt).getTime();
    if (!Number.isFinite(at)) return;
    const viewport = element.closest<HTMLElement>(".task-chat-scroll-viewport");
    const check = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus() || !viewport) return;
      if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 1) return;
      const message = element.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
      if (message.height > 0 && message.bottom <= bounds.bottom + 1 && message.bottom > bounds.top) seen({ id, at });
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(check, { root: viewport });
    observer?.observe(element);
    viewport?.addEventListener("scroll", check, { passive: true });
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    const frame = requestAnimationFrame(check);
    return () => {
      cancelAnimationFrame(frame); observer?.disconnect();
      viewport?.removeEventListener("scroll", check);
      document.removeEventListener("visibilitychange", check); window.removeEventListener("focus", check);
    };
  }, [seen, id, createdAt, enabled]);
  return ref;
}
