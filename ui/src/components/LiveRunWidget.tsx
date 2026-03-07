import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Link } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LiveEvent } from "@paperclipai/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { getUIAdapter } from "../adapters";
import type { TranscriptEntry } from "../adapters";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime, formatDateTime } from "../lib/utils";
import { ExternalLink, Square } from "lucide-react";
import { Identity } from "./Identity";
import { StatusBadge } from "./StatusBadge";

interface LiveRunWidgetProps {
  issueId: string;
  companyId?: string | null;
}

type FeedTone = "info" | "warn" | "error" | "assistant" | "tool";

interface FeedItem {
  id: string;
  ts: string;
  runId: string;
  agentId: string;
  agentName: string;
  text: string;
  tone: FeedTone;
  dedupeKey: string;
  streamingKind?: "assistant" | "thinking";
}

const MAX_FEED_ITEMS = 80;
const MAX_FEED_TEXT_LENGTH = 220;
const MAX_STREAMING_TEXT_LENGTH = 4000;
const LOG_POLL_INTERVAL_MS = 2000;
const LOG_READ_LIMIT_BYTES = 256_000;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function summarizeEntry(entry: TranscriptEntry): { text: string; tone: FeedTone } | null {
  if (entry.kind === "assistant") {
    const text = entry.text.trim();
    return text ? { text, tone: "assistant" } : null;
  }
  if (entry.kind === "thinking") {
    const text = entry.text.trim();
    return text ? { text: `[thinking] ${text}`, tone: "info" } : null;
  }
  if (entry.kind === "tool_call") {
    return { text: `tool ${entry.name}`, tone: "tool" };
  }
  if (entry.kind === "tool_result") {
    const base = entry.content.trim();
    return {
      text: entry.isError ? `tool error: ${base}` : `tool result: ${base}`,
      tone: entry.isError ? "error" : "tool",
    };
  }
  if (entry.kind === "stderr") {
    const text = entry.text.trim();
    return text ? { text, tone: "error" } : null;
  }
  if (entry.kind === "system") {
    const text = entry.text.trim();
    return text ? { text, tone: "warn" } : null;
  }
  if (entry.kind === "stdout") {
    const text = entry.text.trim();
    return text ? { text, tone: "info" } : null;
  }
  return null;
}

function createFeedItem(
  run: LiveRunForIssue,
  ts: string,
  text: string,
  tone: FeedTone,
  nextId: number,
  options?: {
    streamingKind?: "assistant" | "thinking";
    preserveWhitespace?: boolean;
  },
): FeedItem | null {
  if (!text.trim()) return null;
  const base = options?.preserveWhitespace ? text : text.trim();
  const maxLength = options?.streamingKind ? MAX_STREAMING_TEXT_LENGTH : MAX_FEED_TEXT_LENGTH;
  const normalized = base.length > maxLength ? base.slice(-maxLength) : base;
  return {
    id: `${run.id}:${nextId}`,
    ts,
    runId: run.id,
    agentId: run.agentId,
    agentName: run.agentName,
    text: normalized,
    tone,
    dedupeKey: `feed:${run.id}:${ts}:${tone}:${normalized}`,
    streamingKind: options?.streamingKind,
  };
}

function parseStdoutChunk(
  run: LiveRunForIssue,
  chunk: string,
  ts: string,
  pendingByRun: Map<string, string>,
  nextIdRef: MutableRefObject<number>,
): FeedItem[] {
  const pendingKey = `${run.id}:stdout`;
  const combined = `${pendingByRun.get(pendingKey) ?? ""}${chunk}`;
  const split = combined.split(/\r?\n/);
  pendingByRun.set(pendingKey, split.pop() ?? "");
  const adapter = getUIAdapter(run.adapterType);

  const summarized: Array<{ text: string; tone: FeedTone; streamingKind?: "assistant" | "thinking" }> = [];
  const appendSummary = (entry: TranscriptEntry) => {
    if (entry.kind === "assistant" && entry.delta) {
      const text = entry.text;
      if (!text.trim()) return;
      const last = summarized[summarized.length - 1];
      if (last && last.streamingKind === "assistant") {
        last.text += text;
      } else {
        summarized.push({ text, tone: "assistant", streamingKind: "assistant" });
      }
      return;
    }

    if (entry.kind === "thinking" && entry.delta) {
      const text = entry.text;
      if (!text.trim()) return;
      const last = summarized[summarized.length - 1];
      if (last && last.streamingKind === "thinking") {
        last.text += text;
      } else {
        summarized.push({ text: `[thinking] ${text}`, tone: "info", streamingKind: "thinking" });
      }
      return;
    }

    const summary = summarizeEntry(entry);
    if (!summary) return;
    summarized.push({ text: summary.text, tone: summary.tone });
  };

  const items: FeedItem[] = [];
  for (const line of split.slice(-8)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = adapter.parseStdoutLine(trimmed, ts);
    if (parsed.length === 0) {
      if (run.adapterType === "openclaw") {
        continue;
      }
      const fallback = createFeedItem(run, ts, trimmed, "info", nextIdRef.current++);
      if (fallback) items.push(fallback);
      continue;
    }
    for (const entry of parsed) {
      appendSummary(entry);
    }
  }

  for (const summary of summarized) {
    const item = createFeedItem(run, ts, summary.text, summary.tone, nextIdRef.current++, {
      streamingKind: summary.streamingKind,
      preserveWhitespace: !!summary.streamingKind,
    });
    if (item) items.push(item);
  }

  return items;
}

