import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import type { TranscriptEntry } from "@/adapters";
import { heartbeatsApi } from "@/api/heartbeats";
import { mergeRunEvents, nextRunEventCursor, runEventPageHasMore, retainEventTail, type RunEventCursor } from "@/lib/run-event-pagination";
import { nativeRunEventsToTranscript } from "./native-run-events";
import { readTranscriptRequest } from "./read-transcript-request";

const EVENT_PAGE_SIZE = 1_000;
const MAX_AUTO_CATCHUP_PAGES = 4;
const EVENT_POLL_INTERVAL_MS = 2_000;
const EMPTY_EVENTS: HeartbeatRunEvent[] = [];

export interface NativeRunTranscriptSource {
  id: string;
  status: string;
  runtimeMode?: "legacy" | "native";
}

export interface NativeRunTranscriptError {
  message: string;
  failedAt: string;
}

function isLive(status: string): boolean {
  return status === "queued" || status === "running";
}

export function useNativeRunTranscripts(runs: readonly NativeRunTranscriptSource[]) {
  const nativeRunsKey = runs
    .filter((run) => run.runtimeMode === "native")
    .map((run) => `${run.id}:${run.status}`)
    .sort()
    .join(",");
  const nativeRuns = useMemo(
    () => runs.filter((run) => run.runtimeMode === "native").map((run) => ({ ...run })),
    // The key carries every field this hook consumes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nativeRunsKey],
  );
  const [eventsByRun, setEventsByRun] = useState<Map<string, HeartbeatRunEvent[]>>(new Map());
  const [contextByRun, setContextByRun] = useState<Map<string, HeartbeatRunEvent[]>>(new Map());
  const [unavailableContextRunIds, setUnavailableContextRunIds] = useState<ReadonlySet<string>>(new Set());
  const eventsByRunRef = useRef(eventsByRun);
  eventsByRunRef.current = eventsByRun;
  const [errorsByRun, setErrorsByRun] = useState<Map<string, NativeRunTranscriptError>>(new Map());
  const [hydratedRunIds, setHydratedRunIds] = useState<ReadonlySet<string>>(new Set());
  const [historyCollapsedRunIds, setHistoryCollapsedRunIds] = useState<ReadonlySet<string>>(new Set());
  const [retryGeneration, setRetryGeneration] = useState(0);
  const retry = useCallback(() => setRetryGeneration((value) => value + 1), []);
  const projectionCacheRef = useRef(new Map<string, { events: HeartbeatRunEvent[]; context: HeartbeatRunEvent[]; contextUnavailable: boolean; transcript: TranscriptEntry[] }>());
  const cursorByRunRef = useRef(new Map<string, RunEventCursor>());

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timers = new Set<number>();
    const retainedIds = new Set(nativeRuns.map((run) => run.id));
    const retainMap = <T,>(previous: Map<string, T>) => {
      const next = new Map([...previous].filter(([id]) => retainedIds.has(id)));
      return next.size === previous.size ? previous : next;
    };
    setEventsByRun(retainMap);
    setContextByRun(retainMap);
    setUnavailableContextRunIds((previous) => {
      const next = new Set([...previous].filter((id) => retainedIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
    setErrorsByRun(retainMap);
    setHydratedRunIds((previous) => {
      const next = new Set([...previous].filter((id) => retainedIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
    setHistoryCollapsedRunIds((previous) => {
      const next = new Set([...previous].filter((id) => retainedIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
    for (const id of cursorByRunRef.current.keys()) {
      if (!retainedIds.has(id)) cursorByRunRef.current.delete(id);
    }

    const refreshRun = async (run: NativeRunTranscriptSource) => {
      let failed = false;
      try {
        let cursor = cursorByRunRef.current.get(run.id) ?? "tail";
        const incoming: HeartbeatRunEvent[] = [];
        let historyBefore = false;
        let incomingWasTrimmed = false;
        let pagesFetched = 0;
        let contextError: Error | undefined;
        for (;;) {
          const readPage = () => readTranscriptRequest(
            (signal) => heartbeatsApi.events(run.id, cursor, EVENT_PAGE_SIZE, { signal }),
            controller.signal,
          );
          // Pending requests and the latest final response are current state,
          // not expendable scrollback. Read them independently of the window.
          let page: HeartbeatRunEvent[];
          if (pagesFetched === 0) {
            const [pageResult, contextResult] = await Promise.allSettled([
              readPage(),
              readTranscriptRequest(
                (signal) => heartbeatsApi.eventContext(run.id, { signal }),
                controller.signal,
              ),
            ]);
            if (cancelled) return;
            if (contextResult.status === "fulfilled") {
              const context = contextResult.value;
              setContextByRun((previous) => {
                const old = previous.get(run.id) ?? EMPTY_EVENTS;
                if (JSON.stringify(old) === JSON.stringify(context)) return previous;
                return new Map(previous).set(run.id, context);
              });
              setUnavailableContextRunIds((previous) => {
                if (!previous.has(run.id)) return previous;
                const next = new Set(previous);
                next.delete(run.id);
                return next;
              });
            } else {
              setUnavailableContextRunIds((previous) => previous.has(run.id)
                ? previous : new Set([...previous, run.id]));
              contextError = contextResult.reason instanceof Error
                ? contextResult.reason
                : new Error("Current run requests and final response could not be loaded");
            }
            if (pageResult.status === "rejected") throw pageResult.reason;
            page = pageResult.value;
          } else {
            page = await readPage();
          }
          if (cancelled) return;
          pagesFetched += 1;
          historyBefore ||= cursor === "tail" && page[0]?.historyBefore === true;
          const boundedIncoming = retainEventTail([...incoming, ...page]);
          incoming.splice(0, incoming.length, ...boundedIncoming.events);
          incomingWasTrimmed ||= boundedIncoming.collapsed;
          const nextCursor = nextRunEventCursor(cursor, page);
          if (!runEventPageHasMore(page, EVENT_PAGE_SIZE) || nextCursor === cursor) {
            cursor = nextCursor;
            break;
          }
          cursor = nextCursor;
          if (pagesFetched >= MAX_AUTO_CATCHUP_PAGES) {
            // Catch-up must not walk an unbounded backlog. Jump to the latest
            // durable page so terminal runs also hydrate their current tail.
            const tail = await readTranscriptRequest(
              (signal) => heartbeatsApi.events(run.id, "tail", EVENT_PAGE_SIZE, { signal }),
              controller.signal,
            );
            if (cancelled) return;
            const boundedTail = retainEventTail(tail);
            incoming.splice(0, incoming.length, ...boundedTail.events);
            incomingWasTrimmed ||= boundedTail.collapsed || incoming.length > 0;
            historyBefore = true;
            if (tail.length > 0) cursor = nextRunEventCursor("tail", tail);
            break;
          }
        }
        // Commit this run's cursor with its rows. A slow sibling must neither
        // hold its readiness hostage nor stall live polling for this run.
        cursorByRunRef.current.set(run.id, cursor);
        if (incoming.length > 0) {
          const merged = mergeRunEvents(historyBefore ? [] : eventsByRunRef.current.get(run.id) ?? [], incoming);
          const retained = retainEventTail(merged);
          if (historyBefore || incomingWasTrimmed || retained.collapsed) {
            setHistoryCollapsedRunIds((previous) => previous.has(run.id)
              ? previous
              : new Set([...previous, run.id]));
          }
          eventsByRunRef.current = new Map(eventsByRunRef.current).set(run.id, retained.events);
          setEventsByRun((previous) => {
            const next = new Map(previous);
            next.set(run.id, retained.events);
            return next;
          });
        }
        if (incoming.length === 0 && historyBefore) {
          setHistoryCollapsedRunIds((previous) => previous.has(run.id)
            ? previous
            : new Set([...previous, run.id]));
        }
        // Keep successful event reads and the last known context visible while
        // reporting and retrying a failed companion read, even for settled runs.
        if (contextError) throw contextError;
        setErrorsByRun((previous) => {
          if (!previous.has(run.id)) return previous;
          const next = new Map(previous);
          next.delete(run.id);
          return next;
        });
      } catch (error) {
        if (cancelled) return;
        failed = true;
        setErrorsByRun((previous) => {
          if (previous.has(run.id)) return previous;
          const next = new Map(previous);
          next.set(run.id, {
            message: error instanceof Error ? error.message : "Native run activity could not be loaded",
            failedAt: new Date().toISOString(),
          });
          return next;
        });
      }
      if (cancelled) return;
      setHydratedRunIds((previous) => previous.has(run.id) ? previous : new Set([...previous, run.id]));
      if (isLive(run.status) || failed) {
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          void refreshRun(run);
        }, EVENT_POLL_INTERVAL_MS);
        timers.add(timer);
      }
    };
    for (const run of nativeRuns) void refreshRun(run);
    return () => {
      cancelled = true;
      controller.abort();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [nativeRuns, retryGeneration]);

  const transcriptByRun = useMemo(() => {
    const transcripts = new Map<string, TranscriptEntry[]>();
    for (const run of nativeRuns) {
      const events = eventsByRun.get(run.id) ?? EMPTY_EVENTS;
      const context = contextByRun.get(run.id) ?? EMPTY_EVENTS;
      const contextUnavailable = unavailableContextRunIds.has(run.id);
      if (events === EMPTY_EVENTS && context === EMPTY_EVENTS) continue;
      let cached = projectionCacheRef.current.get(run.id);
      if (!cached || cached.events !== events || cached.context !== context || cached.contextUnavailable !== contextUnavailable) {
        let transcript = nativeRunEventsToTranscript(
          mergeRunEvents(context, events).sort((left, right) => left.seq - right.seq),
        );
        const pendingRequestIds = new Set(nativeRunEventsToTranscript(context)
          .flatMap((entry) => entry.kind === "runtime_request" && entry.status === "pending"
            ? [entry.requestId] : []));
        transcript = transcript.filter((entry) => entry.kind !== "runtime_request"
          || entry.status !== "pending"
          || (!contextUnavailable && pendingRequestIds.has(entry.requestId)));
        if (contextUnavailable) {
          // A failed context read cannot establish that an old request is still
          // pending, or that a response-wake result has no outstanding request.
          // Keep activity and answers visible, but require a fresh snapshot for
          // these interactive states. The surfaced error offers retry.
          transcript = transcript.map((entry) => entry.kind === "run_result"
              ? { ...entry, acceptedResponseWake: undefined } : entry);
        }
        cached = { events, context, contextUnavailable, transcript };
        projectionCacheRef.current.set(run.id, cached);
      }
      transcripts.set(run.id, cached.transcript);
    }
    for (const id of projectionCacheRef.current.keys()) {
      if (!transcripts.has(id)) projectionCacheRef.current.delete(id);
    }
    return transcripts;
  }, [eventsByRun, contextByRun, nativeRuns, unavailableContextRunIds]);

  return {
    transcriptByRun, errorsByRun, hydratedRunIds, historyCollapsedRunIds, retry,
    isInitialHydrating: nativeRuns.some((run) => !hydratedRunIds.has(run.id)),
  };
}
