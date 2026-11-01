import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { getWorkerBootstrapSource } from "./sandboxed-parser-worker";

describe("sandboxed parser worker bootstrap", () => {
  it("disables child worker and object URL escape hatches", () => {
    const source = getWorkerBootstrapSource();

    expect(source).toContain("self.Worker = _undefined");
    expect(source).toContain("self.SharedWorker = _undefined");
    expect(source).toContain("self.Blob = _undefined");
    expect(source).toContain("self.RTCPeerConnection = _undefined");
    expect(source).toContain("self.RTCDataChannel = _undefined");
    expect(source).toContain('"createObjectURL"');
    expect(source).toContain('"revokeObjectURL"');
  });

  it("evaluates parser source in strict mode", () => {
    expect(getWorkerBootstrapSource()).toContain('\\"use strict\\";\\n{\\n" + msg.source');
  });

  it("does not include the unused parse_batch protocol branch", () => {
    expect(getWorkerBootstrapSource()).not.toContain("parse_batch");
  });
});

// ── Functional harness: run the real bootstrap in a Node vm ────────────────

type PostedMessage = {
  type: string;
  id?: number;
  entries?: Array<{ kind: string; text?: string }>;
  message?: string;
};

/**
 * Execute the worker bootstrap source in a fresh vm context with a minimal
 * `self`, then drive it with the same messages the main thread sends.
 */
function startWorker(parserSource: string) {
  const posted: PostedMessage[] = [];
  const self: Record<string, unknown> = {
    navigator: {},
    postMessage: (msg: PostedMessage) => posted.push(msg),
  };
  vm.runInNewContext(getWorkerBootstrapSource(), { self });
  const onmessage = self.onmessage as (e: { data: unknown }) => void;
  expect(typeof onmessage).toBe("function");

  onmessage({ data: { type: "init", source: parserSource } });
  expect(posted.at(-1)).toMatchObject({ type: "ready" });

  return {
    parse(id: number, line: string, ts: string, buildId?: number) {
      onmessage({ data: { type: "parse", id, line, ts, buildId } });
      return posted.at(-1) as { type: string; id: number; entries: Array<{ kind: string; text?: string }> };
    },
  };
}

/**
 * A parser with cross-line state, shaped like the Hermes Reasoning-box
 * parser: an OPEN/CLOSE pair brackets lines that must stay thinking, and a
 * build that never closes must not contaminate the next one.
 */
const STATEFUL_PARSER_SOURCE = `
function createParser() {
  let open = false;
  return {
    parseLine(line, ts) {
      if (line === "OPEN") { open = true; return []; }
      if (line === "CLOSE") { open = false; return []; }
      if (open) return [{ kind: "thinking", ts, text: line }];
      return [{ kind: "assistant", ts, text: line }];
    },
    reset() { open = false; },
  };
}
const shared = createParser();
module.exports = {
  parseStdoutLine: shared.parseLine,
  createStdoutParser: createParser,
};
`;

describe("sandboxed parser worker build generations", () => {
  it("creates a fresh stateful parser when the buildId changes", () => {
    const worker = startWorker(STATEFUL_PARSER_SOURCE);

    // Build 1 ends with an unclosed region — the stream was cut off.
    expect(worker.parse(1, "OPEN", "t1", 1).entries).toEqual([]);
    expect(worker.parse(2, "secret thought", "t1", 1).entries).toEqual([
      { kind: "thinking", ts: "t1", text: "secret thought" },
    ]);

    // Build 2 (the next transcript build) must not inherit that open region.
    expect(worker.parse(3, "plain assistant text", "t2", 2).entries).toEqual([
      { kind: "assistant", ts: "t2", text: "plain assistant text" },
    ]);
  });

  it("keeps state across lines within one build", () => {
    const worker = startWorker(STATEFUL_PARSER_SOURCE);

    expect(worker.parse(1, "OPEN", "t1", 7).entries).toEqual([]);
    expect(worker.parse(2, "still open", "t1", 7).entries).toEqual([
      { kind: "thinking", ts: "t1", text: "still open" },
    ]);
  });

  it("keeps the legacy behaviour for parse calls without a buildId", () => {
    const worker = startWorker(STATEFUL_PARSER_SOURCE);

    expect(worker.parse(1, "OPEN", "t1").entries).toEqual([]);
    // No buildId means the shared module-level parser: state carries over.
    expect(worker.parse(2, "legacy stream", "t1").entries).toEqual([
      { kind: "thinking", ts: "t1", text: "legacy stream" },
    ]);
  });

  it("falls back to the module parse function for sources without createStdoutParser", () => {
    const worker = startWorker(`
      module.exports = {
        parseStdoutLine(line, ts) {
          return [{ kind: "assistant", ts, text: line }];
        },
      };
    `);

    expect(worker.parse(1, "hello", "t1", 1).entries).toEqual([
      { kind: "assistant", ts: "t1", text: "hello" },
    ]);
  });
});
