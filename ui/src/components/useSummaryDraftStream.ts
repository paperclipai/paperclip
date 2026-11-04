import { TranscriptSequence } from "@/lib/transcript-sequence";
import { usePageVisibility } from "@/lib/page-visibility";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LiveEvent, SummarySlotIssueRef } from "@paperclipai/shared";

import { readTranscriptRequest } from "./transcript/read-transcript-request";
import type { RunLogChunk } from "@/adapters";
import { heartbeatsApi } from "@/api/heartbeats";
import { useCompanyLiveEvent, useTranscriptLiveStream } from "@/context/LiveUpdatesProvider";
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
  const { visible } = usePageVisibility();
  const issueId = generatingIssue?.id ?? null;
  const [runId, setRunId] = useState<string | null>(null);
  const [chunks, setChunks] = useState<RunLogChunk[]>([]);

  const mergeRefs = useRef<ChunkMergeRefs>(freshMergeRefs());
  const pendingLogRowsRef = useRef(new Map<string, string>());
  const logOffsetRef = useRef(0);
  const logIdentityRef = useRef<string | null>(null);
  const retiredLogIdentitiesRef = useRef(new Set<string>());
  const sequenceRef = useRef(new TranscriptSequence());
  const gapPendingRef = useRef(false);
  const [catchupGeneration, setCatchupGeneration] = useState(0);
  const requestCatchup = () => {
    if (gapPendingRef.current) return;
    gapPendingRef.current = true;
    setCatchupGeneration(value => value + 1);
  };
  const bindLog = (store: unknown, ref: unknown) => {
    if (typeof ref !== "string" || !ref) return "same";
    const identity = `${typeof store === "string" ? store : ""}:${ref}`;
    if (identity === logIdentityRef.current) return "same";
    if (retiredLogIdentitiesRef.current.has(identity)) return "stale";
    const prior = logIdentityRef.current;
    logIdentityRef.current = identity;
    if (!prior) return "same";
    retiredLogIdentitiesRef.current.add(prior);
    if (retiredLogIdentitiesRef.current.size > 8) retiredLogIdentitiesRef.current.delete(retiredLogIdentitiesRef.current.values().next().value!);
    logOffsetRef.current = 0; pendingLogRowsRef.current.clear(); sequenceRef.current = new TranscriptSequence();
    mergeRefs.current = freshMergeRefs(); setChunks([]);
    return "changed";
  };

  // Reset all stream state whenever the tracked generation changes — including
  // a superseded generation (new issue id) or generation ending (null).
  useEffect(() => {
    setRunId(null);
    setChunks([]);
    mergeRefs.current = freshMergeRefs();
    pendingLogRowsRef.current = new Map();
    logOffsetRef.current = 0;
  }, [companyId, issueId]);

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
    if (!issueId || event.companyId !== companyId) return;
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
    enabled: visible && Boolean(companyId) && Boolean(issueId) && !runId,
    retry: false,
    refetchInterval: runId ? false : 4000,
  });
  const fallbackRunId = activeRunQuery.data?.id ?? null;
  useEffect(() => {
    if (fallbackRunId) setRunId((current) => current ?? fallbackRunId);
  }, [fallbackRunId]);

  useEffect(() => {
    logOffsetRef.current = 0;
    pendingLogRowsRef.current = new Map();
    logIdentityRef.current = null; retiredLogIdentitiesRef.current.clear(); sequenceRef.current = new TranscriptSequence();
    gapPendingRef.current = false; mergeRefs.current = freshMergeRefs(); setChunks([]);
  }, [runId, companyId, issueId]);
  // Live token deltas over the shared company-events socket.
  const stream = useTranscriptLiveStream(runId ? [runId] : [], { companyId, enabled: visible && Boolean(issueId) }, (event: LiveEvent) => {
    if (!visible || !runId) return;
    if (event.type === "heartbeat.run.status" && event.payload.runId === runId) { setCatchupGeneration(value => value + 1); return; }
    if (event.type !== "heartbeat.run.log") return;
    const payload = event.payload ?? {};
    if (payload.runId !== runId) return;
    const binding = bindLog(payload.logStore, payload.logRef);
    if (binding === "stale") return;
    const seq = readChunkSeq(payload.seq);
    if (payload.truncated === true) sequenceRef.current.requireHistory(seq);
    const gap = sequenceRef.current.observe(seq);
    if (binding === "changed" || payload.truncated === true || gap) requestCatchup();
    if (payload.truncated === true) return;
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
    if (!visible || !runId) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: number | undefined;
    const read = async () => {
      let failed = false;
      try {
        for (;;) {
          const offset = logOffsetRef.current;
          const result = await readTranscriptRequest(signal => heartbeatsApi.log(runId, offset, LOG_READ_LIMIT_BYTES, { signal }), controller.signal);
          if (cancelled) return;
          const binding = bindLog(result.store, result.logRef);
          if (binding === "stale") { failed = true; break; }
          if (binding === "changed" && offset !== 0) continue;
          const rows = parsePersistedLogContent(runId, result.content, pendingLogRowsRef.current);
          appendChunks(rows);
          for (const row of rows) sequenceRef.current.confirm(row.seq);
          const next = result.nextOffset ?? offset + new TextEncoder().encode(result.content).byteLength;
          logOffsetRef.current = next;
          if (result.nextOffset === undefined || !result.content || next <= offset) break;
        }
        failed ||= sequenceRef.current.needsCatchup;
        if (!failed) gapPendingRef.current = false;
      } catch {
        failed = true;
      }
      if (!cancelled && (!stream.healthy || failed)) timer = window.setTimeout(() => void read(), LOG_POLL_INTERVAL_MS);
    };
    void read();
    return () => {
      cancelled = true; controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [visible, companyId, runId, appendChunks, stream.healthy, stream.epoch, catchupGeneration]);

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
