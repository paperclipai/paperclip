import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LiveEvent } from "@paperclipai/shared";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { heartbeatsApi } from "../../api/heartbeats";
import { ApiError } from "../../api/client";
import { buildTranscript, getUIAdapter, onAdapterChange, type RunLogChunk, type TranscriptEntry } from "../../adapters";
import { queryKeys } from "../../lib/queryKeys";

const LOG_POLL_INTERVAL_MS = 2000;
const LOG_READ_LIMIT_BYTES = 256_000;
const LOG_MISSING_BASE_RETRY_MS = 2_000;
const LOG_MISSING_MAX_RETRY_MS = 30_000;
const LOG_MISSING_MAX_RETRIES = 3;

const pollInFlightByRun = new Map<string, boolean>();
const terminalMissingLogRuns = new Set<string>();
const transientLogMissingRetryByRun = new Map<string, number>();
const transientLogMissingAttemptsByRun = new Map<string, number>();

export interface RunTranscriptSource {
  id: string;
  status: string;
  adapterType: string;
}

interface UseLiveRunTranscriptsOptions {
  runs: RunTranscriptSource[];
  companyId?: string | null;
  maxChunksPerRun?: number;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isTerminalStatus(status: string): boolean {
  return status === "failed" || status === "timed_out" || status === "cancelled" || status === "succeeded";
}

function isLogPollableStatus(status: string): boolean {
  return status === "running";
}

function isNotFoundError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === 404;
  }
  if (!err || typeof err !== "object") return false;
  const candidate = err as { status?: unknown };
  return typeof candidate.status === "number"
    ? candidate.status === 404
    : candidate.status === "404";
}

function parsePersistedLogContent(
  runId: string,
  content: string,
  pendingByRun: Map<string, string>,
): Array<RunLogChunk & { dedupeKey: string }> {
  if (!content) return [];

  const pendingKey = `${runId}:records`;
  const combined = `${pendingByRun.get(pendingKey) ?? ""}${content}`;
  const split = combined.split("\n");
  pendingByRun.set(pendingKey, split.pop() ?? "");

  const parsed: Array<RunLogChunk & { dedupeKey: string }> = [];
  for (const line of split) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
      const stream = raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
      if (!chunk) continue;
      parsed.push({
        ts,
        stream,
        chunk,
        dedupeKey: `log:${runId}:${ts}:${stream}:${chunk}`,
      });
    } catch {
      // Ignore malformed log rows.
    }
  }

  return parsed;
}

