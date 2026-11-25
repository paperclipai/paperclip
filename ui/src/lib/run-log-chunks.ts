import type { RunLogChunk } from "../adapters";

/**
 * Chunk-merge / seq-dedupe primitives shared by the live run transcript view
 * (`useLiveRunTranscripts`) and the summary draft stream (`useSummaryDraftStream`).
 *
 * Both consumers ingest the same run-log records from two transports — the
 * persisted offset-read poller and the company events WebSocket — which
 * interleave and re-deliver records. This module centralizes the ordering and
 * de-duplication rules so the two hooks cannot drift apart.
 */

export type IncomingRunLogChunk = RunLogChunk & { dedupeKey: string };

/**
 * Per-consumer merge state. `seenChunkKeys` is shared across every run tracked
 * by a single consumer (bounded + cleared past a cap); `trimmedSeqFloorByRun`
 * records, per run, the highest sequenced chunk that has been trimmed out of the
 * retained window so re-delivered older records are dropped rather than
 * re-inserted ahead of newer output.
 */
export interface ChunkMergeRefs {
  seenChunkKeys: Set<string>;
  trimmedSeqFloorByRun: Map<string, number>;
}

const SEEN_CHUNK_KEY_CAP = 12000;

/**
 * Retention budget for a run's kept chunk window. Task views pass a byte budget
 * with `collapseTrimmed` so the just-rendered scrollback is retained and, when
 * the budget is genuinely exceeded, the oldest content collapses behind a
 * visible marker instead of silently vanishing midstream. Compact consumers
 * (dashboard tickers, summary draft) keep the historical chunk-count cap by
 * passing a bare number, which discards silently as before.
 */
export interface ChunkRetentionBudget {
  /** Hard ceiling on retained chunk count. */
  maxChunks?: number;
  /** Soft ceiling on retained chunk payload size (UTF-16 code units ≈ bytes). */
  maxBytes?: number;
  /**
   * When true, trimming leaves a single visible "earlier output trimmed" marker
   * at the head so collapsed content never disappears without a trace. When
   * false (the default for count-only callers), trimming is silent.
   */
  collapseTrimmed?: boolean;
}

/**
 * Text of the synthetic system chunk that marks where older output was
 * collapsed out of the retained window. Rendered as an ordinary system line by
 * `buildTranscript`, so the affordance is adapter-agnostic.
 */
export const TRIMMED_OUTPUT_MARKER_TEXT =
  "⋯ earlier output trimmed to stay within the live transcript buffer ⋯";

export function isTrimmedOutputMarkerChunk(chunk: RunLogChunk): boolean {
  return (
    chunk.stream === "system" &&
    chunk.chunk === TRIMMED_OUTPUT_MARKER_TEXT &&
    chunk.seq === undefined
  );
}

function makeTrimmedOutputMarkerChunk(ts: string): RunLogChunk {
  return { ts, stream: "system", chunk: TRIMMED_OUTPUT_MARKER_TEXT };
}

function chunkRetainedSize(chunk: RunLogChunk): number {
  return chunk.chunk.length;
}

function normalizeRetentionBudget(budget: number | ChunkRetentionBudget): ChunkRetentionBudget {
  return typeof budget === "number" ? { maxChunks: budget } : budget;
}

/**
 * Trim a run's retained window to its budget. Byte-budget trimming keeps the
 * newest chunks and (when `collapseTrimmed`) prepends one marker so the
 * scrollback shows earlier output was collapsed rather than silently dropped.
 * Returns the highest sequenced chunk actually removed so callers can raise the
 * trimmed-seq floor and drop re-delivered older records.
 */
export function applyRetentionBudget(
  chunks: RunLogChunk[],
  budget: ChunkRetentionBudget,
): { chunks: RunLogChunk[]; trimmedSeq: number | null } {
  const { maxChunks, maxBytes, collapseTrimmed } = budget;

  // Peel off any existing marker so it is never counted or duplicated; a single
  // marker is re-added below if trimming is (still) in effect.
  const hadMarker = chunks.length > 0 && isTrimmedOutputMarkerChunk(chunks[0]!);
  const real = hadMarker ? chunks.slice(1) : chunks;

  let removeCount = 0;
  if (typeof maxChunks === "number" && real.length > maxChunks) {
    removeCount = real.length - maxChunks;
  }
  if (typeof maxBytes === "number") {
    let totalBytes = 0;
    for (const chunk of real) totalBytes += chunkRetainedSize(chunk);
    let byteRemove = 0;
    // Always keep the newest chunk even if it alone exceeds the byte budget.
    while (byteRemove < real.length - 1 && totalBytes > maxBytes) {
      totalBytes -= chunkRetainedSize(real[byteRemove]!);
      byteRemove += 1;
    }
    if (byteRemove > removeCount) removeCount = byteRemove;
  }

  if (removeCount <= 0) {
    // Nothing new to trim. Preserve an existing marker so an earlier collapse
    // keeps its trace; otherwise return the marker-stripped array only if we
    // actually stripped one (we never had a real trim to justify keeping it).
    if (hadMarker) return { chunks, trimmedSeq: null };
    return { chunks: real, trimmedSeq: null };
  }

  const removed = real.slice(0, removeCount);
  const kept = real.slice(removeCount);

  let trimmedSeq: number | null = null;
  for (const item of removed) {
    if (typeof item.seq === "number" && (trimmedSeq === null || item.seq > trimmedSeq)) {
      trimmedSeq = item.seq;
    }
  }

  if (collapseTrimmed || hadMarker) {
    const markerTs = kept[0]?.ts ?? removed[removed.length - 1]!.ts;
    return { chunks: [makeTrimmedOutputMarkerChunk(markerTs), ...kept], trimmedSeq };
  }
  return { chunks: kept, trimmedSeq };
}

