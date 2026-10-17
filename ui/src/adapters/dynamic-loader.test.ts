import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import { invalidateDynamicParser, loadDynamicParser, setDynamicParserResultNotifier } from "./dynamic-loader";
import { getWorkerBootstrapSource } from "./sandboxed-parser-worker";
import { buildTranscript, type RunLogChunk } from "./transcript";
import type { StdoutLineParser, StdoutParserFactory } from "./types";

/**
 * The dynamic loader talks to a real Worker, which does not exist in Node.
 * These tests substitute a fake worker that runs the actual worker bootstrap
 * source inside a vm context, so the async message protocol — init, parse,
 * result — is exercised exactly as the browser would drive it.
 */
let currentWorker: FakeSandboxWorker | null = null;

vi.mock("./sandboxed-parser-worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sandboxed-parser-worker")>();
  return {
    getWorkerBootstrapSource: actual.getWorkerBootstrapSource,
    createSandboxedWorker: () => currentWorker as unknown as Worker,
  };
});

/** The part of the worker global scope the bootstrap touches. */
type WorkerSelf = {
  navigator: Record<string, unknown>;
  postMessage: (msg: { type: string }) => void;
  onmessage?: (e: { data: unknown }) => void;
};

class FakeSandboxWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  /** Parse requests received from the main thread. */
  parseRequests = 0;
  /** Replies posted back to the main thread. */
  replies = 0;
  terminated = false;
  private readonly self: WorkerSelf;

  constructor() {
    this.self = {
      navigator: {},
      // Worker → main: the bootstrap posts results back to worker.onmessage.
      postMessage: (msg: { type: string }) => {
        if (msg.type === "ready" || msg.type === "result") {
          this.replies += 1;
        }
        // A real worker reply arrives on a later tick.
        queueMicrotask(() => this.onmessage?.({ data: msg }));
      },
    };
    vm.runInNewContext(getWorkerBootstrapSource(), { self: this.self });
  }

  /** Main → worker: the loader posts requests to the bootstrap's handler. */
  postMessage(msg: unknown) {
    if ((msg as { type?: string }).type === "parse") this.parseRequests += 1;
    queueMicrotask(() => this.self.onmessage?.({ data: msg }));
  }

  terminate() {
    this.terminated = true;
  }
}

/**
 * A parser with cross-line state, shaped like the Hermes Reasoning-box parser:
 * a border pair brackets lines that must stay thinking, everything else is
 * assistant text. The borders are identical so every box looks the same to a
 * result cache.
 */
const STATEFUL_PARSER_SOURCE = `
function createParser() {
  let open = false;
  return {
    parseLine(line, ts) {
      if (line === "OPEN") { open = true; return []; }
      if (line === "CLOSE") { open = false; return []; }
      if (open) return [{ kind: "thinking", ts, text: line, delta: true }];
      return [{ kind: "assistant", ts, text: line }];
    },
    reset() { open = false; },
  };
}
const shared = createParser();
module.exports = { parseStdoutLine: shared.parseLine, createStdoutParser: createParser };
`;

const LINES = ["OPEN", " wrapped thought", "CLOSE", " visible answer"];

function lineChunks(lines: string[], ts: string): RunLogChunk[] {
  return lines.map((line, index) => ({ ts, stream: "stdout" as const, chunk: `${line}\n`, seq: index }));
}

async function loadStatefulParser(
  adapterType: string,
): Promise<{ parseStdoutLine: StdoutLineParser; createStdoutParser: StdoutParserFactory }> {
  currentWorker = new FakeSandboxWorker();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(STATEFUL_PARSER_SOURCE, { status: 200 })),
  );
  const parserModule = await loadDynamicParser(adapterType);
  const createStdoutParser = parserModule?.createStdoutParser;
  expect(createStdoutParser).toBeTypeOf("function");
  if (!createStdoutParser || !parserModule) throw new Error("stateful parser source did not load");
  return { parseStdoutLine: parserModule.parseStdoutLine, createStdoutParser };
}

