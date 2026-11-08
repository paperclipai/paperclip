import { useTranslation } from "@/i18n";
import { useResilientFetch } from "@/hooks/useResilientFetch";
import { QueryErrorState } from "@/components/QueryView";
import { isTransientError } from "@/api/errors";
import { useConnectivityStore } from "@/lib/connectivity";
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
  const { t } = useTranslation();
  const { visible } = usePageVisibility();
  const connection = useConnectivityStore();
  const [events, setEvents] = useState<HeartbeatRunEvent[]>([]);
  const [hasMoreEvents, setHasMoreEvents] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const hasMoreEventsRef = useRef(false);
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false);
  const loadMoreEventsRef = useRef<(() => void) | null>(null);
  const [logLines, setLogLines] = useState<RunLogChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [logOffset, setLogOffsetState] = useState(0);
  const logOffsetRef = useRef(0);
  const setLogOffset = useCallback((next: number | ((previous: number) => number)) => {
    logOffsetRef.current = typeof next === "function" ? next(logOffsetRef.current) : next;
    setLogOffsetState(logOffsetRef.current);
  }, []);
  const logMergeRefs = useRef({ seenChunkKeys: new Set<string>(), trimmedSeqFloorByRun: new Map<string, number>() });
  const [hasMoreLog, setHasMoreLog] = useState(false);
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
        setLoading(false);
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
      } catch (error) {
        failed = true; failedRead = { requested, catchup };
        connection.reportError(error);
        if (!cancelled && !isTransientError(error)) setEventsError(t("agents.LogViewer.eventsLoadError"));
      }
      if (cancelled) return;
      reading = false; setLoadingMoreEvents(false);
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
  }, [visible, run.id, run.companyId, run.status, stream.healthy, stream.epoch, t]);

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
  }, [run.id, run.logRef, setLogOffset]);

  const pendingLogRefresh = useRef(false);
  const logSourceEnabled = Boolean(run.logRef) || shouldPollShellLog;
  const persistedLog = useResilientFetch({
    key: ["run-log", run.companyId, run.id, run.logRef ?? null, isLive ? null : run.logBytes, shouldPollShellLog],
    enabled: visible && logSourceEnabled,
    refetchInterval: logSequenceRef.current.needsCatchup || (shouldPollShellLog && !stream.healthy) ? 2000 : false,
    fetcher: async (signal) => {
      const offset = logOffsetRef.current;
      try {
        const result = await readTranscriptRequest(signal => heartbeatsApi.log(run.id, offset, RUN_LOG_PAGE_BYTES, { signal }), signal);
        return { offset, result };
      } catch (error) {
        if (shouldPollShellLog && isRunLogUnavailable(error)) return { offset, result: null };
        throw error;
      }
    },
    onSuccess: ({ offset, result }) => {
      if (!result) return;
      const binding = bindLog(result.logRef);
      if (binding === "stale") return;
      if (binding === "changed" && offset !== 0) {
        queueMicrotask(() => persistedLog.refetch());
        return;
      }
      appendLogContent(result.content, result.nextOffset === undefined);
      const next = result.nextOffset ?? offset + new TextEncoder().encode(result.content).byteLength;
      setLogOffset(next);
      setHasMoreLog(!wasLiveRef.current && result.nextOffset !== undefined && !!result.content);
      if (pendingLogRefresh.current || (wasLiveRef.current && result.nextOffset !== undefined && !!result.content && next > offset)) {
        pendingLogRefresh.current = false;
        queueMicrotask(() => persistedLog.refetch());
      }
    },
  });
  const logLoading = logSourceEnabled && ["loading", "reconnecting"].includes(persistedLog.view.kind);
  const logError = persistedLog.view.kind === "error" ? persistedLog.error : null;
  const loadingMoreLog = persistedLog.isFetching;
  useEffect(() => {
    refreshLogRef.current = () => {
      if (persistedLog.isFetching) pendingLogRefresh.current = true;
      else persistedLog.refetch();
    };
    return () => { refreshLogRef.current = null; };
  }, [persistedLog.refetch, persistedLog.isFetching]);
  const previousStream = useRef({ runId: run.id, epoch: stream.epoch });
  useEffect(() => {
    const previous = previousStream.current;
    previousStream.current = { runId: run.id, epoch: stream.epoch };
    if (visible && logSourceEnabled && previous.runId === run.id && previous.epoch !== stream.epoch) refreshLogRef.current?.();
  }, [run.id, stream.epoch, visible, logSourceEnabled]);
  useEffect(() => connection.onRecover(() => refreshEventsRef.current?.(true)), [connection]);

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

  if (loading && logLoading && !eventsError && !logError) {
    return <p className="text-xs text-muted-foreground">{t("agents.LogViewer.loadingRunLogs")}</p>;
  }

  if (events.length === 0 && logLines.length === 0 && !logError && !eventsError) {
    return <p className="text-xs text-muted-foreground">{loading || logLoading ? t("agents.LogViewer.loadingRunLogs") : t("agents.LogViewer.noLogEvents")}</p>;
  }

  const modeLabels = {
    nice: t("agents.LogViewer.modeNice"),
    raw: t("agents.LogViewer.modeRaw"),
  };
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
          {t("agents.LogViewer.transcriptCount", { total: transcript.length })}
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
                {modeLabels[mode]}
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
              {t("agents.LogViewer.jumpToLive")}
            </Button>
          )}
          {isLive && (
            <span className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              {t("agents.LogViewer.live")}
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
          emptyMessage={run.logRef ? t("agents.LogViewer.waitingTranscript") : t("agents.LogViewer.noPersistedTranscript")}
        />
        {hasMoreLog && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={persistedLog.view.retry}
              disabled={loadingMoreLog}
            >
              {loadingMoreLog ? t("agents.LogViewer.loading") : t("agents.LogViewer.loadMoreLog")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {typeof run.logBytes === "number" && run.logBytes > 0
                ? t("agents.LogViewer.showingFirstKbOfTotal", {
                  kb: Math.round(logOffset / 1024).toLocaleString("en-US"),
                  total: Math.round(run.logBytes / 1024).toLocaleString("en-US"),
                })
                : t("agents.LogViewer.showingFirstKb", { kb: Math.round(logOffset / 1024).toLocaleString("en-US") })}
            </span>
          </div>
        )}
        {logError != null && <QueryErrorState className="mt-3" error={logError} action={t("agents.LogViewer.loadRunLogAction")} onRetry={persistedLog.view.retry} retrying={loadingMoreLog} />}
        <div ref={logEndRef} />
      </div>

      {(run.status === "failed" || run.status === "timed_out") && (
        <div className="rounded-lg border border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-950/20 p-3 space-y-2">
          <div className="text-xs font-medium text-red-700 dark:text-red-300">{t("agents.LogViewer.failureDetails")}</div>
          {run.error && (
            <div className="text-xs text-red-600 dark:text-red-200">
              <span className="text-red-700 dark:text-red-300">{t("agents.LogViewer.errorLabel")} </span>
              {redactPathText(run.error, censorUsernameInLogs)}
            </div>
          )}
          {run.stderrExcerpt && run.stderrExcerpt.trim() && (
            <div>
              <div className="text-xs text-red-700 dark:text-red-300 mb-1">{t("agents.LogViewer.stderrExcerpt")}</div>
              <pre className="bg-red-50 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap text-red-800 dark:text-red-100">
                {redactPathText(run.stderrExcerpt, censorUsernameInLogs)}
              </pre>
            </div>
          )}
          {run.resultJson && (
            <div>
              <div className="text-xs text-red-700 dark:text-red-300 mb-1">{t("agents.LogViewer.adapterResultJson")}</div>
              <pre className="bg-red-50 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap text-red-800 dark:text-red-100">
                {JSON.stringify(redactPathValue(run.resultJson, censorUsernameInLogs), null, 2)}
              </pre>
            </div>
          )}
          {run.stdoutExcerpt && run.stdoutExcerpt.trim() && !run.resultJson && (
            <div>
              <div className="text-xs text-red-700 dark:text-red-300 mb-1">{t("agents.LogViewer.stdoutExcerpt")}</div>
              <pre className="bg-red-50 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap text-red-800 dark:text-red-100">
                {redactPathText(run.stdoutExcerpt, censorUsernameInLogs)}
              </pre>
            </div>
          )}
        </div>
      )}

      {(events.length > 0 || eventsError) && (
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">{t("agents.LogViewer.eventsCount", { total: events.length })}</div>
          {eventsError && <p className="text-sm text-destructive">{eventsError}</p>}
          {(hasMoreEvents || eventsError) && (
            <Button variant="outline" size="sm" disabled={loadingMoreEvents} onClick={() => loadMoreEventsRef.current?.()}>
              {loadingMoreEvents ? t("agents.LogViewer.loading") : eventsError ? t("agents.LogViewer.retryEvents") : t("agents.LogViewer.loadMoreEvents")}
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
