import { appendFileSync, mkdtempSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerdTraceFrameIndex } from "./runnerd-trace-frame-index.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});

const interpretation = (frameId: number, ...emittedEventIds: string[]) =>
  `${JSON.stringify({ kind: "interpretation", frameId, emittedEventIds })}\n`;
const settled = `${JSON.stringify({ kind: "trace_status", debugChannel: "rust_native", status: "complete" })}\n`;

describe("runnerd trace frame index", () => {
  let directory: string;
  let path: string;
  let index: RunnerdTraceFrameIndex;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "runnerd-trace-index-"));
    path = join(directory, "trace.ndjson");
    index = new RunnerdTraceFrameIndex();
    vi.mocked(readSync).mockClear();
  });
  afterEach(() => {
    index.clear();
    rmSync(directory, { recursive: true, force: true });
  });

  it("indexes appended records once across repeated pending lookups and both stages", () => {
    const first = interpretation(1, "event-1", "event-2");
    writeFileSync(path, first);
    expect(index.locate(path, "event-2")).toEqual({ frameId: 1, nativeChannelSettled: false });
    for (let i = 0; i < 4096; i++) {
      expect(index.locate(path, `pending-${i}`)).toEqual({ frameId: null, nativeChannelSettled: false });
      expect(index.locate(path, "event-1").frameId).toBe(1);
    }
    expect(readSync).toHaveBeenCalledTimes(1);
    appendFileSync(path, interpretation(2, "pending-1") + settled);
    expect(index.locate(path, "pending-1")).toEqual({ frameId: 2, nativeChannelSettled: true });
    expect(index.locate(path, "missing")).toEqual({ frameId: null, nativeChannelSettled: true });
    expect(readSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readSync).mock.calls[1]![4]).toBe(Buffer.byteLength(first));
  });

  it("retains partial lines and split UTF-8 until the append is complete", () => {
    const line = Buffer.from(interpretation(9, "event-🔎"));
    const split = line.indexOf(Buffer.from("🔎")) + 2;
    writeFileSync(path, line.subarray(0, split));
    expect(index.locate(path, "event-🔎").frameId).toBeNull();
    appendFileSync(path, line.subarray(split, line.length - 1));
    expect(index.locate(path, "event-🔎").frameId).toBeNull();
    appendFileSync(path, "\n");
    expect(index.locate(path, "event-🔎").frameId).toBe(9);
  });

  it("matches the latest interpretation and only settlement records after it", () => {
    writeFileSync(path, interpretation(1, "same") + settled + interpretation(2, "same"));
    expect(index.locate(path, "same")).toEqual({ frameId: 2, nativeChannelSettled: false });
    expect(index.locate(path, "missing").nativeChannelSettled).toBe(true);
    appendFileSync(path, settled);
    expect(index.locate(path, "same")).toEqual({ frameId: 2, nativeChannelSettled: true });
  });

  it("recovers from a damaged line without discarding valid correlations", () => {
    writeFileSync(path, 'null\n{broken}\n' + interpretation(3, "event"));
    expect(index.locate(path, "event").frameId).toBe(3);
  });

  it("invalidates old correlations when the trace is truncated or replaced", () => {
    writeFileSync(path, interpretation(12345, "old-long-event") + settled);
    expect(index.locate(path, "old-long-event").frameId).toBe(12345);
    writeFileSync(path, interpretation(2, "new"));
    expect(index.locate(path, "old-long-event")).toEqual({ frameId: null, nativeChannelSettled: false });
    expect(index.locate(path, "new").frameId).toBe(2);
    writeFileSync(join(directory, "replacement"), interpretation(4, "replacement-event"));
    renameSync(join(directory, "replacement"), path);
    expect(index.locate(path, "new").frameId).toBeNull();
    expect(index.locate(path, "replacement-event").frameId).toBe(4);
  });

  it("bounds each read while making forward progress through a large trace", () => {
    const content = JSON.stringify({ kind: "frame", rawBase64: "x".repeat(3 * 1024 * 1024) }) + "\n" + interpretation(4, "last");
    writeFileSync(path, content);
    expect(index.locate(path, "last").frameId).toBeNull();
    expect(index.locate(path, "last").frameId).toBeNull();
    expect(index.locate(path, "last").frameId).toBeNull();
    expect(index.locate(path, "last").frameId).toBe(4);
    for (const call of vi.mocked(readSync).mock.calls) expect(call[3]).toBeLessThanOrEqual(1024 * 1024);
    const calls = vi.mocked(readSync).mock.calls.length;
    for (let i = 0; i < 1000; i++) index.locate(path, "missing");
    expect(readSync).toHaveBeenCalledTimes(calls);
  });

  it("retries missing files and clears retained indexes on close", () => {
    expect(() => index.locate(path, "event")).toThrow();
    writeFileSync(path, interpretation(1, "event"));
    expect(index.locate(path, "event").frameId).toBe(1);
    index.clear();
    expect(index.locate(path, "event").frameId).toBe(1);
    expect(readSync).toHaveBeenCalledTimes(2);
  });

  it("does not resolve from an incomplete prefix of a large trace", () => {
    writeFileSync(path, interpretation(1, "same") + settled +
      JSON.stringify({ kind: "frame", rawBase64: "x".repeat(1024 * 1024) }) + "\n" +
      interpretation(2, "same"));
    expect(index.locate(path, "same")).toEqual({ frameId: null, nativeChannelSettled: false });
    expect(index.locate(path, "same")).toEqual({ frameId: 2, nativeChannelSettled: false });
  });

  it("keeps progress for more than 16 interleaved active transports", () => {
    const raw = JSON.stringify({ kind: "frame", rawBase64: "x".repeat(2 * 1024 * 1024) }) + "\n";
    const traces = Array.from({ length: 24 }, (_, i) => {
      const tracePath = join(directory, `trace-${i}.ndjson`);
      writeFileSync(tracePath, raw + interpretation(i, "last"));
      return { tracePath, index: new RunnerdTraceFrameIndex() };
    });
    for (let round = 0; round < 3; round++) {
      for (const [i, trace] of traces.entries()) {
        expect(trace.index.locate(trace.tracePath, "last").frameId).toBe(round === 2 ? i : null);
      }
    }
    expect(readSync).toHaveBeenCalledTimes(72);
    for (let i = 0; i < 24; i++) {
      expect(vi.mocked(readSync).mock.calls[24 + i]![4]).toBe(1024 * 1024);
      expect(vi.mocked(readSync).mock.calls[48 + i]![4]).toBe(2 * 1024 * 1024);
    }
  });

  it("skips oversized records across appends without decoding or parsing them", () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      writeFileSync(path, '{"kind":"frame","rawBase64":"');
      const chunk = "x".repeat(32 * 1024);
      for (let i = 0; i < 256; i++) {
        appendFileSync(path, chunk);
        expect(index.locate(path, "after").frameId).toBeNull();
      }
      expect(parse).not.toHaveBeenCalled();
      appendFileSync(path, '"}\n' + interpretation(7, "after"));
      expect(index.locate(path, "after").frameId).toBe(7);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(Buffer.byteLength(parse.mock.calls[0]![0])).toBeLessThan(64 * 1024);
    } finally {
      parse.mockRestore();
    }
  });

  it("waits for a partial later interpretation before returning an older match", () => {
    const next = interpretation(2, "same");
    writeFileSync(path, interpretation(1, "same") + next.slice(0, -1));
    expect(index.locate(path, "same").frameId).toBeNull();
    appendFileSync(path, "\n");
    expect(index.locate(path, "same").frameId).toBe(2);
  });
});
