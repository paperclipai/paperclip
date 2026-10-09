import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import type { TranscriptEntry } from "@/adapters";
import { heartbeatsApi } from "@/api/heartbeats";
import { nativeRunEventsToTranscript } from "./native-run-events";
import { readTranscriptRequest } from "./read-transcript-request";

const EVENT_PAGE_SIZE = 1_000;
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
  const [errorsByRun, setErrorsByRun] = useState<Map<string, NativeRunTranscriptError>>(new Map());
  const [hydratedRunIds, setHydratedRunIds] = useState<ReadonlySet<string>>(new Set());
  const [retryGeneration, setRetryGeneration] = useState(0);
  const retry = useCallback(() => setRetryGeneration((value) => value + 1), []);
  const projectionCacheRef = useRef(new Map<string, { events: HeartbeatRunEvent[]; transcript: TranscriptEntry[] }>());
  const cursorByRunRef = useRef(new Map<string, number>());

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
    for (const id of cursorByRunRef.current.keys()) {
      if (!retainedIds.has(id)) cursorByRunRef.current.delete(id);
    }

    const refreshRun = async (run: NativeRunTranscriptSource) => {
      let failed = false;
      try {
        let cursor = cursorByRunRef.current.get(run.id) ?? 0;
        const incoming: HeartbeatRunEvent[] = [];
        for (;;) {
          const page = await readTranscriptRequest(
            (signal) => heartbeatsApi.events(run.id, cursor, EVENT_PAGE_SIZE, { signal }),
            controller.signal,
          );
          if (cancelled) return;
          const last = page.at(-1);
          const nextCursor = last ? Math.max(cursor, last.seq) : cursor;
          incoming.push(...page.filter((event) => event.seq > cursor));
          if (page.length < EVENT_PAGE_SIZE || nextCursor === cursor) {
            cursor = nextCursor;
            break;
          }
          cursor = nextCursor;
        }
        // Commit this run's cursor with its rows. A slow sibling must neither
        // hold its readiness hostage nor stall live polling for this run.
        cursorByRunRef.current.set(run.id, cursor);
        if (incoming.length > 0) setEventsByRun((previous) => {
          const next = new Map(previous);
          next.set(run.id, [...(previous.get(run.id) ?? []), ...incoming]);
          return next;
        });
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
    transcriptByRun, errorsByRun, hydratedRunIds, retry,
    isInitialHydrating: nativeRuns.some((run) => !hydratedRunIds.has(run.id)),
  };
}