/** Wait until every parse request sent so far has been answered. */
async function settle(timeout = 5_000) {
  await vi.waitFor(
    () => {
      expect(currentWorker?.replies ?? 0).toBeGreaterThanOrEqual(currentWorker?.parseRequests ?? 0);
    },
    { timeout },
  );
}

/** Count of transcript recomputes the loader asked for since it was reset. */
let recomputes = 0;

function countRecomputes() {
  recomputes = 0;
  setDynamicParserResultNotifier(() => {
    recomputes += 1;
  });
}

describe("dynamic loader — stateful parsers across transcript rebuilds", () => {
  afterEach(() => {
    setDynamicParserResultNotifier(null);
    if (currentWorker) {
      for (const type of [
        "fake-adapter-settle",
        "fake-adapter-borders",
        "fake-adapter-transcript",
        "fake-adapter-pending",
        "fake-adapter-reclassify",
        "fake-adapter-large",
      ]) {
        invalidateDynamicParser(type);
      }
      currentWorker = null;
    }
    vi.unstubAllGlobals();
  });

  it("returns parsed entries synchronously on the rebuild that follows the worker round-trip", async () => {
    const parserModule = await loadStatefulParser("fake-adapter-settle");

    // Build 1: nothing is cached yet, so lines come back unparsed while the
    // requests travel to the worker.
    const first = parserModule.createStdoutParser();
    expect(first.parseLine("OPEN", "t1")).toEqual([]);
    expect(first.parseLine(" wrapped thought", "t1")).toEqual([]);
    first.reset?.();

    await settle();

    // Build 2 replays the same lines. It must see the results that arrived,
    // otherwise the notification that triggered this rebuild triggers another
    // one forever and the transcript never renders parsed output.
    const second = parserModule.createStdoutParser();
    expect(second.parseLine("OPEN", "t1")).toEqual([]);
    expect(second.parseLine(" wrapped thought", "t1")).toEqual([
      { kind: "thinking", ts: "t1", text: " wrapped thought", delta: true },
    ]);
    second.reset?.();
  });

  it("feeds repeated identical border lines to the stateful parser", async () => {
    const parserModule = await loadStatefulParser("fake-adapter-borders");

    const build = parserModule.createStdoutParser();
    // Two Reasoning boxes in one stream: identical border text, so a cache
    // keyed on line content alone would skip the second OPEN and leave the
    // second box's body classified as assistant output.
    const seen = LINES.map((line) => build.parseLine(line, "t1"));
    expect(seen.every((entries) => entries.length === 0)).toBe(true);
    build.reset?.();

    await settle();

    const rebuilt = parserModule.createStdoutParser();
    expect(rebuilt.parseLine(LINES[0], "t1")).toEqual([]);
    expect(rebuilt.parseLine(LINES[1], "t1")).toEqual([
      { kind: "thinking", ts: "t1", text: LINES[1], delta: true },
    ]);
    expect(rebuilt.parseLine(LINES[2], "t1")).toEqual([]);
    expect(rebuilt.parseLine(LINES[3], "t1")).toEqual([
      { kind: "assistant", ts: "t1", text: LINES[3] },
    ]);
    rebuilt.reset?.();
  });

  it("buildTranscript over the dynamic module settles on a parsed transcript", async () => {
    const parserModule = await loadStatefulParser("fake-adapter-transcript");
    const chunks = lineChunks(LINES, "2026-06-29T12:00:00.000Z");

    const first = buildTranscript(chunks, parserModule);
    // Nothing is cached on the first pass: every miss returns [], so the
    // transcript renders empty until the worker's results come back.
    expect(first).toEqual([]);

    await settle();

    // The rebuild the UI runs once results arrive must show the parsed kinds.
    const second = buildTranscript(chunks, parserModule);
    expect(second.map((entry) => entry.kind)).toEqual(["thinking", "assistant"]);
  });

  it("does not let a previous build's pending border swallow this build's border request", async () => {
    const parserModule = await loadStatefulParser("fake-adapter-pending");

    // Build 1 sends the opening border and stops there, so the request is
    // still in flight.
    const first = parserModule.createStdoutParser();
    first.parseLine(LINES[0]!, "t1");
    expect(currentWorker?.parseRequests).toBe(1);

    // Build 2 starts before build 1's request is answered. Its border request
    // must still reach the worker: the worker builds a fresh parser for this
    // build id, and a border that never reaches it leaves the whole box
    // classified as assistant output.
    const second = parserModule.createStdoutParser();
    second.parseLine(LINES[0]!, "t1");
    expect(currentWorker?.parseRequests).toBe(2);
    second.parseLine(LINES[1]!, "t1");
    expect(currentWorker?.parseRequests).toBe(3);
    second.reset?.();

    await settle();

    // The next build renders the box the way build 2's complete feed
    // classified it, which is only true if build 2 fed the border.
    const third = parserModule.createStdoutParser();
    expect(third.parseLine(LINES[0]!, "t1")).toEqual([]);
    expect(third.parseLine(LINES[1]!, "t1")).toEqual([
      { kind: "thinking", ts: "t1", text: LINES[1], delta: true },
    ]);
    third.reset?.();
  });

  it("reclassifies a body line whose border was truncated in the previous build", async () => {
    const parserModule = await loadStatefulParser("fake-adapter-reclassify");

    // Warm the cache on a build whose border line was cut off mid-chunk, so it
    // is not a border at all and the body line that follows is assistant text.
    const truncated = lineChunks(["plain", LINES[1]!], "t1");
    buildTranscript(truncated, parserModule);
    await settle();
    countRecomputes();

    expect(buildTranscript(truncated, parserModule).map((entry) => entry.kind)).toEqual([
      "assistant",
      "assistant",
    ]);
    expect(recomputes).toBe(0);
    countRecomputes();

    // Replacing that chunk with a complete border leaves the body line with the
    // same position, timestamp, and text — so it is still a cache hit and still
    // returns the assistant classification it already had — but the worker now
    // classifies it as thinking, and that difference must be reported.
    const complete = lineChunks([LINES[0]!, LINES[1]!], "t1");
    expect(buildTranscript(complete, parserModule).map((entry) => entry.kind)).toEqual(["assistant"]);

    await settle();
    expect(recomputes).toBeGreaterThan(0);
    countRecomputes();

    // The rebuild the correction triggered sees the reclassified line.
    expect(buildTranscript(complete, parserModule).map((entry) => entry.kind)).toEqual(["thinking"]);

    // And the corrected cache agrees with the worker, so nothing re-fires.
    await settle();
    countRecomputes();
    buildTranscript(complete, parserModule);
    expect(recomputes).toBe(0);
  });

  it("keeps a transcript longer than the old cache bound settled across rebuilds", async () => {
    const parserModule = await loadStatefulParser("fake-adapter-large");
    countRecomputes();

    // 3,000 Reasoning boxes: 9,000 parsed occurrences, more than the 8,192
    // entry bound the cache used to clear itself at.
    const boxes: string[] = [];
    for (let index = 0; index < 3000; index += 1) {
      boxes.push(LINES[0]!, ` wrapped thought ${index}`, LINES[2]!);
    }
    const chunks = lineChunks(boxes, "2026-06-29T12:00:00.000Z");

    buildTranscript(chunks, parserModule);
    await settle(60_000);

    // Two back-to-back rebuilds with no worker round trip between them — the
    // shape a scroll or a streaming tick produces. Waiting for the worker here
    // would mask the bug: the resolutions from the previous build land after
    // its reset and refill the cleared cache, so the next build looks served
    // from cache when it is not. The reset at the end of the first rebuild
    // must not wipe that build's entries, or the second misses all 9,000 lines
    // and renders the raw stream again — then refills, then clears, forever.
    const rebuild = buildTranscript(chunks, parserModule);
    expect(rebuild.length).toBeGreaterThan(0);
    expect(rebuild.some((entry) => entry.kind !== "thinking")).toBe(false);

    const again = buildTranscript(chunks, parserModule);
    expect(again.length).toBe(rebuild.length);
    expect(again.some((entry) => entry.kind !== "thinking")).toBe(false);

    // And once settled it stays settled: no further rebuild is scheduled.
    await settle(60_000);
    countRecomputes();
    buildTranscript(chunks, parserModule);
    await settle(60_000);
    expect(recomputes).toBe(0);
  });
});
