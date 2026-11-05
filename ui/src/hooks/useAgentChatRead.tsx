import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isUuidLike } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

type Seen = { id: string; at: number };
const READ_RETRY_DELAYS = [500, 1_500];
const ChatReadContext = createContext<((message: Seen) => void) | null>(null);

export function AgentChatReadProvider({ issueId, companyId, userId, children }: {
  issueId?: string; companyId: string; userId: string | null; children: ReactNode;
}) {
  const client = useQueryClient();
  const [error, setError] = useState(false);
  const scope = useMemo(() => ({ active: true, pending: null as Seen | null, seenIds: new Set<string>(), sentAt: -Infinity,
    busy: false, failures: 0, exhausted: false, retryTimer: null as ReturnType<typeof setTimeout> | null }), [issueId, companyId, userId]);
  const flush = useCallback(async function flush(): Promise<void> {
    if (!issueId || !scope.active || scope.busy || scope.retryTimer !== null || scope.exhausted) return;
    scope.busy = true;
    try {
      while (scope.active && scope.pending) {
        const next = scope.pending;
        try {
          await issuesApi.markRead(issueId, next.id);
        } catch (cause) {
          if (!scope.active) return;
          const retryable = !(cause instanceof ApiError) || cause.status === 408 || cause.status === 429 || cause.status >= 500;
          const delay = READ_RETRY_DELAYS[scope.failures];
          if (retryable && delay !== undefined) {
            scope.failures += 1;
            scope.retryTimer = setTimeout(() => { scope.retryTimer = null; void flush(); },
              Math.max(delay, cause instanceof ApiError ? cause.retryAfterMs ?? 0 : 0));
          } else {
            scope.exhausted = true;
            setError(true);
          }
          return;
        }
        if (!scope.active) return;
        if (scope.pending?.id === next.id) scope.pending = null;
        scope.sentAt = Math.max(scope.sentAt, next.at);
        scope.failures = 0;
        setError(false);
        void client.invalidateQueries({ queryKey: queryKeys.agentChats.list(companyId, userId) });
        void client.invalidateQueries({ queryKey: ["agent-chat", companyId, userId] });
      }
    } finally { scope.busy = false; }
  }, [issueId, companyId, userId, client, scope]);
  useEffect(() => {
    scope.active = true;
    setError(false);
    if (scope.pending) {
      scope.exhausted = false;
      scope.failures = 0;
      queueMicrotask(() => { void flush(); });
    }
    return () => {
      scope.active = false;
      if (scope.retryTimer !== null) { clearTimeout(scope.retryTimer); scope.retryTimer = null; }
    };
  }, [scope, flush]);
  useEffect(() => {
    const retry = () => {
      if (document.visibilityState !== "visible" || !scope.active || !scope.exhausted || !scope.pending) return;
      scope.exhausted = false;
      scope.failures = 0;
      setError(false);
      void flush();
    };
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [scope, flush]);
  const seen = useCallback((message: Seen) => {
    if (!issueId || !scope.active || scope.seenIds.has(message.id) || message.at < scope.sentAt) return;
    scope.seenIds.add(message.id);
    if (!scope.pending || message.at >= scope.pending.at) scope.pending = message;
    if (scope.exhausted) { scope.exhausted = false; scope.failures = 0; setError(false); }
    if (!scope.busy && scope.retryTimer === null) queueMicrotask(() => { void flush(); });
  }, [issueId, scope, flush]);
  return <ChatReadContext.Provider value={issueId ? seen : null}>
    {error && <p role="alert" className="text-sm text-destructive">Couldn’t mark this chat read.</p>}
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