function parseStderrChunk(
  run: LiveRunForIssue,
  chunk: string,
  ts: string,
  pendingByRun: Map<string, string>,
  nextIdRef: MutableRefObject<number>,
): FeedItem[] {
  const pendingKey = `${run.id}:stderr`;
  const combined = `${pendingByRun.get(pendingKey) ?? ""}${chunk}`;
  const split = combined.split(/\r?\n/);
  pendingByRun.set(pendingKey, split.pop() ?? "");

  const items: FeedItem[] = [];
  for (const line of split.slice(-8)) {
    const item = createFeedItem(run, ts, line, "error", nextIdRef.current++);
    if (item) items.push(item);
  }
  return items;
}

function parsePersistedLogContent(
  runId: string,
  content: string,
  pendingByRun: Map<string, string>,
): Array<{ ts: string; stream: "stdout" | "stderr" | "system"; chunk: string }> {
  if (!content) return [];

  const pendingKey = `${runId}:records`;
  const combined = `${pendingByRun.get(pendingKey) ?? ""}${content}`;
  const split = combined.split("\n");
  pendingByRun.set(pendingKey, split.pop() ?? "");

  const parsed: Array<{ ts: string; stream: "stdout" | "stderr" | "system"; chunk: string }> = [];
  for (const line of split) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
      const stream = raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
      if (!chunk) continue;
      parsed.push({ ts, stream, chunk });
    } catch {
      // Ignore malformed log rows.
    }
  }

  return parsed;
}

