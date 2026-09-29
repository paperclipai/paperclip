import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import type { TranscriptEntry } from "@/adapters";
import { heartbeatsApi } from "@/api/heartbeats";
import { mergeRunEvents, nextRunEventCursor, runEventPageHasMore, type RunEventCursor } from "@/lib/run-event-pagination";
import { nativeRunEventsToTranscript } from "./native-run-events";
import { readTranscriptRequest } from "./read-transcript-request";

const EVENT_PAGE_SIZE = 1_000;
const MAX_AUTO_CATCHUP_PAGES = 4;
const MAX_RETAINED_EVENTS = 1_000;
const MAX_RETAINED_EVENT_BYTES = 2 * 1024 * 1024;
const EVENT_POLL_INTERVAL_MS = 2_000;

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

function retainEventTail(events: HeartbeatRunEvent[]) {
  let bytes = 0;
  let start = Math.max(0, events.length - MAX_RETAINED_EVENTS);
  for (const event of events.slice(start)) bytes += JSON.stringify(event).length;
  while (start < events.length - 1 && bytes > MAX_RETAINED_EVENT_BYTES) {
    bytes -= JSON.stringify(events[start]!).length;
    start += 1;
  }
  return { events: start ? events.slice(start) : events, collapsed: start > 0 };
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
  const eventsByRunRef = useRef(eventsByRun);
  eventsByRunRef.current = eventsByRun;
  const [errorsByRun, setErrorsByRun] = useState<Map<string, NativeRunTranscriptError>>(new Map());
  const [hydratedRunIds, setHydratedRunIds] = useState<ReadonlySet<string>>(new Set());
  const [historyCollapsedRunIds, setHistoryCollapsedRunIds] = useState<ReadonlySet<string>>(new Set());
  const [retryGeneration, setRetryGeneration] = useState(0);
  const retry = useCallback(() => setRetryGeneration((value) => value + 1), []);
  const projectionCacheRef = useRef(new Map<string, { events: HeartbeatRunEvent[]; transcript: TranscriptEntry[] }>());
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
        for (;;) {
          const page = await readTranscriptRequest(
            (signal) => heartbeatsApi.events(run.id, cursor, EVENT_PAGE_SIZE, { signal }),
            controller.signal,
          );
          if (cancelled) return;
          pagesFetched += 1;
          historyBefore ||= page[0]?.historyBefore === true;
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
            const boundedTail = retainEventTail([...incoming, ...tail]);
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
          const merged = mergeRunEvents(eventsByRunRef.current.get(run.id) ?? [], incoming);
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
      const events = eventsByRun.get(run.id);
      if (!events) continue;
      let cached = projectionCacheRef.current.get(run.id);
      if (!cached || cached.events !== events) {
        cached = { events, transcript: nativeRunEventsToTranscript(events) };
        projectionCacheRef.current.set(run.id, cached);
      }
      transcripts.set(run.id, cached.transcript);
    }
    for (const id of projectionCacheRef.current.keys()) {
      if (!transcripts.has(id)) projectionCacheRef.current.delete(id);
    }
    return transcripts;
  }, [eventsByRun, nativeRuns]);

  return {
    transcriptByRun, errorsByRun, hydratedRunIds, historyCollapsedRunIds, retry,
    isInitialHydrating: nativeRuns.some((run) => !hydratedRunIds.has(run.id)),
  };
}