export function useLiveRunTranscripts({
  runs,
  companyId,
  maxChunksPerRun = 200,
}: UseLiveRunTranscriptsOptions) {
  const [chunksByRun, setChunksByRun] = useState<Map<string, RunLogChunk[]>>(new Map());
  const [missingLogRuns, setMissingLogRuns] = useState<Set<string>>(() => new Set(terminalMissingLogRuns));
  const missingLogRunsRef = useRef<Set<string>>(new Set(terminalMissingLogRuns));
  const seenChunkKeysRef = useRef(new Set<string>());
  const pendingLogRowsByRunRef = useRef(new Map<string, string>());
  const logOffsetByRunRef = useRef(new Map<string, number>());
  // Tick counter to force transcript recomputation when dynamic parser loads
  const [parserTick, setParserTick] = useState(0);
  useEffect(() => {
    return onAdapterChange(() => setParserTick((t) => t + 1));
  }, []);
  const { data: generalSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const activeRunIds = useMemo(
    () => new Set(runs.filter((run) => !isTerminalStatus(run.status)).map((run) => run.id)),
    [runs],
  );
  const runIdsKey = useMemo(
    () => runs.map((run) => run.id).sort((a, b) => a.localeCompare(b)).join(","),
    [runs],
  );

  const appendChunks = (runId: string, chunks: Array<RunLogChunk & { dedupeKey: string }>) => {
    if (chunks.length === 0) return;
    setChunksByRun((prev) => {
      const next = new Map(prev);
      const existing = [...(next.get(runId) ?? [])];
      let changed = false;

      for (const chunk of chunks) {
        if (seenChunkKeysRef.current.has(chunk.dedupeKey)) continue;
        seenChunkKeysRef.current.add(chunk.dedupeKey);
        existing.push({ ts: chunk.ts, stream: chunk.stream, chunk: chunk.chunk });
        changed = true;
      }

      if (!changed) return prev;
      if (seenChunkKeysRef.current.size > 12000) {
        seenChunkKeysRef.current.clear();
      }
      next.set(runId, existing.slice(-maxChunksPerRun));
      return next;
    });
  };

  useEffect(() => {
    const knownRunIds = new Set(runs.map((run) => run.id));
    setMissingLogRuns((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const runId of prev) {
        if (knownRunIds.has(runId)) {
          next.add(runId);
        } else {
          changed = true;
        }
      }
      if (!changed) return prev;
      missingLogRunsRef.current = next;
      return next;
    });

    const nextMissingRuns = new Set<string>();
    for (const runId of knownRunIds) {
      if (missingLogRuns.has(runId)) {
        nextMissingRuns.add(runId);
      }
    }
    missingLogRunsRef.current = nextMissingRuns;

    const visibleRunIds = new Set(runs.map((run) => run.id));
    setChunksByRun((prev) => {
      const next = new Map<string, RunLogChunk[]>();
      for (const [runId, chunks] of prev) {
        if (visibleRunIds.has(runId)) {
          next.set(runId, chunks);
        }
      }
      return next.size === prev.size ? prev : next;
    });

    for (const key of pendingLogRowsByRunRef.current.keys()) {
      const runId = key.replace(/:records$/, "");
      if (!visibleRunIds.has(runId)) {
        pendingLogRowsByRunRef.current.delete(key);
      }
    }
    for (const runId of logOffsetByRunRef.current.keys()) {
      if (!visibleRunIds.has(runId)) {
        logOffsetByRunRef.current.delete(runId);
        transientLogMissingRetryByRun.delete(runId);
        transientLogMissingAttemptsByRun.delete(runId);
      }
    }
  }, [runs]);

  useEffect(() => {
    if (runs.length === 0) return;

    let cancelled = false;
    const readableRuns = runs.filter((run) => !missingLogRuns.has(run.id) && isLogPollableStatus(run.status));
    const shouldSkipLogRead = (runId: string) => {
      const retryAt = transientLogMissingRetryByRun.get(runId);
      return typeof retryAt === "number" && retryAt > Date.now();
    };
    const markTransientLogMissing = (runId: string) => {
      const attempts = transientLogMissingAttemptsByRun.get(runId) ?? 0;
      const backoffMs = Math.min(LOG_MISSING_BASE_RETRY_MS * 2 ** attempts, LOG_MISSING_MAX_RETRY_MS);
      transientLogMissingAttemptsByRun.set(runId, attempts + 1);
      transientLogMissingRetryByRun.set(runId, Date.now() + backoffMs);
    };

    const markTerminalMissingLogs = (runId: string) => {
      const next = new Set(missingLogRunsRef.current);
      if (!next.has(runId)) {
        next.add(runId);
        terminalMissingLogRuns.add(runId);
        missingLogRunsRef.current = next;
        setMissingLogRuns(next);
      }
      transientLogMissingRetryByRun.delete(runId);
      transientLogMissingAttemptsByRun.delete(runId);
    };

    const shouldGiveUpOnMissingLogs = (runId: string) => {
      return (transientLogMissingAttemptsByRun.get(runId) ?? 0) >= LOG_MISSING_MAX_RETRIES;
    };

    const readRunLog = async (run: RunTranscriptSource) => {
      if (missingLogRunsRef.current.has(run.id)) return;
      if (pollInFlightByRun.has(run.id)) return;
      if (shouldSkipLogRead(run.id)) return;
      pollInFlightByRun.set(run.id, true);

      const offset = logOffsetByRunRef.current.get(run.id) ?? 0;
      try {
        const result = await heartbeatsApi.log(run.id, offset, LOG_READ_LIMIT_BYTES);
        if (cancelled) return;

        appendChunks(run.id, parsePersistedLogContent(run.id, result.content, pendingLogRowsByRunRef.current));

        if (result.nextOffset !== undefined) {
          logOffsetByRunRef.current.set(run.id, result.nextOffset);
          transientLogMissingRetryByRun.delete(run.id);
          transientLogMissingAttemptsByRun.delete(run.id);
          return;
        }
        if (result.content.length > 0) {
          logOffsetByRunRef.current.set(run.id, offset + result.content.length);
          transientLogMissingRetryByRun.delete(run.id);
          transientLogMissingAttemptsByRun.delete(run.id);
        }
      } catch (err) {
        if (isNotFoundError(err)) {
          if (!isTerminalStatus(run.status)) {
            if (shouldGiveUpOnMissingLogs(run.id)) {
              markTerminalMissingLogs(run.id);
              return;
            }

            // If the run transitioned to terminal status while this hook still
            // has a stale non-terminal status snapshot, stop polling the log
            // endpoint for this run immediately.
            try {
              const refreshedRun = await heartbeatsApi.get(run.id);
              if (isTerminalStatus(refreshedRun.status)) {
                markTerminalMissingLogs(run.id);
                return;
              }
            } catch (refreshErr) {
              // A missing run should stop log polling permanently.
              if (isNotFoundError(refreshErr)) {
                markTerminalMissingLogs(run.id);
                return;
              }
              // Ignore other refresh failures and continue with exponential backoff.
            }

            markTransientLogMissing(run.id);
            return;
          }
          markTerminalMissingLogs(run.id);
          return;
        }
        // Ignore log read errors while output is initializing.
        return;
      } finally {
        pollInFlightByRun.delete(run.id);
      }
    };

    const readAll = async () => {
      await Promise.all(readableRuns.map((run) => readRunLog(run)));
    };

    void readAll();
    const activeRuns = readableRuns.filter((run) => isLogPollableStatus(run.status));
    const interval = activeRuns.length > 0
      ? window.setInterval(() => {
          const currentRuns = runs.filter((run) =>
            !missingLogRuns.has(run.id) && isLogPollableStatus(run.status),
          );
          void Promise.all(currentRuns.map((run) => readRunLog(run)));
        }, LOG_POLL_INTERVAL_MS)
      : null;

    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [runIdsKey, runs, missingLogRuns]);

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
        socket.close(1000, "live_run_transcripts_unmount");
      }
    };
  }, [activeRunIds, companyId, runById]);

  const transcriptByRun = useMemo(() => {
    const next = new Map<string, TranscriptEntry[]>();
    const censorUsernameInLogs = generalSettings?.censorUsernameInLogs === true;
    for (const run of runs) {
      const adapter = getUIAdapter(run.adapterType);
      next.set(
        run.id,
        buildTranscript(chunksByRun.get(run.id) ?? [], adapter, {
          censorUsernameInLogs,
        }),
      );
    }
    return next;
  }, [chunksByRun, generalSettings?.censorUsernameInLogs, parserTick, runs]);

  return {
    transcriptByRun,
    hasOutputForRun(runId: string) {
      return (chunksByRun.get(runId)?.length ?? 0) > 0;
    },
  };
}
