import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LiveEvent } from "@paperclipai/shared";
import { heartbeatsApi, type RunTodo } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";

interface RunTodosWidgetProps {
  issueId: string;
  runId: string | null;
  companyId?: string | null;
  isActive?: boolean;
}

function TodoStatusIcon({ status }: { status: RunTodo["status"] }) {
  if (status === "completed") {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-cyan-500/20 text-cyan-600 dark:text-cyan-400">
        <svg viewBox="0 0 12 12" fill="none" className="h-2.5 w-2.5">
          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-cyan-500/50 bg-cyan-500/10">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-500" />
      </span>
    );
  }
  return <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border/60" />;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function RunTodosWidget({ issueId, runId, companyId, isActive }: RunTodosWidgetProps) {
  const queryClient = useQueryClient();
  const [liveTodos, setLiveTodos] = useState<RunTodo[] | null>(null);
  const seenEventIds = useRef(new Set<string>());

  const { data: fetchedTodos } = useQuery({
    queryKey: queryKeys.issues.runTodos(issueId),
    queryFn: () => heartbeatsApi.issueTodos(issueId),
    enabled: !!issueId,
    refetchInterval: isActive ? 5000 : false,
  });

  // Subscribe to live heartbeat.run.todos WebSocket events
  useEffect(() => {
    if (!companyId || !runId || !isActive) return;

    let closed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const scheduleReconnect = () => {
      if (closed) return;
      reconnectTimer = window.setTimeout(connect, 1500);
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
      socket = new WebSocket(url);

      socket.onmessage = (message) => {
        const raw = typeof message.data === "string" ? message.data : "";
        if (!raw) return;
        let event: LiveEvent;
        try {
          event = JSON.parse(raw) as LiveEvent;
        } catch {
          return;
        }
        if (event.companyId !== companyId) return;
        if (event.type !== "heartbeat.run.todos") return;

        const payload = event.payload ?? {};
        const eventRunId = readString(payload["runId"]);
        if (eventRunId !== runId) return;

        const eventKey = `${runId}:${event.id}`;
        if (seenEventIds.current.has(eventKey)) return;
        seenEventIds.current.add(eventKey);

        const rawTodos = Array.isArray(payload["todos"]) ? payload["todos"] : [];
        const parsed: RunTodo[] = rawTodos
          .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
          .map((t) => ({
            id: String(t.id ?? ""),
            runId: runId,
            agentId: String(t.agentId ?? ""),
            issueId: issueId,
            label: String(t.label ?? ""),
            status: (["pending", "in_progress", "completed"].includes(String(t.status))
              ? t.status
              : "pending") as RunTodo["status"],
            seq: typeof t.seq === "number" ? t.seq : 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));

        if (parsed.length > 0) {
          setLiveTodos(parsed);
          queryClient.invalidateQueries({ queryKey: queryKeys.issues.runTodos(issueId) });
        }
      };

      socket.onerror = () => {
        socket?.close();
      };

      socket.onclose = () => {
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [companyId, runId, issueId, isActive, queryClient]);

  const todos = liveTodos ?? fetchedTodos ?? [];
  if (todos.length === 0) return null;

  const completedCount = todos.filter((t) => t.status === "completed").length;
  const totalCount = todos.length;

  return (
    <div className="rounded-lg border border-border/50 bg-background/60 px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">Tasks</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {completedCount}/{totalCount}
        </span>
      </div>

      {totalCount > 0 && (
        <div className="mb-2.5 h-1 w-full overflow-hidden rounded-full bg-border/50">
          <div
            className="h-full rounded-full bg-cyan-500/60 transition-all duration-500"
            style={{ width: `${Math.round((completedCount / totalCount) * 100)}%` }}
          />
        </div>
      )}

      <ul className="space-y-1.5">
        {todos.map((todo) => (
          <li key={todo.id || `${todo.seq}-${todo.label}`} className="flex items-start gap-2">
            <TodoStatusIcon status={todo.status} />
            <span
              className={`text-xs leading-tight ${
                todo.status === "completed"
                  ? "text-muted-foreground line-through"
                  : todo.status === "in_progress"
                    ? "text-foreground"
                    : "text-muted-foreground"
              }`}
            >
              {todo.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
