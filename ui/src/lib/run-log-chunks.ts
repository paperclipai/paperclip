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
  maxChunksPerRun: number,
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
  if (existing.length > maxChunksPerRun) {
    const trimmed = existing.splice(0, existing.length - maxChunksPerRun);
    let seqFloor = refs.trimmedSeqFloorByRun.get(runId) ?? 0;
    for (const item of trimmed) {
      if (typeof item.seq === "number" && item.seq > seqFloor) seqFloor = item.seq;
    }
    if (seqFloor > 0) refs.trimmedSeqFloorByRun.set(runId, seqFloor);
  }

  return { chunks: existing, changed: true };
}