export function LiveRunWidget({ issueId, companyId }: LiveRunWidgetProps) {
  const queryClient = useQueryClient();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [cancellingRunIds, setCancellingRunIds] = useState(new Set<string>());
  const seenKeysRef = useRef(new Set<string>());
  const pendingByRunRef = useRef(new Map<string, string>());
  const pendingLogRowsByRunRef = useRef(new Map<string, string>());
  const logOffsetByRunRef = useRef(new Map<string, number>());
  const runMetaByIdRef = useRef(new Map<string, { agentId: string; agentName: string }>());
  const nextIdRef = useRef(1);
  const bodyRef = useRef<HTMLDivElement>(null);

  const handleCancelRun = async (runId: string) => {
    setCancellingRunIds((prev) => new Set(prev).add(runId));
    try {
      await heartbeatsApi.cancel(runId);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
    } finally {
      setCancellingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
    }
  };

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const runs = useMemo(() => {
    const deduped = new Map<string, LiveRunForIssue>();
    for (const run of liveRuns ?? []) {
      deduped.set(run.id, run);
    }
    if (activeRun) {
      deduped.set(activeRun.id, {
        id: activeRun.id,
        status: activeRun.status,
        invocationSource: activeRun.invocationSource,
        triggerDetail: activeRun.triggerDetail,
        startedAt: toIsoString(activeRun.startedAt),
        finishedAt: toIsoString(activeRun.finishedAt),
        createdAt: toIsoString(activeRun.createdAt) ?? new Date().toISOString(),
        agentId: activeRun.agentId,
        agentName: activeRun.agentName,
        adapterType: activeRun.adapterType,
        issueId,
      });
    }
    return [...deduped.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [activeRun, issueId, liveRuns]);

  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const activeRunIds = useMemo(() => new Set(runs.map((run) => run.id)), [runs]);
  const runIdsKey = useMemo(
    () => runs.map((run) => run.id).sort((a, b) => a.localeCompare(b)).join(","),
    [runs],
  );
  const appendItems = (items: FeedItem[]) => {
    if (items.length === 0) return;
    setFeed((prev) => {
      const next = [...prev];
      for (const item of items) {
        if (seenKeysRef.current.has(item.dedupeKey)) continue;
        seenKeysRef.current.add(item.dedupeKey);

        const last = next[next.length - 1];
        if (
          item.streamingKind &&
          last &&
          last.runId === item.runId &&
          last.streamingKind === item.streamingKind
        ) {
          const mergedText = `${last.text}${item.text}`;
          const nextText =
            mergedText.length > MAX_STREAMING_TEXT_LENGTH
              ? mergedText.slice(-MAX_STREAMING_TEXT_LENGTH)
              : mergedText;
          next[next.length - 1] = {
            ...last,
            ts: item.ts,
            text: nextText,
            dedupeKey: last.dedupeKey,
          };
          continue;
        }

        next.push(item);
      }
      if (seenKeysRef.current.size > 6000) {
        seenKeysRef.current.clear();
      }
      if (next.length === prev.length) return prev;
      return next.slice(-MAX_FEED_ITEMS);
    });
  };

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
  }, [feed.length]);

  useEffect(() => {
    for (const run of runs) {
      runMetaByIdRef.current.set(run.id, { agentId: run.agentId, agentName: run.agentName });
    }
  }, [runs]);

  useEffect(() => {
    const stillActive = new Set<string>();
    for (const runId of activeRunIds) {
      stillActive.add(`${runId}:stdout`);
      stillActive.add(`${runId}:stderr`);
    }
    for (const key of pendingByRunRef.current.keys()) {
      if (!stillActive.has(key)) {
        pendingByRunRef.current.delete(key);
      }
    }
    const liveRunIds = new Set(activeRunIds);
    for (const key of pendingLogRowsByRunRef.current.keys()) {
      const runId = key.replace(/:records$/, "");
      if (!liveRunIds.has(runId)) {
        pendingLogRowsByRunRef.current.delete(key);
      }
    }
    for (const runId of logOffsetByRunRef.current.keys()) {
      if (!liveRunIds.has(runId)) {
        logOffsetByRunRef.current.delete(runId);
      }
    }
  }, [activeRunIds]);

  useEffect(() => {
    if (runs.length === 0) return;

    let cancelled = false;

    const readRunLog = async (run: LiveRunForIssue) => {
      const offset = logOffsetByRunRef.current.get(run.id) ?? 0;
      try {
        const result = await heartbeatsApi.log(run.id, offset, LOG_READ_LIMIT_BYTES);
        if (cancelled) return;

        const rows = parsePersistedLogContent(run.id, result.content, pendingLogRowsByRunRef.current);
        const items: FeedItem[] = [];
        for (const row of rows) {
          if (row.stream === "stderr") {
            items.push(
              ...parseStderrChunk(run, row.chunk, row.ts, pendingByRunRef.current, nextIdRef),
            );
            continue;
          }
          if (row.stream === "system") {
            const item = createFeedItem(run, row.ts, row.chunk, "warn", nextIdRef.current++);
            if (item) items.push(item);
            continue;
          }
          items.push(
            ...parseStdoutChunk(run, row.chunk, row.ts, pendingByRunRef.current, nextIdRef),
          );
        }
        appendItems(items);

        if (result.nextOffset !== undefined) {
          logOffsetByRunRef.current.set(run.id, result.nextOffset);
          return;
        }
        if (result.content.length > 0) {
          logOffsetByRunRef.current.set(run.id, offset + result.content.length);
        }
      } catch {
        // Ignore log read errors while run output is initializing.
      }
    };

    const readAll = async () => {
      await Promise.all(runs.map((run) => readRunLog(run)));
    };

    void readAll();
    const interval = window.setInterval(() => {
      void readAll();
    }, LOG_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [runIdsKey, runs]);

  useEffect(() => {
    if (!companyId || activeRunIds.size === 0) return;

    let closed = false;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

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
        const payload = event.payload ?? {};
        const runId = readString(payload["runId"]);
        if (!runId || !activeRunIds.has(runId)) return;

        const run = runById.get(runId);
        if (!run) return;

        if (event.type === "heartbeat.run.event") {
          const seq = typeof payload["seq"] === "number" ? payload["seq"] : null;
          const eventType = readString(payload["eventType"]) ?? "event";
          const messageText = readString(payload["message"]) ?? eventType;
          const dedupeKey = `${runId}:event:${seq ?? `${eventType}:${messageText}:${event.createdAt}`}`;
          if (seenKeysRef.current.has(dedupeKey)) return;
          seenKeysRef.current.add(dedupeKey);
          if (seenKeysRef.current.size > 2000) {
            seenKeysRef.current.clear();
          }
          const tone = eventType === "error" ? "error" : eventType === "lifecycle" ? "warn" : "info";
          const item = createFeedItem(run, event.createdAt, messageText, tone, nextIdRef.current++);
          if (item) appendItems([item]);
          return;
        }

        if (event.type === "heartbeat.run.status") {
          const status = readString(payload["status"]) ?? "updated";
          const dedupeKey = `${runId}:status:${status}:${readString(payload["finishedAt"]) ?? ""}`;
          if (seenKeysRef.current.has(dedupeKey)) return;
          seenKeysRef.current.add(dedupeKey);
          if (seenKeysRef.current.size > 2000) {
            seenKeysRef.current.clear();
          }
          const tone = status === "failed" || status === "timed_out" ? "error" : "warn";
          const item = createFeedItem(run, event.createdAt, `run ${status}`, tone, nextIdRef.current++);
          if (item) appendItems([item]);
          return;
        }

        if (event.type === "heartbeat.run.log") {
          const chunk = readString(payload["chunk"]);
          if (!chunk) return;
          const stream = readString(payload["stream"]) === "stderr" ? "stderr" : "stdout";
          if (stream === "stderr") {
            appendItems(parseStderrChunk(run, chunk, event.createdAt, pendingByRunRef.current, nextIdRef));
            return;
          }
          appendItems(parseStdoutChunk(run, chunk, event.createdAt, pendingByRunRef.current, nextIdRef));
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
      if (socket) {
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close(1000, "issue_live_widget_unmount");
      }
    };
  }, [activeRunIds, companyId, runById]);

  if (runs.length === 0 && feed.length === 0) return null;

  const recent = feed.slice(-25);

  return (
    <div className="rounded-lg border border-cyan-500/30 bg-background/80 overflow-hidden shadow-[0_0_12px_rgba(6,182,212,0.08)]">
      {runs.length > 0 ? (
        runs.map((run) => (
          <div key={run.id} className="px-3 py-2 border-b border-border/50">
            <div className="flex items-center justify-between mb-2">
              <Link to={`/agents/${run.agentId}`} className="hover:underline">
                <Identity name={run.agentName} size="sm" />
              </Link>
              <span className="text-xs text-muted-foreground">
                {formatDateTime(run.startedAt ?? run.createdAt)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Run</span>
              <Link
                to={`/agents/${run.agentId}/runs/${run.id}`}
                className="inline-flex items-center rounded-md border border-border bg-accent/40 px-2 py-1 font-mono text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
              >
                {run.id.slice(0, 8)}
              </Link>
              <StatusBadge status={run.status} />
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => handleCancelRun(run.id)}
                  disabled={cancellingRunIds.has(run.id)}
                  className="inline-flex items-center gap-1 text-[10px] text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-50"
                >
                  <Square className="h-2 w-2" fill="currentColor" />
                  {cancellingRunIds.has(run.id) ? "Stopping…" : "Stop"}
                </button>
                <Link
                  to={`/agents/${run.agentId}/runs/${run.id}`}
                  className="inline-flex items-center gap-1 text-[10px] text-cyan-600 hover:text-cyan-500 dark:text-cyan-300 dark:hover:text-cyan-200"
                >
                  Open run
                  <ExternalLink className="h-2.5 w-2.5" />
                </Link>
              </div>
            </div>
          </div>
        ))
      ) : (
        <div className="flex items-center px-3 py-2 border-b border-border/50">
          <span className="text-xs font-medium text-muted-foreground">Recent run updates</span>
        </div>
      )}

      <div ref={bodyRef} className="max-h-[220px] overflow-y-auto p-2 font-mono text-[11px] space-y-1">
        {recent.length === 0 && (
          <div className="text-xs text-muted-foreground">Waiting for run output...</div>
        )}
        {recent.map((item, index) => (
          <div
            key={item.id}
            className={cn(
              "grid grid-cols-[auto_1fr] gap-2 items-start",
              index === recent.length - 1 && "animate-in fade-in slide-in-from-bottom-1 duration-300",
            )}
          >
            <span className="text-[10px] text-muted-foreground">{relativeTime(item.ts)}</span>
            <div className={cn(
              "min-w-0",
              item.tone === "error" && "text-red-600 dark:text-red-300",
              item.tone === "warn" && "text-amber-600 dark:text-amber-300",
              item.tone === "assistant" && "text-emerald-700 dark:text-emerald-200",
              item.tone === "tool" && "text-cyan-600 dark:text-cyan-300",
              item.tone === "info" && "text-foreground/80",
            )}>
              <Identity name={item.agentName} size="sm" className="text-cyan-600 dark:text-cyan-400" />
              <span className="text-muted-foreground"> [{item.runId.slice(0, 8)}] </span>
              <span className="break-words">{item.text}</span>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
