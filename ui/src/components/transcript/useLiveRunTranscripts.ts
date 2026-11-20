import { TranscriptSequence } from "../../lib/transcript-sequence";
import { useTranscriptLiveStream } from "../../context/LiveUpdatesProvider";
import { usePageVisibility } from "../../lib/page-visibility";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readTranscriptRequest } from "./read-transcript-request";
import { useQuery } from "@tanstack/react-query";
import type { LiveEvent } from "@paperclipai/shared";
import { ApiError } from "../../api/client";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { heartbeatsApi } from "../../api/heartbeats";
import { buildTranscript, getUIAdapter, onAdapterChange, type RunLogChunk, type TranscriptEntry } from "../../adapters";
import { queryKeys } from "../../lib/queryKeys";
import {
  mergeRunLogChunks,
  parsePersistedLogContent,
  readChunkSeq,
  type ChunkRetentionBudget,
} from "../../lib/run-log-chunks";

const LOG_POLL_INTERVAL_MS = 2000;
const LOG_READ_LIMIT_BYTES = 256_000;
const REALTIME_FALLBACK_POLL_INTERVAL_MS = 30_000;
const EMPTY_RUN_LOG_CHUNKS: RunLogChunk[] = [];
// Retained transcript payload budget for full task views. A byte budget (rather
// than a tiny chunk count) keeps the whole streamed scrollback intact — a
// delta-streaming run emits thousands of one-token chunks in seconds, and the
// old 200-chunk cap discarded just-rendered messages off the top irreversibly.
// If a run genuinely exceeds this, the oldest output collapses behind a visible
// marker instead of vanishing (see `applyRetentionBudget`).
const TASK_VIEW_MAX_BYTES_PER_RUN = 2_000_000;
// Grace period before an accumulated transcript buffer is pruned for a run that
// has vanished from the `runs` list. The parent refetches runs on its own
// interval, and a single transient empty/errored poll would otherwise wipe the
// buffer — forcing a rehydration that skips to the last `LOG_READ_LIMIT_BYTES`
// and silently drops already-rendered scrollback (PAP-462 B3). A run that is
// genuinely gone stays absent past this window and is then pruned as before.
const RUN_ABSENCE_PRUNE_GRACE_MS = 20_000;

export interface RunTranscriptSource {
  createdAt?: string | Date;
  id: string;
  status: string;
  adapterType: string;
  runtimeMode?: "legacy" | "native";
  hasStoredOutput?: boolean;
  logBytes?: number | null;
  lastOutputBytes?: number | null;
  logRef?: string | null;
}

