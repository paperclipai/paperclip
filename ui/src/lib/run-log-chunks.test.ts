import { describe, expect, it } from "vitest";
import type { RunLogChunk } from "../adapters";
import {
  applyRetentionBudget,
  isStructuredStreamingTextDelta,
  isTrimmedOutputMarkerChunk,
  mergeRunLogChunks,
  parsePersistedLogContent,
  readChunkSeq,
  TRIMMED_OUTPUT_MARKER_TEXT,
  type ChunkMergeRefs,
  type IncomingRunLogChunk,
} from "./run-log-chunks";

function freshRefs(): ChunkMergeRefs {
  return { seenChunkKeys: new Set<string>(), trimmedSeqFloorByRun: new Map<string, number>() };
}

function seqChunk(seq: number, chunk: string): IncomingRunLogChunk {
  return { ts: `t${seq}`, stream: "stdout", chunk, seq, dedupeKey: `k${seq}` };
}

describe("readChunkSeq", () => {
  it("accepts finite numbers only", () => {
    expect(readChunkSeq(3)).toBe(3);
    expect(readChunkSeq(0)).toBe(0);
    expect(readChunkSeq("3")).toBeUndefined();
    expect(readChunkSeq(Number.NaN)).toBeUndefined();
    expect(readChunkSeq(undefined)).toBeUndefined();
  });
});

describe("isStructuredStreamingTextDelta", () => {
  it("matches acpx.text_delta and text records", () => {
    expect(isStructuredStreamingTextDelta('{"type":"acpx.text_delta","text":"x"}')).toBe(true);
    expect(isStructuredStreamingTextDelta('{"type":"text"}')).toBe(true);
    expect(isStructuredStreamingTextDelta('{"type":"acpx.tool_call"}')).toBe(false);
    expect(isStructuredStreamingTextDelta("plain text")).toBe(false);
  });
});

describe("parsePersistedLogContent", () => {
  it("parses whole log rows and carries a partial trailing line across reads", () => {
    const pending = new Map<string, string>();
    const first = parsePersistedLogContent(
      "run-1",
      '{"ts":"a","stream":"stdout","chunk":"one","seq":1}\n{"ts":"b","stream":"std',
      pending,
    );
    expect(first).toHaveLength(1);
    expect(first[0]!.chunk).toBe("one");
    expect(first[0]!.seq).toBe(1);

    // Second read completes the partial row from the first.
    const second = parsePersistedLogContent("run-1", 'out","chunk":"two","seq":2}\n', pending);
    expect(second).toHaveLength(1);
    expect(second[0]!.chunk).toBe("two");
    expect(second[0]!.seq).toBe(2);
  });

  it("skips blank and malformed rows", () => {
    const rows = parsePersistedLogContent(
      "run-1",
      '\n{"ts":"a","stream":"stdout","chunk":"ok","seq":1}\nnot-json\n{"chunk":""}\n',
      new Map(),
    );
    expect(rows.map((r) => r.chunk)).toEqual(["ok"]);
  });
});

