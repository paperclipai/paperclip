import { TranscriptSequence } from "../../lib/transcript-sequence";
import { readTranscriptRequest } from "../transcript/read-transcript-request";
import { useTranscriptLiveStream } from "../../context/LiveUpdatesProvider";
import { liveRunEvent, mergeRunEvents } from "../../lib/live-run-event";
import { mergeRunLogChunks, readChunkSeq } from "../../lib/run-log-chunks";
import { usePageVisibility } from "../../lib/page-visibility";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../../api/heartbeats";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { ApiError } from "../../api/api-error";
import { queryKeys } from "../../lib/queryKeys";
import { toolsApi } from "../../api/tools";
import { getUIAdapter, buildTranscript, onAdapterChange } from "../../adapters";
import { cn } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { RunTranscriptView, type TranscriptMode } from "../transcript/RunTranscriptView";
import { LIVE_TRANSCRIPT_RENDER_LIMIT, MAX_LIVE_EVENTS, MAX_LIVE_LOG_LINES } from "../../lib/live-log-buffer";
import { type HeartbeatRun, type HeartbeatRunEvent } from "@paperclipai/shared";
import {
  type RunLogChunk,
  type ScrollContainer,
  shouldPollRunShellLog,
  asRecord,
  asNonEmptyString,
  buildHeartbeatProgressLogLine,
  heartbeatProgressLogLineKey,
  findScrollContainer,
  readScrollMetrics,
  LIVE_SCROLL_BOTTOM_TOLERANCE_PX,
  scrollToContainerBottom,
  RUN_LOG_PAGE_BYTES,
  redactPathValue,
  WorkspaceOperationsSection,
  RunInvocationCard,
  redactPathText,
} from "./RunDetails";