interface UseLiveRunTranscriptsOptions {
  runs: RunTranscriptSource[];
  companyId?: string | null;
  /**
   * Compact chunk-count cap for ticker-style consumers (dashboard). When set,
   * trimming is silent — the historical behavior. Full task views omit this and
   * use the byte budget below instead.
   */
  maxChunksPerRun?: number;
  maxBytesPerRun?: number;
  logPollIntervalMs?: number;
  logReadLimitBytes?: number;
  enableRealtimeUpdates?: boolean;
  enabled?: boolean;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isTerminalStatus(status: string): boolean {
  return status === "failed" || status === "timed_out" || status === "cancelled" || status === "interrupted" || status === "succeeded";
}

function canReadPersistedLog(run: RunTranscriptSource): boolean {
  return run.status === "running" || isTerminalStatus(run.status);
}

function runKnownLogBytes(run: RunTranscriptSource): number | null {
  const bytes = run.status === "queued"
    ? run.logBytes
    : run.lastOutputBytes ?? run.logBytes;
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

export function resolveInitialLogOffset(run: RunTranscriptSource, limitBytes: number): number {
  const knownBytes = runKnownLogBytes(run);
  if (knownBytes === null) return 0;
  return Math.max(0, knownBytes - Math.max(0, limitBytes));
}

export function useLiveRunTranscripts({
  runs,
  companyId,
  maxChunksPerRun,
  maxBytesPerRun = TASK_VIEW_MAX_BYTES_PER_RUN,
  logPollIntervalMs = LOG_POLL_INTERVAL_MS,
  logReadLimitBytes = LOG_READ_LIMIT_BYTES,
  enableRealtimeUpdates = true,
  enabled = true,
}: UseLiveRunTranscriptsOptions) {
  // Ticker consumers opt into the silent chunk-count cap; full task views use a
  // byte budget that collapses (not discards) the oldest output when exceeded.
  const { visible } = usePageVisibility();
  const retentionBudget: ChunkRetentionBudget = useMemo(
    () =>
      typeof maxChunksPerRun === "number"
        ? { maxChunks: maxChunksPerRun }
        : { maxBytes: maxBytesPerRun, collapseTrimmed: true },
    [maxChunksPerRun, maxBytesPerRun],
  );
  const runsKey = useMemo(
    () =>
      runs
        .map((run) => {
          const logBytes = isTerminalStatus(run.status) && typeof run.logBytes === "number" ? run.logBytes : "";
          const lastOutputBytes = isTerminalStatus(run.status) && typeof run.lastOutputBytes === "number" ? run.lastOutputBytes : "";
          return `${run.id}:${run.status}:${run.adapterType}:${run.hasStoredOutput === true ? "1" : "0"}:${logBytes}:${lastOutputBytes}:${run.logRef ?? ""}`;
        })
        .sort((a, b) => a.localeCompare(b))
        .join(","),
    [runs],
  );
  const normalizedRuns = useMemo(() => runs.map((run) => ({ ...run })), [runsKey]);
  const [chunksByRun, setChunksByRun] = useState<Map<string, RunLogChunk[]>>(new Map());
  const [hydratedRunIds, setHydratedRunIds] = useState<Set<string>>(new Set());
  const [errorsByRun, setErrorsByRun] = useState<ReadonlyMap<string, Error>>(new Map());
  const [retryGeneration, setRetryGeneration] = useState(0);
  const retry = useCallback(() => {
    missingTerminalLogRunIdsRef.current.clear();
    setRetryGeneration((value) => value + 1);
  }, []);
  const seenChunkKeysRef = useRef(new Set<string>());
  // Highest sequenced chunk trimmed out of a run's retained window; older
  // records re-delivered by the other transport are dropped instead of being
  // re-inserted ahead of newer output.
  const trimmedSeqFloorByRunRef = useRef(new Map<string, number>());
  const pendingLogRowsByRunRef = useRef(new Map<string, string>());
  const logOffsetByRunRef = useRef(new Map<string, number>());
  const logReadLimitByRunRef = useRef(new Map<string, number>());
  const logIdentityRef = useRef(new Map<string, string>());
  const retiredLogIdentitiesRef = useRef(new Map<string, Set<string>>());
  const sequencesRef = useRef(new Map<string, TranscriptSequence>());
  const sequence = (id: string) => {
    let value = sequencesRef.current.get(id);
    if (!value) { value = new TranscriptSequence(); sequencesRef.current.set(id, value); }
    return value;
  };
  const gapPendingRef = useRef(new Set<string>());
  const refreshByRunRef = useRef(new Map<string, (force?: boolean) => void>());
  const requestCatchUp = (runId: string) => {
    if (gapPendingRef.current.has(runId)) return;
    gapPendingRef.current.add(runId);
    refreshByRunRef.current.get(runId)?.();
  };
  const bindLog = (runId: string, store: unknown, ref: unknown): "same" | "changed" | "stale" => {
    if (typeof ref !== "string" || !ref) return "same";
    const identity = `${typeof store === "string" ? store : ""}:${ref}`;
    const prior = logIdentityRef.current.get(runId);
    if (prior === identity) return "same";
    if (retiredLogIdentitiesRef.current.get(runId)?.has(identity)) return "stale";
    logIdentityRef.current.set(runId, identity);
    if (!prior) return "same";
    const retired = retiredLogIdentitiesRef.current.get(runId) ?? new Set<string>();
    retired.add(prior);
    if (retired.size > 8) retired.delete(retired.values().next().value!);
    retiredLogIdentitiesRef.current.set(runId, retired);
    logOffsetByRunRef.current.set(runId, 0); logReadLimitByRunRef.current.delete(runId);
    pendingLogRowsByRunRef.current.delete(runId); pendingLogRowsByRunRef.current.delete(`${runId}:records`);
    trimmedSeqFloorByRunRef.current.delete(runId); sequencesRef.current.delete(runId);
    for (const key of seenChunkKeysRef.current) if (key.includes(`:${runId}:`)) seenChunkKeysRef.current.delete(key);
    setChunksByRun(previous => new Map(previous).set(runId, []));
    setTruncatedRunIds(previous => {
      if (!previous.has(runId)) return previous;
      const next = new Set(previous); next.delete(runId); return next;
    });
    return "changed";
  };

  const [truncatedRunIds, setTruncatedRunIds] = useState<ReadonlySet<string>>(new Set());
  const missingTerminalLogRunIdsRef = useRef(new Set<string>());
  // PAP-462 B3: buffered runs that dropped out of the `runs` list, mapped to the
  // wall-clock deadline (ms) after which their buffer may be pruned. A run still
  // inside its grace window is retained across the empty poll; `pruneTick` fires
  // the effect again once the nearest deadline elapses so a run that stays gone
  // is eventually cleaned up even if the `runs` list never changes again.
  const absenceDeadlineByRunRef = useRef(new Map<string, number>());
  const prevKnownRunIdsRef = useRef(new Set<string>());
  const [pruneTick, setPruneTick] = useState(0);
  const transcriptCacheRef = useRef(new Map<string, {
    adapterType: string;
    chunks: RunLogChunk[];
    censorUsernameInLogs: boolean;
    parserTick: number;
    transcript: TranscriptEntry[];
  }>());
  const previousCompanyRef = useRef(companyId);
  useEffect(() => {
    if (previousCompanyRef.current === companyId) return;
    previousCompanyRef.current = companyId;
    setChunksByRun(new Map()); setHydratedRunIds(new Set()); setErrorsByRun(new Map());
    seenChunkKeysRef.current.clear(); trimmedSeqFloorByRunRef.current.clear();
    pendingLogRowsByRunRef.current.clear(); logOffsetByRunRef.current.clear(); logReadLimitByRunRef.current.clear();
    logIdentityRef.current.clear(); retiredLogIdentitiesRef.current.clear(); sequencesRef.current.clear();
    gapPendingRef.current.clear(); missingTerminalLogRunIdsRef.current.clear();
    absenceDeadlineByRunRef.current.clear(); prevKnownRunIdsRef.current.clear(); transcriptCacheRef.current.clear();
  }, [companyId]);

  // Tick counter to force transcript recomputation when dynamic parser loads
  const [parserTick, setParserTick] = useState(0);
  useEffect(() => {
    return onAdapterChange(() => setParserTick((t) => t + 1));
  }, []);
  const { data: generalSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  const runById = useMemo(() => new Map(normalizedRuns.map((run) => [run.id, run])), [normalizedRuns]);
  const activeRunIds = useMemo(
    () => new Set(normalizedRuns.filter((run) => run.status === "running").map((run) => run.id)),
    [normalizedRuns],
  );
  const runIdsKey = useMemo(
    () => normalizedRuns.map((run) => run.id).sort((a, b) => a.localeCompare(b)).join(","),
    [normalizedRuns],
  );

  const appendChunks = (runId: string, chunks: Array<RunLogChunk & { dedupeKey: string }>) => {
    if (chunks.length === 0) return;
    setChunksByRun((prev) => {
      const prevChunks = prev.get(runId) ?? [];
      const { chunks: merged, changed } = mergeRunLogChunks(
        runId,
        prevChunks,
        chunks,
        {
          seenChunkKeys: seenChunkKeysRef.current,
          trimmedSeqFloorByRun: trimmedSeqFloorByRunRef.current,
        },
        retentionBudget,
      );
      if (!changed) return prev;
      const next = new Map(prev);
      next.set(runId, merged);
      return next;
    });
  };

  useEffect(() => {
    const knownRunIds = new Set(normalizedRuns.map((run) => run.id));
    const now = Date.now();
    const deadlines = absenceDeadlineByRunRef.current;

    // PAP-462 B3: a run that just disappeared from the list starts its grace
    // clock; one that reappeared clears any pending deadline. Comparing against
    // the previous known set means a transient empty poll only *arms* the timer
    // rather than pruning the buffer outright.
    for (const runId of prevKnownRunIdsRef.current) {
      if (!knownRunIds.has(runId) && !deadlines.has(runId)) {
        deadlines.set(runId, now + RUN_ABSENCE_PRUNE_GRACE_MS);
      }
    }
    for (const runId of knownRunIds) {
      deadlines.delete(runId);
    }
    prevKnownRunIdsRef.current = knownRunIds;

    // Retain known runs plus any absent run still inside its grace window; only
    // runs absent past their deadline are actually pruned.
    const retainedRunIds = new Set(knownRunIds);
    let soonestExpiryMs = Number.POSITIVE_INFINITY;
    for (const [runId, deadline] of deadlines) {
      if (deadline > now) {
        retainedRunIds.add(runId);
        soonestExpiryMs = Math.min(soonestExpiryMs, deadline);
      } else {
        deadlines.delete(runId);
      }
    }

    setChunksByRun((prev) => {
      const next = new Map<string, RunLogChunk[]>();
      for (const [runId, chunks] of prev) {
        if (retainedRunIds.has(runId)) {
          next.set(runId, chunks);
        }
      }
      return next.size === prev.size ? prev : next;
    });
    setHydratedRunIds((prev) => {
      const next = new Set<string>();
      for (const runId of prev) {
        if (retainedRunIds.has(runId)) {
          next.add(runId);
        }
      }
      return next.size === prev.size ? prev : next;
    });

    setErrorsByRun((previous) => {
      const next = new Map([...previous].filter(([id]) => retainedRunIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
    setTruncatedRunIds((previous) => {
      const next = new Set([...previous].filter((id) => retainedRunIds.has(id)));
      return next.size === previous.size ? previous : next;
    });

    for (const key of pendingLogRowsByRunRef.current.keys()) {
      const runId = key.replace(/:records$/, "");
      if (!retainedRunIds.has(runId)) {
        pendingLogRowsByRunRef.current.delete(key);
      }
    }
    for (const runId of logOffsetByRunRef.current.keys()) {
      if (!retainedRunIds.has(runId)) {
        logOffsetByRunRef.current.delete(runId);
        logReadLimitByRunRef.current.delete(runId);
      }
    }
    for (const runId of trimmedSeqFloorByRunRef.current.keys()) {
      if (!retainedRunIds.has(runId)) {
        trimmedSeqFloorByRunRef.current.delete(runId);
      }
    }
    for (const runId of missingTerminalLogRunIdsRef.current.keys()) {
      if (!retainedRunIds.has(runId)) {
        missingTerminalLogRunIdsRef.current.delete(runId);
      }
    }
    for (const runId of transcriptCacheRef.current.keys()) {
      if (!retainedRunIds.has(runId)) {
        transcriptCacheRef.current.delete(runId);
      }
    }

    for (const map of [logIdentityRef.current, retiredLogIdentitiesRef.current, sequencesRef.current]) {
      for (const id of map.keys()) if (!retainedRunIds.has(id)) map.delete(id);
    }
    for (const id of gapPendingRef.current) if (!retainedRunIds.has(id)) gapPendingRef.current.delete(id);

    // Re-run once the nearest grace window elapses so a run that stays gone is
    // pruned even if `normalizedRuns` never changes again.
    if (soonestExpiryMs !== Number.POSITIVE_INFINITY) {
      const timer = window.setTimeout(
        () => setPruneTick((tick) => tick + 1),
        Math.max(0, soonestExpiryMs - now) + 50,
      );
      return () => window.clearTimeout(timer);
    }
  }, [normalizedRuns, pruneTick]);

  const stream = useTranscriptLiveStream([...activeRunIds], { companyId, enabled: enabled && enableRealtimeUpdates }, event => {
        if (event.companyId !== companyId) return;
        const payload = event.payload ?? {};
        const runId = readString(payload["runId"]);
        if (!runId) return;
        if (!runById.has(runId)) return;

        if (event.type === "heartbeat.run.log") {
          const binding = bindLog(runId, payload.logStore, payload.logRef);
          if (binding === "stale") return;
          const seq = readChunkSeq(payload.seq);
          if (payload.truncated === true) sequence(runId).requireHistory(seq);
          const gap = sequence(runId).observe(seq);
          if (binding === "changed" || payload.truncated === true || gap) requestCatchUp(runId);
          if (payload.truncated === true) return;
          const chunk = readString(payload["chunk"]);
          if (!chunk) return;
          const ts = readString(payload["ts"]) ?? event.createdAt;
          const stream =
            readString(payload["stream"]) === "stderr"
              ? "stderr"
              : readString(payload["stream"]) === "system"
                ? "system"
                : "stdout";
          appendChunks(runId, [{
            ts,
            stream,
            chunk,
            seq: readChunkSeq(payload["seq"]),
            dedupeKey: `log:${runId}:${ts}:${stream}:${chunk}`,
          }]);
          return;
        }

        if (event.type === "heartbeat.run.event") {
          const seq = typeof payload["seq"] === "number" ? payload["seq"] : null;
          const eventType = readString(payload["eventType"]) ?? "event";
          const messageText = readString(payload["message"]) ?? eventType;
          appendChunks(runId, [{
            ts: event.createdAt,
            stream: eventType === "error" ? "stderr" : "system",
            chunk: messageText,
            dedupeKey: `socket:event:${runId}:${seq ?? `${eventType}:${messageText}:${event.createdAt}`}`,
          }]);
          return;
        }

        if (event.type === "heartbeat.run.status") {
          const status = readString(payload["status"]) ?? "updated";
          if (isTerminalStatus(status)) refreshByRunRef.current.get(runId)?.(true);
          appendChunks(runId, [{
            ts: event.createdAt,
            stream: isTerminalStatus(status) && status !== "succeeded" ? "stderr" : "system",
            chunk: `run ${status}`,
            dedupeKey: `socket:status:${runId}:${status}:${readString(payload["finishedAt"]) ?? ""}`,
          }]);
        }
  });

  useEffect(() => {
    if (!visible || !enabled) return;
    const readableRuns = normalizedRuns.filter(canReadPersistedLog);
    if (readableRuns.length === 0) return;

    let cancelled = false;
    const controller = new AbortController();
    const inFlightRunIds = new Set<string>();
    const retryTimers = new Map<string, number>();
    const pendingRefresh = new Set<string>();

    const readRunLog = async (run: RunTranscriptSource) => {
      if (cancelled || missingTerminalLogRunIdsRef.current.has(run.id) || inFlightRunIds.has(run.id)) {
        return;
      }
      pendingRefresh.delete(run.id);
      window.clearTimeout(retryTimers.get(run.id));
      retryTimers.delete(run.id);
      inFlightRunIds.add(run.id);
      let failed = false;
      let alignStartToRecord = !logOffsetByRunRef.current.has(run.id);
      let offset = logOffsetByRunRef.current.get(run.id) ?? resolveInitialLogOffset(run, logReadLimitBytes);
      let rewinding = false;
      const previousReadLimit = logReadLimitByRunRef.current.get(run.id);
      if (previousReadLimit !== undefined && logReadLimitBytes > previousReadLimit) {
        const expandedOffset = resolveInitialLogOffset(run, logReadLimitBytes);
        if (expandedOffset < offset) {
          alignStartToRecord = true;
          offset = expandedOffset;
          rewinding = true;
        }
      }
      let recordInitialWindow = previousReadLimit === undefined || rewinding;
      try {
        for (;;) {
          const result = await readTranscriptRequest(
            (signal) => heartbeatsApi.log(run.id, offset, logReadLimitBytes, {
              signal,
              ...(alignStartToRecord && offset > 0 ? { alignStartToRecord: true } : {}),
            }), controller.signal,
          );
          if (cancelled) return;
          const binding = bindLog(run.id, result.store, result.logRef);
          if (binding === "stale") { failed = true; return; }
          if (binding === "changed" && offset !== 0) { offset = 0; continue; }
          if (recordInitialWindow || binding === "changed") {
            const windowIsTruncated = offset > 0;
            setTruncatedRunIds(previous => {
              if (previous.has(run.id) === windowIsTruncated) return previous;
              const next = new Set(previous);
              if (windowIsTruncated) next.add(run.id);
              else next.delete(run.id);
              return next;
            });
            recordInitialWindow = false;
          }
          logReadLimitByRunRef.current.set(run.id, logReadLimitBytes);
          if (rewinding) {
            pendingLogRowsByRunRef.current.delete(run.id);
            pendingLogRowsByRunRef.current.delete(`${run.id}:records`);
            rewinding = false;
          }
          alignStartToRecord = false;
          setErrorsByRun(previous => {
            if (!previous.has(run.id)) return previous;
            const next = new Map(previous); next.delete(run.id); return next;
          });
          const rows = parsePersistedLogContent(run.id, result.content, pendingLogRowsByRunRef.current);
          appendChunks(run.id, rows);
          for (const row of rows) sequence(run.id).confirm(row.seq);
          const next = result.nextOffset ?? offset + new TextEncoder().encode(result.content).byteLength;
          logOffsetByRunRef.current.set(run.id, next);
          if (result.nextOffset === undefined || result.content.length === 0 || next <= offset) break;
          offset = next;
        }
        failed = sequence(run.id).needsCatchup;
        if (!failed) gapPendingRef.current.delete(run.id);
      } catch (error) {
        if (cancelled) return;
        failed = true;
        if (error instanceof ApiError && error.status === 404) {
          setErrorsByRun((previous) => {
            if (!previous.has(run.id)) return previous;
            const next = new Map(previous);
            next.delete(run.id);
            return next;
          });
          // A newly started run may not have created its log yet.
          if (isTerminalStatus(run.status)) { missingTerminalLogRunIdsRef.current.add(run.id); failed = false; }
        } else {
          setErrorsByRun((previous) => {
            if (previous.has(run.id)) return previous;
            const next = new Map(previous);
            next.set(run.id, error instanceof Error ? error : new Error("Run history could not be loaded"));
            return next;
          });
        }
      } finally {
        inFlightRunIds.delete(run.id);
        if (!cancelled) {
          if (pendingRefresh.has(run.id)) {
            missingTerminalLogRunIdsRef.current.delete(run.id);
            void readRunLog(run);
          } else if (failed && stream.healthy) {
            const timer = window.setTimeout(() => { retryTimers.delete(run.id); void readRunLog(run); }, LOG_POLL_INTERVAL_MS);
            retryTimers.set(run.id, timer);
          }
          setHydratedRunIds((prev) => {
            if (prev.has(run.id)) return prev;
            const next = new Set(prev);
            next.add(run.id);
            return next;
          });
        }
      }
    };

    for (const run of readableRuns) {
      refreshByRunRef.current.set(run.id, (force = false) => {
        if (force) { pendingRefresh.add(run.id); missingTerminalLogRunIdsRef.current.delete(run.id); }
        void readRunLog(run);
      });
      void readRunLog(run);
    }
    const activeRuns = readableRuns.filter((run) => run.status === "running");
    // The realtime websocket is the primary live source when enabled, so the
    // recurring poll only needs to run as a slow fallback rather than doubling
    // the live update work every couple of seconds.
    const effectivePollMs = enableRealtimeUpdates
      ? Math.max(logPollIntervalMs, REALTIME_FALLBACK_POLL_INTERVAL_MS)
      : logPollIntervalMs;
    const interval = !stream.healthy && activeRuns.length > 0 && effectivePollMs > 0
      ? window.setInterval(() => {
          void Promise.all(activeRuns.map((run) => readRunLog(run)));
        }, effectivePollMs)
      : null;

    return () => {
      cancelled = true;
      refreshByRunRef.current.clear();
      controller.abort();
      for (const timer of retryTimers.values()) window.clearTimeout(timer);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [visible, enableRealtimeUpdates, logPollIntervalMs, logReadLimitBytes, normalizedRuns, runIdsKey, retryGeneration, enabled, companyId, stream.healthy, stream.epoch]);


  const transcriptByRun = useMemo(() => {
    const next = new Map<string, TranscriptEntry[]>();
    const censorUsernameInLogs = generalSettings?.censorUsernameInLogs === true;
    const cache = transcriptCacheRef.current;
    const currentRunIds = new Set<string>();
    for (const run of normalizedRuns) {
      currentRunIds.add(run.id);
      const chunks = chunksByRun.get(run.id) ?? EMPTY_RUN_LOG_CHUNKS;
      const cached = cache.get(run.id);
      if (
        cached &&
        cached.adapterType === run.adapterType &&
        cached.chunks === chunks &&
        cached.censorUsernameInLogs === censorUsernameInLogs &&
        cached.parserTick === parserTick
      ) {
        next.set(run.id, cached.transcript);
        continue;
      }

      const adapter = getUIAdapter(run.adapterType);
      const transcript = buildTranscript(chunks, adapter, {
        censorUsernameInLogs,
      });
      cache.set(run.id, {
        adapterType: run.adapterType,
        chunks,
        censorUsernameInLogs,
        parserTick,
        transcript,
      });
      next.set(run.id, transcript);
    }
    for (const runId of cache.keys()) {
      if (!currentRunIds.has(runId)) {
        cache.delete(runId);
      }
    }
    return next;
  }, [chunksByRun, generalSettings?.censorUsernameInLogs, normalizedRuns, parserTick]);

  return {
    transcriptByRun,
    hydratedRunIds, truncatedRunIds, errorsByRun, retry,
    isInitialHydrating: normalizedRuns.some((run) => canReadPersistedLog(run) && !hydratedRunIds.has(run.id)),
    hasOutputForRun(runId: string) {
      return (chunksByRun.get(runId)?.length ?? 0) > 0 || runById.get(runId)?.hasStoredOutput === true;
    },
  };
}