describe("mergeRunLogChunks", () => {
  it("orders sequenced chunks by seq regardless of arrival order", () => {
    const refs = freshRefs();
    let state: RunLogChunk[] = [];
    ({ chunks: state } = mergeRunLogChunks("r", state, [seqChunk(3, "c")], refs, 100));
    ({ chunks: state } = mergeRunLogChunks("r", state, [seqChunk(1, "a")], refs, 100));
    ({ chunks: state } = mergeRunLogChunks("r", state, [seqChunk(2, "b")], refs, 100));
    expect(state.map((c) => c.chunk)).toEqual(["a", "b", "c"]);
  });

  it("dedupes by seq and keeps the longer payload from the other transport", () => {
    const refs = freshRefs();
    let state: RunLogChunk[] = [];
    ({ chunks: state } = mergeRunLogChunks("r", state, [seqChunk(1, "tru")], refs, 100));
    // Same seq arrives complete via the other path → longer payload wins.
    const result = mergeRunLogChunks("r", state, [seqChunk(1, "truncated")], refs, 100);
    expect(result.changed).toBe(true);
    expect(result.chunks.map((c) => c.chunk)).toEqual(["truncated"]);
    // Same seq, not longer → no change.
    const noChange = mergeRunLogChunks("r", result.chunks, [seqChunk(1, "short")], refs, 100);
    expect(noChange.changed).toBe(false);
  });

  it("dedupes unsequenced chunks by content key but keeps repeated text deltas", () => {
    const refs = freshRefs();
    const delta: IncomingRunLogChunk = {
      ts: "t",
      stream: "stdout",
      chunk: '{"type":"acpx.text_delta","text":"x"}',
      dedupeKey: "delta",
    };
    const sys: IncomingRunLogChunk = { ts: "t", stream: "system", chunk: "run queued", dedupeKey: "sys" };

    let state: RunLogChunk[] = [];
    ({ chunks: state } = mergeRunLogChunks("r", state, [delta, delta, sys, sys], refs, 100));
    // Both identical text deltas kept; the duplicate system row dropped.
    expect(state.map((c) => c.chunk)).toEqual([
      '{"type":"acpx.text_delta","text":"x"}',
      '{"type":"acpx.text_delta","text":"x"}',
      "run queued",
    ]);
  });

  it("drops re-delivered chunks at or below the trimmed seq floor", () => {
    const refs = freshRefs();
    let state: RunLogChunk[] = [];
    // maxChunksPerRun=2 forces seq 1 to be trimmed, raising the floor to 1.
    ({ chunks: state } = mergeRunLogChunks("r", state, [seqChunk(1, "a"), seqChunk(2, "b"), seqChunk(3, "c")], refs, 2));
    expect(state.map((c) => c.chunk)).toEqual(["b", "c"]);
    expect(refs.trimmedSeqFloorByRun.get("r")).toBe(1);
    // Re-delivery of seq 1 is dropped rather than re-inserted ahead of newer output.
    const redelivered = mergeRunLogChunks("r", state, [seqChunk(1, "a")], refs, 2);
    expect(redelivered.changed).toBe(false);
  });

  it("returns the same reference when nothing changed", () => {
    const refs = freshRefs();
    const state: RunLogChunk[] = [];
    const result = mergeRunLogChunks("r", state, [], refs, 100);
    expect(result.chunks).toBe(state);
    expect(result.changed).toBe(false);
  });

  it("retains far more than the old 200-chunk cap under a byte budget", () => {
    const refs = freshRefs();
    let state: RunLogChunk[] = [];
    // 500 one-byte delta chunks — the old count cap would have dropped 300 of
    // them off the top irreversibly. A generous byte budget keeps them all.
    for (let seq = 1; seq <= 500; seq += 1) {
      ({ chunks: state } = mergeRunLogChunks("r", state, [seqChunk(seq, "x")], refs, { maxBytes: 10_000 }));
    }
    expect(state).toHaveLength(500);
    expect(state.some(isTrimmedOutputMarkerChunk)).toBe(false);
    expect(state[0]!.chunk).toBe("x");
  });

  it("collapses the oldest output behind a single visible marker instead of discarding it", () => {
    const refs = freshRefs();
    let state: RunLogChunk[] = [];
    // Each chunk is 10 units; a 25-unit budget keeps only the newest two.
    const ten = "0123456789";
    for (let seq = 1; seq <= 4; seq += 1) {
      ({ chunks: state } = mergeRunLogChunks("r", state, [seqChunk(seq, ten)], refs, {
        maxBytes: 25,
        collapseTrimmed: true,
      }));
    }
    // First element is the marker; the two newest real chunks follow.
    expect(isTrimmedOutputMarkerChunk(state[0]!)).toBe(true);
    expect(state[0]!.chunk).toBe(TRIMMED_OUTPUT_MARKER_TEXT);
    expect(state.slice(1).map((c) => c.seq)).toEqual([3, 4]);
    // Exactly one marker — repeated trims do not stack markers.
    expect(state.filter(isTrimmedOutputMarkerChunk)).toHaveLength(1);
    // Trimmed seq floor tracks the removed records so re-delivery is dropped.
    expect(refs.trimmedSeqFloorByRun.get("r")).toBe(2);
  });
});

describe("applyRetentionBudget", () => {
  const chunk = (seq: number, text: string): RunLogChunk => ({ ts: `t${seq}`, stream: "stdout", chunk: text, seq });

  it("leaves chunks untouched when within budget", () => {
    const chunks = [chunk(1, "aa"), chunk(2, "bb")];
    const result = applyRetentionBudget(chunks, { maxBytes: 100, collapseTrimmed: true });
    expect(result.chunks).toBe(chunks);
    expect(result.trimmedSeq).toBeNull();
  });

  it("keeps the newest chunk even when it alone exceeds the byte budget", () => {
    const chunks = [chunk(1, "0123456789")];
    const result = applyRetentionBudget(chunks, { maxBytes: 3, collapseTrimmed: true });
    expect(result.chunks).toEqual(chunks);
    expect(result.chunks.some(isTrimmedOutputMarkerChunk)).toBe(false);
  });

  it("discards silently (no marker) when collapseTrimmed is off", () => {
    const chunks = [chunk(1, "a"), chunk(2, "b"), chunk(3, "c")];
    const result = applyRetentionBudget(chunks, { maxChunks: 2 });
    expect(result.chunks.map((c) => c.chunk)).toEqual(["b", "c"]);
    expect(result.chunks.some(isTrimmedOutputMarkerChunk)).toBe(false);
    expect(result.trimmedSeq).toBe(1);
  });

  it("does not accumulate markers when trimming an already-collapsed window", () => {
    const first = applyRetentionBudget(
      [chunk(1, "aa"), chunk(2, "bb"), chunk(3, "cc")],
      { maxBytes: 3, collapseTrimmed: true },
    );
    expect(first.chunks.filter(isTrimmedOutputMarkerChunk)).toHaveLength(1);
    // Feed the marker-prefixed result back in with more content over budget.
    const second = applyRetentionBudget(
      [...first.chunks, chunk(4, "dd")],
      { maxBytes: 3, collapseTrimmed: true },
    );
    expect(second.chunks.filter(isTrimmedOutputMarkerChunk)).toHaveLength(1);
    expect(second.chunks[0]!.chunk).toBe(TRIMMED_OUTPUT_MARKER_TEXT);
  });
});
