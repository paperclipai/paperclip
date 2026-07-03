import { describe, expect, it } from "vitest";
import { parseEveStdoutLine } from "./parse-stdout.js";

const TS = "2026-07-03T00:00:00.000Z";

function wrap(event: Record<string, unknown>): string {
  return JSON.stringify({ type: "eve.event", event });
}

describe("parseEveStdoutLine", () => {
  it("maps eve.init to an init entry", () => {
    const line = JSON.stringify({
      type: "eve.init",
      sessionId: "sess-1",
      baseUrl: "http://127.0.0.1:3000",
      model: "gpt-5",
    });
    expect(parseEveStdoutLine(line, TS)).toEqual([
      { kind: "init", ts: TS, model: "gpt-5", sessionId: "sess-1" },
    ]);
  });

  it("maps message.appended to a streaming assistant delta", () => {
    const entries = parseEveStdoutLine(
      wrap({ type: "message.appended", data: { delta: "Hel", cumulativeText: "Hel" } }),
      TS,
    );
    expect(entries).toEqual([{ kind: "assistant", ts: TS, text: "Hel", delta: true }]);
  });

  it("maps message.completed to a finalized assistant message", () => {
    const entries = parseEveStdoutLine(
      wrap({ type: "message.completed", data: { text: "Hello world", finishReason: "stop" } }),
      TS,
    );
    expect(entries).toEqual([{ kind: "assistant", ts: TS, text: "Hello world" }]);
  });

  it("maps reasoning events to thinking entries", () => {
    expect(
      parseEveStdoutLine(wrap({ type: "reasoning.appended", data: { delta: "hmm" } }), TS),
    ).toEqual([{ kind: "thinking", ts: TS, text: "hmm", delta: true }]);
    expect(
      parseEveStdoutLine(wrap({ type: "reasoning.completed", data: { text: "decided" } }), TS),
    ).toEqual([{ kind: "thinking", ts: TS, text: "decided" }]);
  });

  it("maps actions.requested to one tool_call per action", () => {
    const entries = parseEveStdoutLine(
      wrap({
        type: "actions.requested",
        data: {
          actions: [
            { id: "a1", name: "search", input: { q: "eve" } },
            { id: "a2", name: "readFile", input: { path: "x" } },
          ],
        },
      }),
      TS,
    );
    expect(entries).toEqual([
      { kind: "tool_call", ts: TS, name: "search", toolUseId: "a1", input: { q: "eve" } },
      { kind: "tool_call", ts: TS, name: "readFile", toolUseId: "a2", input: { path: "x" } },
    ]);
  });

  it("maps action.result to a tool_result entry", () => {
    const entries = parseEveStdoutLine(
      wrap({ type: "action.result", data: { id: "a1", name: "search", result: "found it" } }),
      TS,
    );
    expect(entries).toEqual([
      {
        kind: "tool_result",
        ts: TS,
        toolUseId: "a1",
        toolName: "search",
        content: "found it",
        isError: false,
      },
    ]);
  });

  it("maps input.requested to a highlighted system entry", () => {
    const entries = parseEveStdoutLine(
      wrap({ type: "input.requested", data: { prompt: "Approve deploy?" } }),
      TS,
    );
    expect(entries).toEqual([
      { kind: "system", ts: TS, text: "Agent is waiting for human input: Approve deploy?" },
    ]);
  });

  it("maps failure events to stderr entries with the data message", () => {
    for (const type of ["step.failed", "turn.failed", "session.failed"]) {
      const entries = parseEveStdoutLine(
        wrap({ type, data: { code: "boom", message: "model exploded" } }),
        TS,
      );
      expect(entries).toEqual([
        { kind: "stderr", ts: TS, text: `${type} [boom]: model exploded` },
      ]);
    }
  });

  it("maps eve.result to a result entry with error status detection", () => {
    const ok = parseEveStdoutLine(
      JSON.stringify({ type: "eve.result", status: "completed", summary: "Done" }),
      TS,
    );
    expect(ok[0]).toMatchObject({ kind: "result", subtype: "completed", isError: false, text: "Done" });

    const bad = parseEveStdoutLine(
      JSON.stringify({ type: "eve.result", status: "error", error: "kaput" }),
      TS,
    );
    expect(bad[0]).toMatchObject({ kind: "result", isError: true, errors: ["kaput"] });
  });

  it("passes garbage lines through as stdout entries", () => {
    expect(parseEveStdoutLine("not json at all", TS)).toEqual([
      { kind: "stdout", ts: TS, text: "not json at all" },
    ]);
    expect(parseEveStdoutLine(JSON.stringify({ type: "mystery.event" }), TS)).toEqual([
      { kind: "stdout", ts: TS, text: JSON.stringify({ type: "mystery.event" }) },
    ]);
  });

  it("skips lifecycle noise events", () => {
    for (const type of ["session.started", "turn.started", "step.started", "session.waiting", "step.completed"]) {
      expect(parseEveStdoutLine(wrap({ type, data: {} }), TS)).toEqual([]);
    }
  });
});
