import { describe, expect, it } from "vitest";
import type { RunLogChunk } from "../adapters";
import {
  isStructuredStreamingTextDelta,
  mergeRunLogChunks,
  parsePersistedLogContent,
  readChunkSeq,
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
});
