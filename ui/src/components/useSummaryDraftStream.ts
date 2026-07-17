import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LiveEvent, SummarySlotIssueRef } from "@paperclipai/shared";

import type { RunLogChunk } from "@/adapters";
import { heartbeatsApi } from "@/api/heartbeats";
import { useCompanyLiveEvent } from "@/context/LiveUpdatesProvider";
import { queryKeys } from "@/lib/queryKeys";
import {
  mergeRunLogChunks,
  parsePersistedLogContent,
  readChunkSeq,
  type ChunkMergeRefs,
  type IncomingRunLogChunk,
} from "@/lib/run-log-chunks";
import {
  closeDanglingCodeFence,
  extractAssistantOutputText,
  parseSummaryDraftStream,
} from "@/lib/summary-draft-stream";

const LOG_POLL_INTERVAL_MS = 1500;
const LOG_READ_LIMIT_BYTES = 256_000;
const MAX_CHUNKS = 400;

export interface SummaryDraftStream {
  /** The generation run id, once learned from a live event or the fallback. */
  runId: string | null;
  /** Latest `STATUS:` line streamed by the Summarizer (prefix stripped). */
  statusLine: string | null;
  /** Accumulating draft Markdown (fence-guarded while still streaming). */
  draft: string | null;
  /** True once the closing draft sentinel has arrived. */
  draftClosed: boolean;
  /** Whether any protocol output (status line or draft) has streamed yet. */
  hasStream: boolean;
}

function freshMergeRefs(): ChunkMergeRefs {
  return { seenChunkKeys: new Set<string>(), trimmedSeqFloorByRun: new Map<string, number>() };
}

function readPayloadString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Token-streamed draft for a generating summary slot.
 *
 * Learns the generation run's id from `heartbeat.run.progress` /
 * `heartbeat.run.queued` events (matched by `issueId`), falling back to the
 * issue's active-run endpoint after a page refresh. It then merges the run's
 * assistant `acpx.text_delta` output from both the persisted run-log poller and
 * the live company-events socket (reusing the shared chunk-merge/seq-dedupe
 * util) and parses the STATUS lines + sentinel-wrapped draft out of that stream.
 *
 * Degrades gracefully: no run id / no deltas (WS down, non-ACP adapter, model
 * skipped the protocol) simply yields an empty stream and the card keeps its
 * spinner. State resets whenever the tracked generation changes.
 */
export function useSummaryDraftStream(
  companyId: string | null | undefined,
  generatingIssue: SummarySlotIssueRef | null,
): SummaryDraftStream {
  const issueId = generatingIssue?.id ?? null;
  const [runId, setRunId] = useState<string | null>(null);
  const [chunks, setChunks] = useState<RunLogChunk[]>([]);

  const mergeRefs = useRef<ChunkMergeRefs>(freshMergeRefs());
  const pendingLogRowsRef = useRef(new Map<string, string>());
  const logOffsetRef = useRef(0);

  // Reset all stream state whenever the tracked generation changes — including
  // a superseded generation (new issue id) or generation ending (null).
  useEffect(() => {
    setRunId(null);
    setChunks([]);
    mergeRefs.current = freshMergeRefs();
    pendingLogRowsRef.current = new Map();
    logOffsetRef.current = 0;
  }, [issueId]);

  const appendChunks = useCallback((incoming: IncomingRunLogChunk[]) => {
    if (incoming.length === 0) return;
    setChunks((prev) => {
      const { chunks: merged, changed } = mergeRunLogChunks(
        "summary-draft",
        prev,
        incoming,
        mergeRefs.current,
        MAX_CHUNKS,
      );
      return changed ? merged : prev;
    });
  }, []);

  // Learn the generation run id from live progress/queued events for the issue.
  useCompanyLiveEvent((event: LiveEvent) => {
    if (!issueId) return;
    if (event.type !== "heartbeat.run.progress" && event.type !== "heartbeat.run.queued") return;
    const payload = event.payload ?? {};
    if (payload.issueId !== issueId) return;
    const nextRunId = readPayloadString(payload.runId);
    if (nextRunId) setRunId((current) => (current === nextRunId ? current : nextRunId));
  });

  // Fallback: resolve the active run for the generation issue when no live event
  // has surfaced the run id yet (e.g. a page refresh mid-generation).
  const activeRunQuery = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId ?? "__none__"),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId!),
    enabled: Boolean(companyId) && Boolean(issueId) && !runId,
    retry: false,
    refetchInterval: runId ? false : 4000,
  });
  const fallbackRunId = activeRunQuery.data?.id ?? null;
  useEffect(() => {
    if (fallbackRunId) setRunId((current) => current ?? fallbackRunId);
  }, [fallbackRunId]);

  // Live token deltas over the shared company-events socket.
  useCompanyLiveEvent((event: LiveEvent) => {
    if (!runId) return;
    if (event.type !== "heartbeat.run.log") return;
    const payload = event.payload ?? {};
    if (payload.runId !== runId) return;
    const chunk = readPayloadString(payload.chunk);
    if (!chunk) return;
    const ts = readPayloadString(payload.ts) ?? event.createdAt;
    const stream =
      payload.stream === "stderr" ? "stderr" : payload.stream === "system" ? "system" : "stdout";
    appendChunks([
      { ts, stream, chunk, seq: readChunkSeq(payload.seq), dedupeKey: `log:${runId}:${ts}:${stream}:${chunk}` },
    ]);
  });

  // Hydrate already-emitted output and fill any gaps from the persisted run log.
  useEffect(() => {
    if (!runId) return;
    logOffsetRef.current = 0;
    pendingLogRowsRef.current = new Map();

    let cancelled = false;
    const read = async () => {
      try {
        const result = await heartbeatsApi.log(runId, logOffsetRef.current, LOG_READ_LIMIT_BYTES);
        if (cancelled) return;
        appendChunks(parsePersistedLogContent(runId, result.content, pendingLogRowsRef.current));
        if (result.nextOffset !== undefined) {
          logOffsetRef.current = result.nextOffset;
        } else if (result.content.length > 0) {
          logOffsetRef.current += result.content.length;
        }
      } catch {
        // Ignore transient/404 reads (log not yet flushed, run just started).
      }
    };

    void read();
    const interval = window.setInterval(() => void read(), LOG_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [runId, appendChunks]);

  const parse = useMemo(() => parseSummaryDraftStream(extractAssistantOutputText(chunks)), [chunks]);

  const draft = parse.draft !== null && !parse.draftClosed
    ? closeDanglingCodeFence(parse.draft)
    : parse.draft;

  return {
    runId,
    statusLine: parse.statusLine,
    draft,
    draftClosed: parse.draftClosed,
    hasStream: parse.draft !== null || parse.statusLine !== null,
  };
}
