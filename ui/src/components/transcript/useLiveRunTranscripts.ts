import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LiveEvent } from "@paperclipai/shared";
import { ApiError } from "../../api/client";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { heartbeatsApi } from "../../api/heartbeats";
import { buildTranscript, getUIAdapter, onAdapterChange, type RunLogChunk, type TranscriptEntry } from "../../adapters";
import { queryKeys } from "../../lib/queryKeys";
import { buildSameOriginWebSocketUrl } from "../../lib/websocket-url";
import {
  mergeRunLogChunks,
  parsePersistedLogContent,
  readChunkSeq,
  type ChunkRetentionBudget,
} from "../../lib/run-log-chunks";

// TODO(perf): this whole hook polls the log/runs endpoints on an interval. The
// durable fix is server push (SSE/websocket) for transcript deltas so idle tabs
// do no periodic work at all; the constants below only reduce the churn of the
// current polling approach.
const LOG_POLL_INTERVAL_MS = 2000;
const LOG_READ_LIMIT_BYTES = 256_000;
// When realtime websocket updates are enabled, the frequent log poll is
// redundant with the live stream; keep only a slow safety-net poll to cover
// gaps and reconnects instead of polling every couple of seconds.
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
  id: string;
  status: string;
  adapterType: string;
  hasStoredOutput?: boolean;
  logBytes?: number | null;
  lastOutputBytes?: number | null;
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
}: UseLiveRunTranscriptsOptions) {
  // Ticker consumers opt into the silent chunk-count cap; full task views use a
  // byte budget that collapses (not discards) the oldest output when exceeded.
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
          const logBytes = typeof run.logBytes === "number" ? run.logBytes : "";
          const lastOutputBytes = typeof run.lastOutputBytes === "number" ? run.lastOutputBytes : "";
          return `${run.id}:${run.status}:${run.adapterType}:${run.hasStoredOutput === true ? "1" : "0"}:${logBytes}:${lastOutputBytes}`;
        })
        .sort((a, b) => a.localeCompare(b))
        .join(","),
    [runs],
  );
  const normalizedRuns = useMemo(() => runs.map((run) => ({ ...run })), [runsKey]);
  const [chunksByRun, setChunksByRun] = useState<Map<string, RunLogChunk[]>>(new Map());
  const [hydratedRunIds, setHydratedRunIds] = useState<Set<string>>(new Set());
  const seenChunkKeysRef = useRef(new Set<string>());
  // Highest sequenced chunk trimmed out of a run's retained window; older
  // records re-delivered by the other transport are dropped instead of being
  // re-inserted ahead of newer output.
  const trimmedSeqFloorByRunRef = useRef(new Map<string, number>());
  const pendingLogRowsByRunRef = useRef(new Map<string, string>());
  const logOffsetByRunRef = useRef(new Map<string, number>());
  const missingTerminalLogRunIdsRef = useRef(new Set<string>());
  // PAP-462 B3: buffered runs that dropped out of the `runs` list, mapped to the
  // wall-clock deadline (ms) after which their buffer may be pruned. A run still
  // inside its grace window is retained across the empty poll; `pruneTick` fires
  // the effect again once the nearest deadline elapses so a run that stays gone
  // is eventually cleaned up even if the `runs` list never changes again.
  const absenceDeadlineByRunRef = useRef(new Map<string, number>());
  // Backoff state for the live event socket. Held outside the socket effect
  // because that effect restarts on run-metadata changes; per-effect state
  // would reset a progressed delay back to its base mid-outage.
  const reconnectStateRef = useRef<{ companyId: string; attempt: number } | null>(null);
  const prevKnownRunIdsRef = useRef(new Set<string>());
  const [pruneTick, setPruneTick] = useState(0);
  const transcriptCacheRef = useRef(new Map<string, {
    adapterType: string;
    chunks: RunLogChunk[];
    censorUsernameInLogs: boolean;
    parserTick: number;
    transcript: TranscriptEntry[];
  }>());
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

    for (const key of pendingLogRowsByRunRef.current.keys()) {
      const runId = key.replace(/:records$/, "");
      if (!retainedRunIds.has(runId)) {
        pendingLogRowsByRunRef.current.delete(key);
      }
    }
    for (const runId of logOffsetByRunRef.current.keys()) {
      if (!retainedRunIds.has(runId)) {
        logOffsetByRunRef.current.delete(runId);
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

  useEffect(() => {
    const readableRuns = normalizedRuns.filter(canReadPersistedLog);
    if (readableRuns.length === 0) return;

    let cancelled = false;

    const readRunLog = async (run: RunTranscriptSource) => {
      if (missingTerminalLogRunIdsRef.current.has(run.id)) {
        return;
      }
      const offset = logOffsetByRunRef.current.get(run.id) ?? resolveInitialLogOffset(run, logReadLimitBytes);
      try {
        const result = await heartbeatsApi.log(run.id, offset, logReadLimitBytes);
        if (cancelled) return;

        appendChunks(run.id, parsePersistedLogContent(run.id, result.content, pendingLogRowsByRunRef.current));

        if (result.nextOffset !== undefined) {
          logOffsetByRunRef.current.set(run.id, result.nextOffset);
          return;
        }
        if (result.content.length > 0) {
          logOffsetByRunRef.current.set(run.id, offset + result.content.length);
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404 && isTerminalStatus(run.status)) {
          missingTerminalLogRunIdsRef.current.add(run.id);
        }
      } finally {
        if (!cancelled) {
          setHydratedRunIds((prev) => {
            if (prev.has(run.id)) return prev;
            const next = new Set(prev);
            next.add(run.id);
            return next;
          });
        }
      }
    };

    const readAll = async () => {
      await Promise.all(readableRuns.map((run) => readRunLog(run)));
    };

    void readAll();
    const activeRuns = readableRuns.filter((run) => run.status === "running");
    // The realtime websocket is the primary live source when enabled, so the
    // recurring poll only needs to run as a slow fallback rather than doubling
    // the live update work every couple of seconds.
    const effectivePollMs = enableRealtimeUpdates
      ? Math.max(logPollIntervalMs, REALTIME_FALLBACK_POLL_INTERVAL_MS)
      : logPollIntervalMs;
    const interval = activeRuns.length > 0 && effectivePollMs > 0
      ? window.setInterval(() => {
          void Promise.all(activeRuns.map((run) => readRunLog(run)));
        }, effectivePollMs)
      : null;

    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [enableRealtimeUpdates, logPollIntervalMs, logReadLimitBytes, normalizedRuns, runIdsKey]);

  useEffect(() => {
    if (!enableRealtimeUpdates) return;
    if (!companyId || activeRunIds.size === 0) return;

    let closed = false;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

    // The attempt counter lives in a ref keyed to the company: this effect
    // restarts whenever run metadata changes, and a per-effect counter would
    // reset the backoff to its base delay mid-outage on every such restart.
    if (reconnectStateRef.current?.companyId !== companyId) {
      reconnectStateRef.current = { companyId, attempt: 0 };
    }
    const reconnectState = reconnectStateRef.current;

    // Exponential backoff (1.5s → 15s cap), mirroring LiveUpdatesProvider.
    // A flat retry hammers a backend that is still cold-starting — every
    // failed handshake immediately queues the next one, so a stack that
    // takes a minute to come up sees a steady stream of doomed connections.
    const scheduleReconnect = () => {
      if (closed) return;
      reconnectState.attempt += 1;
      const delayMs = Math.min(15_000, 1_500 * 2 ** Math.min(reconnectState.attempt - 1, 4));
      reconnectTimer = window.setTimeout(connect, delayMs);
    };

    const connect = () => {
      if (closed) return;
      const url = buildSameOriginWebSocketUrl(
        `/api/companies/${encodeURIComponent(companyId)}/events/ws`,
      );
      socket = new WebSocket(url);

      socket.onopen = () => {
        if (closed) return;
        reconnectState.attempt = 0;
      };

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
        if (!runById.has(runId)) return;

        if (event.type === "heartbeat.run.log") {
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
          appendChunks(runId, [{
            ts: event.createdAt,
            stream: isTerminalStatus(status) && status !== "succeeded" ? "stderr" : "system",
            chunk: `run ${status}`,
            dedupeKey: `socket:status:${runId}:${status}:${readString(payload["finishedAt"]) ?? ""}`,
          }]);
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
        if (socket.readyState === WebSocket.CONNECTING) {
          // Defer the close until the handshake completes so the browser
          // does not emit a noisy "closed before the connection is established"
          // warning during rapid run teardown.
          socket.onopen = () => {
            socket?.close(1000, "live_run_transcripts_unmount");
          };
        } else if (socket.readyState === WebSocket.OPEN) {
          socket.close(1000, "live_run_transcripts_unmount");
        }
      }
    };
  }, [activeRunIds, companyId, enableRealtimeUpdates, runById]);

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
    isInitialHydrating: normalizedRuns.some((run) => canReadPersistedLog(run) && !hydratedRunIds.has(run.id)),
    hasOutputForRun(runId: string) {
      return (chunksByRun.get(runId)?.length ?? 0) > 0 || runById.get(runId)?.hasStoredOutput === true;
    },
  };
}