export function LogViewer({ run, adapterType }: { run: HeartbeatRun; adapterType: string }) {
  const { visible } = usePageVisibility();
  const [events, setEvents] = useState<HeartbeatRunEvent[]>([]);
  const [hasMoreEvents, setHasMoreEvents] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const hasMoreEventsRef = useRef(false);
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false);
  const loadMoreEventsRef = useRef<(() => void) | null>(null);
  const [logLines, setLogLines] = useState<RunLogChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [logLoading, setLogLoading] = useState(!!run.logRef);
  const [logError, setLogError] = useState<string | null>(null);
  const [logOffset, setLogOffsetState] = useState(0);
  const logOffsetRef = useRef(0);
  const setLogOffset = useCallback((next: number | ((previous: number) => number)) => {
    logOffsetRef.current = typeof next === "function" ? next(logOffsetRef.current) : next;
    setLogOffsetState(logOffsetRef.current);
  }, []);
  const logMergeRefs = useRef({ seenChunkKeys: new Set<string>(), trimmedSeqFloorByRun: new Map<string, number>() });
  const [hasMoreLog, setHasMoreLog] = useState(false);
  const [loadingMoreLog, setLoadingMoreLog] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("nice");
  const logEndRef = useRef<HTMLDivElement>(null);
  const pendingLogLineRef = useRef("");
  const seenProgressLogLineKeysRef = useRef<Set<string>>(new Set());
  const scrollContainerRef = useRef<ScrollContainer | null>(null);
  const isFollowingRef = useRef(false);
  const lastMetricsRef = useRef<{ scrollHeight: number; distanceFromBottom: number }>({
    scrollHeight: 0,
    distanceFromBottom: Number.POSITIVE_INFINITY,
  });
  const isLive = run.status === "running" || run.status === "queued";
  const shouldPollShellLog = shouldPollRunShellLog(run.status);
  const { data: workspaceOperations = [] } = useQuery({
    queryKey: queryKeys.runWorkspaceOperations(run.id),
    queryFn: () => heartbeatsApi.workspaceOperations(run.id),
    refetchInterval: isLive ? 2000 : false,
  });

  function isRunLogUnavailable(err: unknown): boolean {
    return err instanceof ApiError && err.status === 404;
  }

  function appendLogLines(incoming: RunLogChunk[]) {
    setLogLines((previous) => mergeRunLogChunks(run.id, previous, incoming.map((line) => ({
      ...line, dedupeKey: `log:${run.id}:${line.ts}:${line.stream}:${line.chunk}`,
    })), logMergeRefs.current, isLive ? MAX_LIVE_LOG_LINES : Number.POSITIVE_INFINITY).chunks);
  }

  function appendLogContent(content: string, finalize = false) {
    if (!content && !finalize) return;
    const combined = `${pendingLogLineRef.current}${content}`;
    const split = combined.split("\n");
    pendingLogLineRef.current = split.pop() ?? "";
    if (finalize && pendingLogLineRef.current) {
      split.push(pendingLogLineRef.current);
      pendingLogLineRef.current = "";
    }

    const parsed: RunLogChunk[] = [];
    for (const line of split) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown; seq?: unknown };
        const stream =
          raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
        const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
        const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
        if (!chunk) continue;
        const seq = readChunkSeq(raw.seq);
        logSequenceRef.current.confirm(seq);
        parsed.push({ ts, stream, chunk, seq });
      } catch {
        // ignore malformed lines
      }
    }

    if (parsed.length > 0) {
      // Live runs stream forever, so cap the retained tail. Terminated runs are
      // paginated by the user via "Load more log" and keep their full history.
      appendLogLines(parsed);
    }
  }

  const refreshEventsRef = useRef<((force?: boolean) => void) | null>(null);
  const refreshLogRef = useRef<((force?: boolean) => void) | null>(null);
  const eventSequenceRef = useRef(new TranscriptSequence());
  const logSequenceRef = useRef(new TranscriptSequence());
  const eventsReadCursorRef = useRef(0);
  const eventsCatchupCursorRef = useRef(0);
  const retainedEventHistoryThroughRef = useRef(0);
  const logIdentityRef = useRef<string | null>(run.logRef ?? null);
  const retiredLogRefs = useRef(new Set<string>());
  const wasLiveRef = useRef(isLive);
  const bindLog = (ref: unknown): "same" | "changed" | "stale" => {
    if (typeof ref !== "string" || !ref || ref === logIdentityRef.current) return "same";
    if (retiredLogRefs.current.has(ref)) return "stale";
    const prior = logIdentityRef.current;
    logIdentityRef.current = ref;
    if (!prior) return "same";
    retiredLogRefs.current.add(prior);
    if (retiredLogRefs.current.size > 8) retiredLogRefs.current.delete(retiredLogRefs.current.values().next().value!);
    pendingLogLineRef.current = "";
    logMergeRefs.current = { seenChunkKeys: new Set(), trimmedSeqFloorByRun: new Map() };
    logSequenceRef.current = new TranscriptSequence();
    setLogLines([]); setLogOffset(0);
    return "changed";
  };
  useEffect(() => {
    eventsReadCursorRef.current = 0; eventsCatchupCursorRef.current = 0; retainedEventHistoryThroughRef.current = 0; eventSequenceRef.current = new TranscriptSequence(); logSequenceRef.current = new TranscriptSequence();
    wasLiveRef.current = isLive;
    logIdentityRef.current = run.logRef ?? null; retiredLogRefs.current.clear();
    hasMoreEventsRef.current = false; setHasMoreEvents(false); setLoadingMoreEvents(false); setEventsError(null);
    setEvents([]); setLoading(true);
  }, [run.id, run.companyId]);
  useEffect(() => { if (isLive) wasLiveRef.current = true; }, [isLive]);

  function appendEvents(rows: HeartbeatRunEvent[], retainHistory = false) {
    if (retainHistory) retainedEventHistoryThroughRef.current = Math.max(
      retainedEventHistoryThroughRef.current, rows.at(-1)?.seq ?? 0,
    );
    setEvents(previous => {
      const merged = mergeRunEvents(previous, rows);
      if (!isLive && !wasLiveRef.current) return merged;
      const retainedThrough = Math.max(200, retainedEventHistoryThroughRef.current);
      const prefix = merged.filter(row => row.seq <= retainedThrough);
      const tail = merged.filter(row => row.seq > retainedThrough);
      return [...prefix, ...tail.slice(-MAX_LIVE_EVENTS)];
    });
  }

  const stream = useTranscriptLiveStream(isLive ? [run.id] : [], { companyId: run.companyId, enabled: visible }, event => {
    if (event.companyId !== run.companyId) return;
    const payload = asRecord(event.payload);
    if (!payload || payload.runId !== run.id) return;
    if (event.type === "heartbeat.run.log") {
      const binding = bindLog(payload.logRef);
      if (binding === "stale") return;
      const seq = readChunkSeq(payload.seq);
      if (payload.truncated === true) logSequenceRef.current.requireHistory(seq);
      const gap = logSequenceRef.current.observe(seq);
      if (binding === "changed" || payload.truncated === true || gap) refreshLogRef.current?.();
      if (payload.truncated === true) return;
      const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
      if (!chunk) return;
      const channel = payload.stream === "stderr" || payload.stream === "system" ? payload.stream : "stdout";
      appendLogLines([{ ts: asNonEmptyString(payload.ts) ?? event.createdAt, stream: channel, chunk, seq }]);
      return;
    }
    if (event.type === "heartbeat.run.progress") {
      const line = buildHeartbeatProgressLogLine(payload, event.createdAt);
      if (!line) return;
      const key = heartbeatProgressLogLineKey(line);
      if (seenProgressLogLineKeysRef.current.has(key)) return;
      seenProgressLogLineKeysRef.current.add(key); appendLogLines([line]);
      return;
    }
    if (event.type === "heartbeat.run.status") {
      refreshEventsRef.current?.(true); refreshLogRef.current?.(true); return;
    }
    const row = liveRunEvent(event);
    if (!row) return;
    const commitSignal = row.message === null && row.payload === null;
    if (commitSignal) eventSequenceRef.current.requireHistory(row.seq);
    if (eventSequenceRef.current.observe(row.seq)) refreshEventsRef.current?.();
    if (commitSignal) return;
    appendEvents([row]);
  });

  useEffect(() => {
    setLoadingMoreEvents(false);
    if (!visible) return;
    let cancelled = false;
    let timer: number | undefined;
    const abort = new AbortController();
    let reading = false;
    let pendingRefresh = false;
    let failedRead: { requested: boolean; catchup: boolean } | null = null;
    const read = async (requested = false, catchup = false) => {
      if (cancelled) return;
      if (reading) { if (catchup) pendingRefresh = true; return; }
      if (hasMoreEventsRef.current && !requested && !catchup) return;
      reading = true; pendingRefresh = false; setLoadingMoreEvents(true); setEventsError(null);
      window.clearTimeout(timer); timer = undefined;
      let failed = false;
      try {
        const cursor = catchup ? Math.max(eventsCatchupCursorRef.current, eventsReadCursorRef.current) : eventsReadCursorRef.current;
        const initializesHistory = eventsReadCursorRef.current === 0;
        const rows = await readTranscriptRequest(signal => heartbeatsApi.events(run.id, cursor, 1000, { signal }), abort.signal);
        if (cancelled) return;
        appendEvents(rows, !catchup || initializesHistory);
        const next = Math.max(cursor, rows.at(-1)?.seq ?? cursor);
        eventsCatchupCursorRef.current = Math.max(eventsCatchupCursorRef.current, next);
        eventSequenceRef.current.confirm(next);
        if (catchup) {
          if (rows.length === 1000 && next > cursor) pendingRefresh = true;
        }
        if (!catchup || initializesHistory) {
          eventsReadCursorRef.current = next;
          hasMoreEventsRef.current = rows.length === 1000 && next > cursor;
          setHasMoreEvents(hasMoreEventsRef.current);
        }
        failed = eventSequenceRef.current.needsCatchup;
        failedRead = null;
      } catch {
        failed = true; failedRead = { requested, catchup };
        if (!cancelled) setEventsError("Could not load events. Try again.");
      }
      if (cancelled) return;
      reading = false; setLoadingMoreEvents(false); setLoading(false);
      if (pendingRefresh) void read(false, true);
      else if (failed || (isLive && !stream.healthy && !hasMoreEventsRef.current)) {
        timer = window.setTimeout(() => void read(requested, catchup || eventSequenceRef.current.needsCatchup), 2000);
      }
    };
    refreshEventsRef.current = () => { void read(false, wasLiveRef.current); };
    loadMoreEventsRef.current = () => { void read(failedRead?.requested ?? true, failedRead?.catchup ?? false); };
    void read(false, wasLiveRef.current && (stream.healthy || eventsReadCursorRef.current > 0));
    return () => {
      cancelled = true; refreshEventsRef.current = null; loadMoreEventsRef.current = null;
      abort.abort(); if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [visible, run.id, run.companyId, run.status, stream.healthy, stream.epoch]);

  const getScrollContainer = useCallback((): ScrollContainer => {
    if (scrollContainerRef.current) return scrollContainerRef.current;
    const container = findScrollContainer(logEndRef.current);
    scrollContainerRef.current = container;
    return container;
  }, []);

  const updateFollowingState = useCallback(() => {
    const container = getScrollContainer();
    const metrics = readScrollMetrics(container);
    lastMetricsRef.current = metrics;
    const nearBottom = metrics.distanceFromBottom <= LIVE_SCROLL_BOTTOM_TOLERANCE_PX;
    isFollowingRef.current = nearBottom;
    setIsFollowing((prev) => (prev === nearBottom ? prev : nearBottom));
  }, [getScrollContainer]);

  useEffect(() => {
    scrollContainerRef.current = null;
    lastMetricsRef.current = {
      scrollHeight: 0,
      distanceFromBottom: Number.POSITIVE_INFINITY,
    };

    if (!isLive) {
      isFollowingRef.current = false;
      setIsFollowing(false);
      return;
    }

    updateFollowingState();
  }, [isLive, run.id, updateFollowingState]);

  useEffect(() => {
    if (!isLive) return;
    const container = getScrollContainer();
    updateFollowingState();

    if (container === window) {
      window.addEventListener("scroll", updateFollowingState, { passive: true });
    } else {
      container.addEventListener("scroll", updateFollowingState, { passive: true });
    }
    window.addEventListener("resize", updateFollowingState);
    return () => {
      if (container === window) {
        window.removeEventListener("scroll", updateFollowingState);
      } else {
        container.removeEventListener("scroll", updateFollowingState);
      }
      window.removeEventListener("resize", updateFollowingState);
    };
  }, [isLive, run.id, getScrollContainer, updateFollowingState]);

  // Auto-scroll only for live runs when following
  useEffect(() => {
    if (!isLive || !isFollowingRef.current) return;

    const container = getScrollContainer();
    const previous = lastMetricsRef.current;
    const current = readScrollMetrics(container);
    const growth = Math.max(0, current.scrollHeight - previous.scrollHeight);
    const expectedDistance = previous.distanceFromBottom + growth;
    const movedAwayBy = current.distanceFromBottom - expectedDistance;

    // If user moved away from bottom between updates, release auto-follow immediately.
    if (movedAwayBy > LIVE_SCROLL_BOTTOM_TOLERANCE_PX) {
      isFollowingRef.current = false;
      setIsFollowing(false);
      lastMetricsRef.current = current;
      return;
    }

    scrollToContainerBottom(container, "auto");
    const after = readScrollMetrics(container);
    lastMetricsRef.current = after;
    if (!isFollowingRef.current) {
      isFollowingRef.current = true;
    }
    setIsFollowing((prev) => (prev ? prev : true));
  }, [events.length, logLines.length, isLive, getScrollContainer]);

  // Reset only when the log source changes, never when visibility changes.
  useEffect(() => {
    pendingLogLineRef.current = "";
    logMergeRefs.current = { seenChunkKeys: new Set(), trimmedSeqFloorByRun: new Map() };
    seenProgressLogLineKeysRef.current = new Set();
    setLogLines([]);
    setLogOffset(0);
    setHasMoreLog(false);
    setLoadingMoreLog(false);
    setLogError(null);
  }, [run.id, run.logRef, setLogOffset]);

  useEffect(() => {
    if (!visible) return;
    if (!run.logRef && !shouldPollShellLog) { setLogLoading(false); return; }
    let cancelled = false;
    let timer: number | undefined;
    const abort = new AbortController();
    setLogLoading(true);
    let reading = false;
    let pendingRefresh = false;
    const load = async () => {
      if (cancelled || reading) return;
      reading = true; pendingRefresh = false;
      window.clearTimeout(timer); timer = undefined;
      let failed = false;
      try {
        for (;;) {
          const offset = logOffsetRef.current;
          const result = await readTranscriptRequest(signal => heartbeatsApi.log(run.id, offset, RUN_LOG_PAGE_BYTES, { signal }), abort.signal);
          if (cancelled) return;
          const binding = bindLog(result.logRef);
          if (binding === "stale") { failed = true; break; }
          if (binding === "changed" && offset !== 0) continue;
          appendLogContent(result.content, result.nextOffset === undefined);
          const next = result.nextOffset ?? offset + new TextEncoder().encode(result.content).byteLength;
          setLogOffset(next); setLogError(null);
          setHasMoreLog(!wasLiveRef.current && result.nextOffset !== undefined && !!result.content);
          if (!wasLiveRef.current || result.nextOffset === undefined || !result.content || next <= offset) break;
        }
        failed ||= logSequenceRef.current.needsCatchup;
      } catch (err) {
        if (cancelled) return;
        failed = shouldPollShellLog || !isRunLogUnavailable(err);
        if (!isRunLogUnavailable(err)) setLogError(err instanceof Error ? err.message : "Failed to load run log");
      }
      if (cancelled) return;
      reading = false;
      setLogLoading(false);
      if (pendingRefresh) void load();
      else if (failed || (shouldPollShellLog && !stream.healthy)) timer = window.setTimeout(() => void load(), 2000);
    };
    refreshLogRef.current = (force = false) => { if (force) pendingRefresh = true; void load(); };
    void load();
    return () => { cancelled = true; refreshLogRef.current = null; abort.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [visible, run.id, run.companyId, run.logRef, isLive ? null : run.logBytes, shouldPollShellLog, stream.healthy, stream.epoch]);

  async function loadMorePersistedLog() {
    if (loadingMoreLog || !hasMoreLog) return;
    setLoadingMoreLog(true);
    setLogError(null);
    try {
      const result = await heartbeatsApi.log(run.id, logOffset, RUN_LOG_PAGE_BYTES);
      appendLogContent(result.content, result.nextOffset === undefined);
      const next = result.nextOffset ?? logOffset + new TextEncoder().encode(result.content).byteLength;
      setLogOffset(next);
      setHasMoreLog(result.nextOffset !== undefined);
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Failed to load more run log");
    } finally {
      setLoadingMoreLog(false);
    }
  }

  const censorUsernameInLogs = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  }).data?.censorUsernameInLogs === true;

  const adapterInvokePayload = useMemo(() => {
    const evt = events.find((e) => e.eventType === "adapter.invoke");
    return redactPathValue(asRecord(evt?.payload ?? null), censorUsernameInLogs);
  }, [censorUsernameInLogs, events]);

  // NOTE: adapter is NOT memoized because external adapters replace their
  // parseStdoutLine asynchronously after dynamic parser loading. Memoizing
  // on adapterType alone would stale the transcript with the fallback parser.
  // We subscribe to adapter registry changes to force transcript recomputation.
  const [parserTick, setParserTick] = useState(0);
  const adapter = getUIAdapter(adapterType);

  useEffect(() => {
    return onAdapterChange(() => setParserTick((t) => t + 1));
  }, []);

  const transcript = useMemo(
    () => buildTranscript(logLines, adapter, { censorUsernameInLogs }),
    [adapter, censorUsernameInLogs, logLines, parserTick],
  );
  const toolDecisionLookup = useQuery({
    queryKey: queryKeys.tools.runDecisions(run.companyId, run.id),
    queryFn: () => toolsApi.getRunDecisionLookup(run.companyId, run.id),
    enabled: Boolean(run.companyId && run.id),
    refetchInterval: isLive ? 3000 : false,
    staleTime: isLive ? 1000 : 30_000,
  });

  useEffect(() => {
    setTranscriptMode("nice");
  }, [run.id]);

  if (loading && logLoading) {
    return <p className="text-xs text-muted-foreground">Loading run logs...</p>;
  }

  if (events.length === 0 && logLines.length === 0 && !logError && !eventsError) {
    return <p className="text-xs text-muted-foreground">No log events.</p>;
  }

  const levelColors: Record<string, string> = {
    info: "text-foreground",
    warn: "text-yellow-600 dark:text-yellow-400",
    error: "text-red-600 dark:text-red-400",
  };

  const streamColors: Record<string, string> = {
    stdout: "text-foreground",
    stderr: "text-red-600 dark:text-red-300",
    system: "text-blue-600 dark:text-blue-300",
  };

  return (
    <div className="space-y-3">
      <WorkspaceOperationsSection
        operations={workspaceOperations}
        censorUsernameInLogs={censorUsernameInLogs}
      />
      {adapterInvokePayload && (
        <RunInvocationCard payload={adapterInvokePayload} censorUsernameInLogs={censorUsernameInLogs} />
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Transcript ({transcript.length})
        </span>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-border/70 bg-background/70 p-0.5">
            {(["nice", "raw"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={cn(
                  "rounded-md px-2.5 py-1 text-(length:--text-micro) font-medium capitalize transition-colors",
                  transcriptMode === mode
                    ? "bg-accent text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setTranscriptMode(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
          {isLive && !isFollowing && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                const container = getScrollContainer();
                isFollowingRef.current = true;
                setIsFollowing(true);
                scrollToContainerBottom(container, "auto");
                lastMetricsRef.current = readScrollMetrics(container);
              }}
            >
              Jump to live
            </Button>
          )}
          {isLive && (
            <span className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              Live
            </span>
          )}
        </div>
      </div>
      <div className="max-h-(--sz-38rem) overflow-y-auto rounded-2xl border border-border/70 bg-background/40 p-3 sm:p-4">
        <RunTranscriptView
          entries={transcript}
          toolDecisions={toolDecisionLookup.data?.decisions ?? []}
          mode={transcriptMode}
          streaming={isLive}
          limit={isLive ? LIVE_TRANSCRIPT_RENDER_LIMIT : undefined}
          emptyMessage={run.logRef ? "Waiting for transcript..." : "No persisted transcript for this run."}
        />
        {hasMoreLog && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={loadMorePersistedLog}
              disabled={loadingMoreLog}
            >
              {loadingMoreLog ? "Loading..." : "Load more log"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Showing the first {Math.round(logOffset / 1024).toLocaleString("en-US")} KB
              {typeof run.logBytes === "number" && run.logBytes > 0
                ? ` of ${Math.round(run.logBytes / 1024).toLocaleString("en-US")} KB`
                : ""}
            </span>
          </div>
        )}
        {logError && (
          <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-300">
            {logError}
          </div>
        )}
        <div ref={logEndRef} />
      </div>

      {(run.status === "failed" || run.status === "timed_out") && (
        <div className="rounded-lg border border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-950/20 p-3 space-y-2">
          <div className="text-xs font-medium text-red-700 dark:text-red-300">Failure details</div>
          {run.error && (
            <div className="text-xs text-red-600 dark:text-red-200">
              <span className="text-red-700 dark:text-red-300">Error: </span>
              {redactPathText(run.error, censorUsernameInLogs)}
            </div>
          )}
          {run.stderrExcerpt && run.stderrExcerpt.trim() && (
            <div>
              <div className="text-xs text-red-700 dark:text-red-300 mb-1">stderr excerpt</div>
              <pre className="bg-red-50 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap text-red-800 dark:text-red-100">
                {redactPathText(run.stderrExcerpt, censorUsernameInLogs)}
              </pre>
            </div>
          )}
          {run.resultJson && (
            <div>
              <div className="text-xs text-red-700 dark:text-red-300 mb-1">adapter result JSON</div>
              <pre className="bg-red-50 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap text-red-800 dark:text-red-100">
                {JSON.stringify(redactPathValue(run.resultJson, censorUsernameInLogs), null, 2)}
              </pre>
            </div>
          )}
          {run.stdoutExcerpt && run.stdoutExcerpt.trim() && !run.resultJson && (
            <div>
              <div className="text-xs text-red-700 dark:text-red-300 mb-1">stdout excerpt</div>
              <pre className="bg-red-50 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap text-red-800 dark:text-red-100">
                {redactPathText(run.stdoutExcerpt, censorUsernameInLogs)}
              </pre>
            </div>
          )}
        </div>
      )}

      {(events.length > 0 || eventsError) && (
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">Events ({events.length})</div>
          {eventsError && <p className="text-sm text-destructive">{eventsError}</p>}
          {(hasMoreEvents || eventsError) && (
            <Button variant="outline" size="sm" disabled={loadingMoreEvents} onClick={() => loadMoreEventsRef.current?.()}>
              {loadingMoreEvents ? "Loading..." : eventsError ? "Retry events" : "Load more events"}
            </Button>
          )}
          <div className="bg-neutral-100 dark:bg-neutral-950 rounded-lg p-3 font-mono text-xs space-y-0.5">
            {events.map((evt) => {
              const color = evt.color
                ?? (evt.level ? levelColors[evt.level] : null)
                ?? (evt.stream ? streamColors[evt.stream] : null)
                ?? "text-foreground";

              return (
                <div key={`${evt.runId}:${evt.seq}`} className="flex gap-2">
                  <span className="text-neutral-400 dark:text-neutral-600 shrink-0 select-none w-16">
                    {new Date(evt.createdAt).toLocaleTimeString("en-US", { hour12: false })}
                  </span>
                  <span className={cn("shrink-0 w-14", evt.stream ? (streamColors[evt.stream] ?? "text-neutral-500") : "text-neutral-500")}>
                    {evt.stream ? `[${evt.stream}]` : ""}
                  </span>
                  <span className={cn("break-all", color)}>
                    {evt.message
                      ? redactPathText(evt.message, censorUsernameInLogs)
                      : evt.payload
                        ? JSON.stringify(redactPathValue(evt.payload, censorUsernameInLogs))
                        : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
