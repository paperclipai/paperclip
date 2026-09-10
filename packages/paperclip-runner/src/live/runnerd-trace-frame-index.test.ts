import { appendFileSync, mkdtempSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locateRunnerdTraceFrame, releaseRunnerdTraceFrameIndex, RunnerdTraceFrameIndex } from "./runnerd-trace-frame-index.js";

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
    releaseRunnerdTraceFrameIndex(path);
    rmSync(directory, { recursive: true, force: true });
  });

  it("indexes appended records once across repeated pending lookups and both stages", () => {
    const first = interpretation(1, "event-1", "event-2");
    writeFileSync(path, first);
    expect(locateRunnerdTraceFrame(path, "event-2")).toEqual({ frameId: 1, nativeChannelSettled: false });
    for (let i = 0; i < 4096; i++) {
      expect(locateRunnerdTraceFrame(path, `pending-${i}`)).toEqual({ frameId: null, nativeChannelSettled: false });
      expect(locateRunnerdTraceFrame(path, "event-1").frameId).toBe(1);
    }
    expect(readSync).toHaveBeenCalledTimes(1);
    appendFileSync(path, interpretation(2, "pending-1") + settled);
    expect(locateRunnerdTraceFrame(path, "pending-1")).toEqual({ frameId: 2, nativeChannelSettled: true });
    expect(locateRunnerdTraceFrame(path, "missing")).toEqual({ frameId: null, nativeChannelSettled: true });
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

  it("retries missing files and releases cached indexes on close", () => {
    expect(() => locateRunnerdTraceFrame(path, "event")).toThrow();
    writeFileSync(path, interpretation(1, "event"));
    expect(locateRunnerdTraceFrame(path, "event").frameId).toBe(1);
    releaseRunnerdTraceFrameIndex(path);
    expect(locateRunnerdTraceFrame(path, "event").frameId).toBe(1);
    expect(readSync).toHaveBeenCalledTimes(2);
  });

  it("does not resolve from an incomplete prefix of a large trace", () => {
    writeFileSync(path, interpretation(1, "same") + settled +
      JSON.stringify({ kind: "frame", rawBase64: "x".repeat(1024 * 1024) }) + "\n" +
      interpretation(2, "same"));
    expect(index.locate(path, "same")).toEqual({ frameId: null, nativeChannelSettled: false });
    expect(index.locate(path, "same")).toEqual({ frameId: 2, nativeChannelSettled: false });
  });
});