export function readChunkSeq(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isStructuredStreamingTextDelta(chunk: string): boolean {
  return /"type"\s*:\s*"(?:acpx\.text_delta|text)"/.test(chunk);
}

/**
 * Parse a raw persisted-log slice into ordered chunks. `pendingByRun` carries a
 * partial trailing line across offset reads so a record split across a read
 * boundary is not dropped.
 */
export function parsePersistedLogContent(
  runId: string,
  content: string,
  pendingByRun: Map<string, string>,
): IncomingRunLogChunk[] {
  if (!content) return [];

  const pendingKey = `${runId}:records`;
  const combined = `${pendingByRun.get(pendingKey) ?? ""}${content}`;
  const split = combined.split("\n");
  pendingByRun.set(pendingKey, split.pop() ?? "");

  const parsed: IncomingRunLogChunk[] = [];
  for (const line of split) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown; seq?: unknown };
      const stream = raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
      if (!chunk) continue;
      parsed.push({
        ts,
        stream,
        chunk,
        seq: readChunkSeq(raw.seq),
        dedupeKey: `log:${runId}:${ts}:${stream}:${chunk}`,
      });
    } catch {
      // Ignore malformed log rows.
    }
  }

  return parsed;
}

/**
 * Merge incoming chunks into a run's retained window, preserving emit order and
 * de-duplicating across the two delivery transports. Returns the same array
 * reference when nothing changed so callers can bail out of React state updates.
 *
 * Ordering rules (unchanged from the original `useLiveRunTranscripts`
 * implementation):
 * - Sequenced chunks dedupe/order by the server-assigned monotonic `seq`. When
 *   the same `seq` arrives from both transports the longer payload wins (the
 *   websocket copy may be tail-truncated). Records at or below the trimmed
 *   floor are dropped.
 * - Unsequenced chunks dedupe by content key (skipping structured streaming
 *   text deltas, which legitimately repeat) and act as an ordering barrier for
 *   subsequent sequenced inserts.
 */
export function mergeRunLogChunks(
  runId: string,
  prevChunks: RunLogChunk[],
  incoming: IncomingRunLogChunk[],
  refs: ChunkMergeRefs,
  budget: number | ChunkRetentionBudget,
): { chunks: RunLogChunk[]; changed: boolean } {
  if (incoming.length === 0) return { chunks: prevChunks, changed: false };

  const existing = [...prevChunks];
  let changed = false;

  for (const chunk of incoming) {
    if (typeof chunk.seq === "number") {
      const seqFloor = refs.trimmedSeqFloorByRun.get(runId) ?? 0;
      if (chunk.seq <= seqFloor) continue;
      const duplicateAt = existing.findIndex((item) => item.seq === chunk.seq);
      if (duplicateAt !== -1) {
        // Same record arrived via the other delivery path. Prefer the longer
        // payload: websocket chunks may be tail-truncated while the persisted
        // row is complete.
        if (chunk.chunk.length > existing[duplicateAt]!.chunk.length) {
          existing[duplicateAt] = { ts: chunk.ts, stream: chunk.stream, chunk: chunk.chunk, seq: chunk.seq };
          changed = true;
        }
        continue;
      }
      // Insert in seq order relative to the trailing sequenced chunks so
      // late-arriving records from the slower delivery path land where they
      // were emitted. Unsequenced chunks act as an ordering barrier.
      let insertAt = existing.length;
      while (insertAt > 0) {
        const prior = existing[insertAt - 1]!;
        if (typeof prior.seq !== "number" || prior.seq < chunk.seq) break;
        insertAt -= 1;
      }
      existing.splice(insertAt, 0, { ts: chunk.ts, stream: chunk.stream, chunk: chunk.chunk, seq: chunk.seq });
      changed = true;
      continue;
    }

    if (!isStructuredStreamingTextDelta(chunk.chunk)) {
      if (refs.seenChunkKeys.has(chunk.dedupeKey)) continue;
      refs.seenChunkKeys.add(chunk.dedupeKey);
    }
    existing.push({ ts: chunk.ts, stream: chunk.stream, chunk: chunk.chunk });
    changed = true;
  }

  if (!changed) return { chunks: prevChunks, changed: false };
  if (refs.seenChunkKeys.size > SEEN_CHUNK_KEY_CAP) {
    refs.seenChunkKeys.clear();
  }

  const { chunks: retained, trimmedSeq } = applyRetentionBudget(existing, normalizeRetentionBudget(budget));
  if (trimmedSeq !== null) {
    const seqFloor = refs.trimmedSeqFloorByRun.get(runId) ?? 0;
    if (trimmedSeq > seqFloor) refs.trimmedSeqFloorByRun.set(runId, trimmedSeq);
  }

  return { chunks: retained, changed: true };
}
