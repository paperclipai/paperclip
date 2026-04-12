import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LiveEvent } from "@paperclipai/shared";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { heartbeatsApi } from "../../api/heartbeats";
import { buildTranscript, getUIAdapter, onAdapterChange, type RunLogChunk, type TranscriptEntry } from "../../adapters";
import { queryKeys } from "../../lib/queryKeys";

const LOG_POLL_INTERVAL_MS = 2000;
const LOG_READ_LIMIT_BYTES = 256_000;

export interface RunTranscriptSource {
  id: string;
  status: string;
  adapterType: string;
  hasStoredOutput?: boolean;
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
  const runsKey = useMemo(
    () =>
      runs
        .map((run) => `${run.id}:${run.status}:${run.adapterType}:${run.hasStoredOutput === true ? "1" : "0"}`)
        .sort((a, b) => a.localeCompare(b))
        .join(","),
    [runs],
  );
  const normalizedRuns = useMemo(() => runs.map((run) => ({ ...run })), [runsKey]);
  const [chunksByRun, setChunksByRun] = useState<Map<string, RunLogChunk[]>>(new Map());
  const [hydratedRunIds, setHydratedRunIds] = useState<Set<string>>(new Set());
  const seenChunkKeysRef = useRef(new Set<string>());
  const pendingLogRowsByRunRef = useRef(new Map<string, string>());
  const logOffsetByRunRef = useRef(new Map<string, number>());
  const runsRef = useRef(normalizedRuns);
  runsRef.current = normalizedRuns;
  // Tracks the runIdsKey seen on the current mount. On a true mount or
  // StrictMode dev remount this starts at null (cleanup nulls it), so
  // the poll effect below knows to clear dedup/offset refs. On a plain
  // re-run caused by runIdsKey changing (e.g. a new run was added), the
  // existing runs' offsets and dedup keys must survive so we don't
  // re-fetch their logs from byte 0 and double every chunk.
  const mountKeyRef = useRef<string | null>(null);
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
    () => new Set(normalizedRuns.filter((run) => !isTerminalStatus(run.status)).map((run) => run.id)),
    [normalizedRuns],
  );
  const runIdsKey = useMemo(
    () => normalizedRuns.map((run) => run.id).sort((a, b) => a.localeCompare(b)).join(","),
    [normalizedRuns],
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
    const knownRunIds = new Set(normalizedRuns.map((run) => run.id));
    setChunksByRun((prev) => {
      const next = new Map<string, RunLogChunk[]>();
      for (const [runId, chunks] of prev) {
        if (knownRunIds.has(runId)) {
          next.set(runId, chunks);
        }
      }
      return next.size === prev.size ? prev : next;
    });
    setHydratedRunIds((prev) => {
      const next = new Set<string>();
      for (const runId of prev) {
        if (knownRunIds.has(runId)) {
          next.add(runId);
        }
      }
      return next.size === prev.size ? prev : next;
    });

    for (const key of pendingLogRowsByRunRef.current.keys()) {
      const runId = key.replace(/:records$/, "");
      if (!knownRunIds.has(runId)) {
        pendingLogRowsByRunRef.current.delete(key);
      }
    }
    for (const runId of logOffsetByRunRef.current.keys()) {
      if (!knownRunIds.has(runId)) {
        logOffsetByRunRef.current.delete(runId);
      }
    }
  }, [normalizedRuns]);

  useEffect(() => {
    if (normalizedRuns.length === 0) return;

    // Only clear dedup / pending / offset refs on a true mount or
    // StrictMode dev remount — NOT when runIdsKey changes because a
    // new run was appended. Refs survive unmount-remount but state
    // does not, so on a remount stale keys would silently dedup every
    // chunk and leave the transcript empty. But on a mere runIdsKey
    // change (existing runs plus a new one), clearing offsets would
    // cause readAll to re-fetch existing runs from byte 0 and every
    // already-seen chunk would pass the cleared dedup check, doubling
    // the transcript for existing runs. mountKeyRef is nulled by the
    // cleanup below, so a true unmount-remount cycle is detectable.
    if (mountKeyRef.current === null) {
      seenChunkKeysRef.current.clear();
      pendingLogRowsByRunRef.current.clear();
      logOffsetByRunRef.current.clear();
    }
    mountKeyRef.current = runIdsKey;

    let cancelled = false;

    const readAll = async () => {
      // Use runsRef.current so we always see the latest runs without
      // restarting the polling effect on every runs identity change.
      // Skip terminal runs — they won't produce new log output (this
      // is the "activeRuns" optimization that used to live around the
      // setInterval call, applied here so it benefits both the initial
      // fetch and every subsequent poll tick).
      const currentRuns = runsRef.current.filter(
        (run) => !isTerminalStatus(run.status),
      );
      if (currentRuns.length === 0) return;

      // Fetch all logs in parallel but apply as a single batched state update
      // to avoid React state races where intermediate updates get lost.
      const results = await Promise.allSettled(
        currentRuns.map(async (run) => {
          const offset = logOffsetByRunRef.current.get(run.id) ?? 0;
          const result = await heartbeatsApi.log(run.id, offset, LOG_READ_LIMIT_BYTES);
          return { run, result, offset };
        }),
      );

      if (cancelled) return;

      // Parse and batch all chunks into a single state update
      const allParsed = new Map<string, Array<RunLogChunk & { dedupeKey: string }>>();
      for (const settled of results) {
        if (settled.status !== "fulfilled") continue;
        const { run, result, offset } = settled.value;
        const parsed = parsePersistedLogContent(run.id, result.content, pendingLogRowsByRunRef.current);
        if (parsed.length > 0) {
          allParsed.set(run.id, parsed);
        }
        if (result.nextOffset !== undefined) {
          logOffsetByRunRef.current.set(run.id, result.nextOffset);
        } else if (result.content.length > 0) {
          logOffsetByRunRef.current.set(run.id, offset + result.content.length);
        }
      }

      // Single state update for all runs at once
      if (allParsed.size > 0) {
        setChunksByRun((prev) => {
          const next = new Map(prev);
          let changed = false;
          for (const [runId, chunks] of allParsed) {
            const existing = [...(next.get(runId) ?? [])];
            for (const chunk of chunks) {
              if (seenChunkKeysRef.current.has(chunk.dedupeKey)) continue;
              seenChunkKeysRef.current.add(chunk.dedupeKey);
              existing.push({ ts: chunk.ts, stream: chunk.stream, chunk: chunk.chunk });
              changed = true;
            }
            next.set(runId, existing.slice(-maxChunksPerRun));
          }
          if (!changed) return prev;
          if (seenChunkKeysRef.current.size > 12000) {
            seenChunkKeysRef.current.clear();
          }
          return next;
        });
      }

      // Mark all attempted runs as hydrated in a single batched state update.
      // Upstream 03dff1a2 tracked hydration in a per-run finally block of the
      // old per-run readRunLog; this is the batched equivalent that fits the
      // allSettled structure without reintroducing a per-run setState.
      setHydratedRunIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const run of currentRuns) {
          if (!next.has(run.id)) {
            next.add(run.id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };

    void readAll();
    // Only create the polling interval when there's at least one
    // non-terminal run to watch. If every run is already in a
    // terminal state the interval would fire every 2s forever,
    // doing a filter + early-return on each tick for no benefit.
    const hasActive = runsRef.current.some(
      (run) => !isTerminalStatus(run.status),
    );
    const interval = hasActive
      ? window.setInterval(() => {
          void readAll();
        }, LOG_POLL_INTERVAL_MS)
      : null;

    return () => {
      cancelled = true;
      // Null the mount key so a subsequent StrictMode remount
      // (which lands in the same closure-less effect body) knows
      // to clear the dedup/offset refs.
      mountKeyRef.current = null;
      if (interval !== null) window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runIdsKey captures run identity; runsRef avoids effect churn
  }, [runIdsKey]);

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
  }, [activeRunIds, companyId, runById]);

  const transcriptByRun = useMemo(() => {
    const next = new Map<string, TranscriptEntry[]>();
    const censorUsernameInLogs = generalSettings?.censorUsernameInLogs === true;
    for (const run of normalizedRuns) {
      const adapter = getUIAdapter(run.adapterType);
      next.set(
        run.id,
        buildTranscript(chunksByRun.get(run.id) ?? [], adapter, {
          censorUsernameInLogs,
        }),
      );
    }
    return next;
  }, [chunksByRun, generalSettings?.censorUsernameInLogs, normalizedRuns, parserTick]);

  return {
    transcriptByRun,
    isInitialHydrating: normalizedRuns.some((run) => !hydratedRunIds.has(run.id)),
    hasOutputForRun(runId: string) {
      return (chunksByRun.get(runId)?.length ?? 0) > 0 || runById.get(runId)?.hasStoredOutput === true;
    },
  };
}
