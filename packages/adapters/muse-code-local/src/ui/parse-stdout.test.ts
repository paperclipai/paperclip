import { describe, expect, it } from "vitest";
import { createMuseCodeStdoutParser, parseMuseCodeStdoutLine } from "./parse-stdout.js";

const TS = "2026-10-20T00:00:00.000Z";

function line(payloadType: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ stream: { kind: "session", id: "session-1" }, payload_type: payloadType, payload });
}

describe("parseMuseCodeStdoutLine", () => {
  it("maps model configuration to init", () => {
    expect(parseMuseCodeStdoutLine(line("run.model.configured", { model_id: "muse-wonder-full-1.0" }), TS)).toEqual([
      { kind: "init", ts: TS, model: "muse-wonder-full-1.0", sessionId: "session-1" },
    ]);
  });

  it("maps output deltas to assistant entries", () => {
    expect(parseMuseCodeStdoutLine(line("run.output.delta", { text: "hi" }), TS)).toEqual([
      { kind: "assistant", ts: TS, text: "hi", delta: true },
    ]);
  });

  it("maps tool proposals and results", () => {
    expect(
      parseMuseCodeStdoutLine(
        line("task.lifecycle.proposed", { event: { kind: "proposed", task_id: "task-1", task_kind: "tool.write_file" } }),
        TS,
      ),
    ).toEqual([{ kind: "tool_call", ts: TS, name: "write_file", toolUseId: "task-1", input: {} }]);

    expect(
      parseMuseCodeStdoutLine(
        line("tool.result", {
          call_id: "call-1",
          text: "wrote 12 bytes",
          correlation_facts: { tool_name: "write_file", outcome: "success" },
        }),
        TS,
      ),
    ).toEqual([
      { kind: "tool_result", ts: TS, toolUseId: "call-1", toolName: "write_file", content: "wrote 12 bytes", isError: false },
    ]);
  });

  it("drops lifecycle bookkeeping and keeps plain lines as stdout", () => {
    expect(parseMuseCodeStdoutLine(line("task.lifecycle.started", { event: { kind: "started" } }), TS)).toEqual([]);
    expect(parseMuseCodeStdoutLine(" plain log ", TS)).toEqual([{ kind: "stdout", ts: TS, text: " plain log " }]);
  });
});

describe("createMuseCodeStdoutParser", () => {
  it("carries usage into the terminal result entry", () => {
    const parser = createMuseCodeStdoutParser();
    parser.parseLine(line("run.usage", { models: [{ input_tokens: 100, cached_tokens: 25, output_tokens: 10, reasoning_tokens: 5 }] }), TS);
    const entries = parser.parseLine(
      line("run.terminal.completed", { kind: "run_terminal", terminal: "completed", text: "done" }),
      TS,
    );
    expect(entries).toEqual([
      {
        kind: "result",
        ts: TS,
        text: "done",
        inputTokens: 75,
        outputTokens: 15,
        cachedTokens: 25,
        costUsd: 0,
        subtype: "completed",
        isError: false,
        errors: [],
      },
    ]);
  });
});
