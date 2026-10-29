import { describe, expect, it } from "vitest";
import { createMuseStdoutParser, parseMuseStdoutLine } from "./parse-stdout.js";

describe("parseMuseStdoutLine", () => {
  it("parses non-json lines as stdout", () => {
    const entries = parseMuseStdoutLine("hello world", "2026-10-28T12:00:00Z");
    expect(entries).toEqual([{ kind: "stdout", ts: "2026-10-28T12:00:00Z", text: "hello world" }]);
  });

  it("parses init event", () => {
    const parser = createMuseStdoutParser();
    const line = JSON.stringify({
      payload_type: "run.model.configured",
      stream: { id: "sess-123" },
      payload: { model: "muse-wonder-1.0" }
    });
    const entries = parser.parseLine(line, "2026-10-28T12:00:00Z");
    expect(entries).toEqual([
      { kind: "init", ts: "2026-10-28T12:00:00Z", model: "muse-wonder-1.0", sessionId: "sess-123" }
    ]);
  });

  it("parses streaming assistant output deltas", () => {
    const parser = createMuseStdoutParser();
    const line = JSON.stringify({
      payload_type: "run.output.delta",
      payload: { text: "Thinking done" }
    });
    const entries = parser.parseLine(line, "2026-10-28T12:00:00Z");
    expect(entries).toEqual([
      { kind: "assistant", ts: "2026-10-28T12:00:00Z", text: "Thinking done", delta: true }
    ]);
  });

  it("parses tool intent, execution output, and result", () => {
    const parser = createMuseStdoutParser();
    const intentLine = JSON.stringify({
      payload_type: "task.lifecycle.side_effect_intent",
      payload: {
        task_id: "task-abc",
        event: {
          operation: "tool:bash",
          idempotency_key: "tool:call-123",
          task_id: "task-abc"
        }
      }
    });
    const entries1 = parser.parseLine(intentLine, "2026-10-28T12:00:01Z");
    expect(entries1).toEqual([
      { kind: "tool_call", ts: "2026-10-28T12:00:01Z", name: "bash", toolUseId: "call-123", input: {} }
    ]);

    const outputLine = JSON.stringify({
      payload_type: "task.lifecycle.output",
      payload: {
        task_id: "task-abc",
        event: {
          chunk: JSON.stringify({
            command: "ls -la",
            description: "List files",
            exit_code: 0,
            terminal_status: "completed",
            output: "file1.txt\nfile2.txt\n"
          })
        }
      }
    });
    const entries2 = parser.parseLine(outputLine, "2026-10-28T12:00:02Z");
    expect(entries2).toEqual([
      { kind: "tool_call", ts: "2026-10-28T12:00:02Z", name: "bash", toolUseId: "call-123", input: { command: "ls -la", description: "List files" } },
      { kind: "tool_result", ts: "2026-10-28T12:00:02Z", toolUseId: "call-123", content: "file1.txt\nfile2.txt\n", isError: false }
    ]);
  });
});
