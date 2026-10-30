import { TranscriptSequence } from "../../lib/transcript-sequence";
import { useTranscriptLiveStream } from "../../context/LiveUpdatesProvider";
import { usePageVisibility } from "../../lib/page-visibility";
import { liveRunEvent, mergeRunEvents } from "../../lib/live-run-event";
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
  conversationOnly?: boolean;
  runtimeMode?: "legacy" | "native";
}

export interface NativeRunTranscriptError {
  message: string;
  failedAt: string;
}

function isLive(status: string): boolean {
  return status === "queued" || status === "running";
}

export function useNativeRunTranscripts(runs: readonly NativeRunTranscriptSource[], options: { companyId?: string | null; enabled?: boolean } = {}) {
  const { visible } = usePageVisibility();
  const nativeRunsKey = runs
    .filter((run) => run.runtimeMode === "native")
    .map((run) => `${run.id}:${run.status}:${Boolean(run.conversationOnly)}`)
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
  const [hydratedStatusByRun, setHydratedStatusByRun] = useState(new Map<string, string>());
  const [retryGeneration, setRetryGeneration] = useState(0);
  const retry = useCallback(() => setRetryGeneration((value) => value + 1), []);
  const projectionCacheRef = useRef(new Map<string, { events: HeartbeatRunEvent[]; transcript: TranscriptEntry[] }>());
  const cursorByRunRef = useRef(new Map<string, number>());
  const conversationOnlyByRunRef = useRef(new Map<string, boolean>());

  const sequencesRef = useRef(new Map<string, TranscriptSequence>());
  const sequence = (id: string) => {
    let value = sequencesRef.current.get(id);
    if (!value) { value = new TranscriptSequence(); sequencesRef.current.set(id, value); }
    return value;
  };
  const gapPendingRef = useRef(new Set<string>());
  const historyReadsRef = useRef(new Map<string, AbortSignal>());
  const refreshByRunRef = useRef(new Map<string, (force?: boolean) => void>());
  const previousCompanyRef = useRef(options.companyId);
  useEffect(() => {
    if (previousCompanyRef.current === options.companyId) return;
    previousCompanyRef.current = options.companyId;
    setEventsByRun(new Map()); setErrorsByRun(new Map()); setHydratedRunIds(new Set()); setHydratedStatusByRun(new Map());
    projectionCacheRef.current.clear(); cursorByRunRef.current.clear(); conversationOnlyByRunRef.current.clear();
    sequencesRef.current.clear(); gapPendingRef.current.clear();
  }, [options.companyId]);
  const stream = useTranscriptLiveStream(nativeRuns.filter(run => isLive(run.status)).map(run => run.id), options, event => {
    const runId = typeof event.payload.runId === "string" ? event.payload.runId : null;
    if (!runId || !nativeRuns.some(run => run.id === runId)) return;
    if (event.type === "heartbeat.run.status" && typeof event.payload.status === "string" && !isLive(event.payload.status)) {
      refreshByRunRef.current.get(runId)?.(true); return;
    }
    const row = liveRunEvent(event);
    if (!row) return;
    const cursor = sequence(runId);
    const envelope = row.payload?.prpEvent;
    const hasTranscriptBody = envelope !== null && typeof envelope === "object" && !Array.isArray(envelope);
    if (!hasTranscriptBody) cursor.requireHistory(row.seq);
    if (cursor.observe(row.seq) && !gapPendingRef.current.has(runId)) {
      gapPendingRef.current.add(runId);
      refreshByRunRef.current.get(runId)?.();
    }
    if (hasTranscriptBody) setEventsByRun(previous => new Map(previous).set(runId, mergeRunEvents(previous.get(runId) ?? [], [row])));
  });


  useEffect(() => {
    if (!visible || options.enabled === false) return;
    for (const run of nativeRuns) {
      const mode = Boolean(run.conversationOnly);
      if (conversationOnlyByRunRef.current.get(run.id) !== mode) { cursorByRunRef.current.delete(run.id); sequencesRef.current.delete(run.id); }
      conversationOnlyByRunRef.current.set(run.id, mode);
    }
    let cancelled = false;
    const controller = new AbortController();
    const timers = new Map<string, number>();
    const pendingRefresh = new Set<string>();
    const retainedIds = new Set(nativeRuns.map((run) => run.id));
    const retainMap = <T,>(previous: Map<string, T>) => {
      const next = new Map([...previous].filter(([id]) => retainedIds.has(id)));
      return next.size === previous.size ? previous : next;
    };
    setEventsByRun(retainMap);
    setErrorsByRun(retainMap);
    setHydratedStatusByRun(retainMap);
    setHydratedRunIds((previous) => {
      const next = new Set([...previous].filter((id) => retainedIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
    for (const id of cursorByRunRef.current.keys()) {
      if (!retainedIds.has(id)) {
        cursorByRunRef.current.delete(id); sequencesRef.current.delete(id); gapPendingRef.current.delete(id);
      }
    }

    const refreshRun = async (run: NativeRunTranscriptSource) => {
      if (cancelled || historyReadsRef.current.has(run.id)) return;
      pendingRefresh.delete(run.id);
      window.clearTimeout(timers.get(run.id));
      timers.delete(run.id);
      historyReadsRef.current.set(run.id, controller.signal);
      let failed = false;
      try {
        let cursor = cursorByRunRef.current.get(run.id) ?? 0;
        const observedBeforeRead = sequence(run.id).observed;
        const incoming: HeartbeatRunEvent[] = [];
        for (;;) {
          const page = await readTranscriptRequest(
            (signal) => (run.conversationOnly ? heartbeatsApi.conversationEvents : heartbeatsApi.events)(run.id, cursor, EVENT_PAGE_SIZE, { signal }),
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
        const coveredCursor = run.conversationOnly ? Math.max(cursor, observedBeforeRead) : cursor;
        cursorByRunRef.current.set(run.id, coveredCursor);
        sequence(run.id).confirm(coveredCursor);
        failed = sequence(run.id).needsCatchup;
        if (!failed) gapPendingRef.current.delete(run.id);
        if (incoming.length > 0) setEventsByRun((previous) => {
          const next = new Map(previous);
          next.set(run.id, mergeRunEvents(previous.get(run.id) ?? [], incoming));
          return next;
        });
        setErrorsByRun((previous) => {
          if (!previous.has(run.id)) return previous;
          const next = new Map(previous);
          next.delete(run.id);
          return next;
        });
        setHydratedStatusByRun((previous) => {
          if (previous.get(run.id) === run.status) return previous;
          return new Map(previous).set(run.id, run.status);
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
      if (historyReadsRef.current.get(run.id) === controller.signal) historyReadsRef.current.delete(run.id);
      if (cancelled) return;
      setHydratedRunIds((previous) => previous.has(run.id) ? previous : new Set([...previous, run.id]));
      if (pendingRefresh.has(run.id)) {
        void refreshRun(run);
      } else if ((isLive(run.status) && !stream.healthy) || failed) {
        const timer = window.setTimeout(() => {
          timers.delete(run.id);
          void refreshRun(run);
        }, EVENT_POLL_INTERVAL_MS);
        timers.set(run.id, timer);
      }
    };
    for (const run of nativeRuns) {
      refreshByRunRef.current.set(run.id, (force = false) => {
        if (force) pendingRefresh.add(run.id);
        void refreshRun(run);
      });
      void refreshRun(run);
    }
    return () => {
      cancelled = true;
      refreshByRunRef.current.clear();
      controller.abort();
      for (const [id, signal] of historyReadsRef.current) if (signal === controller.signal) historyReadsRef.current.delete(id);
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, [nativeRuns, retryGeneration, visible, options.enabled, options.companyId, stream.healthy, stream.epoch]);

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

  const terminalHydratedRunIds = useMemo(() => new Set(nativeRuns
    .filter((run) => !isLive(run.status) && hydratedStatusByRun.get(run.id) === run.status)
    .map((run) => run.id)), [nativeRuns, hydratedStatusByRun]);

  return {
    transcriptByRun, errorsByRun, hydratedRunIds, terminalHydratedRunIds, retry,
    isInitialHydrating: nativeRuns.some((run) => !hydratedRunIds.has(run.id)),
  };
}
