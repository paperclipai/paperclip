import { describe, expect, it } from "vitest";
import { parseHermesStdoutLine } from "./parse-stdout.js";

const TS = "2026-06-29T12:00:00.000Z";

describe("parseHermesStdoutLine — ANSI stripping", () => {
  it("strips 24-bit foreground + background color CSI sequences", () => {
    const result = parseHermesStdoutLine(
      "\x1b[38;2;255;255;255;48;2;19;87;20m+r = curl(\"POST\", \"/api/issues/d7b08cc5/comments\",\x1b[0m",
      TS,
    );
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      for (const v of Object.values(entry)) {
        if (typeof v === "string") {
          expect(v).not.toMatch(/\x1b\[/);
        }
      }
    }
  });

  it("strips bold yellow CSI sequence from Hermes header", () => {
    const result = parseHermesStdoutLine("\x1b[1;38;2;255;215;0m- Hermes\x1b[0m", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("text", "- Hermes");
  });

  it("strips light text CSI sequence", () => {
    const result = parseHermesStdoutLine(
      "\x1b[38;2;255;248;220mAll done. Now let me verify.\x1b[0m",
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("text", "All done. Now let me verify.");
  });

  it("passes through clean text unchanged", () => {
    const result = parseHermesStdoutLine("Normal text without ANSI", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("text", "Normal text without ANSI");
  });

  it("strips multiple CSI sequences on a single line", () => {
    const result = parseHermesStdoutLine(
      "\x1b[38;2;255;255;255;48;2;19;87;20m+ \"priority\": \"highest\",\x1b[0m \x1b[38;2;255;255;255;48;2;19;87;20m+r = curl(\"PATCH\", ...\x1b[0m",
      TS,
    );
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      for (const v of Object.values(entry)) {
        if (typeof v === "string") {
          expect(v).not.toMatch(/\x1b\[/);
        }
      }
    }
  });

  it("still parses tool completion lines correctly after stripping", () => {
    const result = parseHermesStdoutLine("\u250a \u{1f50d} search \"pattern\" 0.5s", TS);
    expect(result.length).toBeGreaterThanOrEqual(2);
    const toolCall = result.find((e) => e.kind === "tool_call");
    expect(toolCall?.name).toBe("search");
  });

  it("still parses shell tool lines correctly after stripping", () => {
    const result = parseHermesStdoutLine("\u250a $ ls -la 0.3s", TS);
    const toolCall = result.find((e) => e.kind === "tool_call");
    expect(toolCall?.name).toBe("shell");
  });

  it("strips OSC title sequences", () => {
    const result = parseHermesStdoutLine("\x1b]0;Terminal Title\x07Actual content", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("text", "Actual content");
  });

  it("handles empty lines after ANSI stripping", () => {
    const result = parseHermesStdoutLine("\x1b[0m", TS);
    expect(result).toHaveLength(0);
  });
});

describe("stream-json output", () => {
  // The adapter runs with --output-format stream-json, so stdout is one JSON
  // event per line. These events must become the same transcript entries the
  // quiet-mode patterns produce; raw JSON must never reach the UI.

  it("turns an assistant text event into an assistant entry", () => {
    const line = JSON.stringify({ type: "assistant", subtype: "text", text: "Die Antwort." });
    expect(parseHermesStdoutLine(line, TS)).toEqual([{ kind: "assistant", ts: TS, text: "Die Antwort." }]);
  });

  it("turns tool_use and tool_result events into a matching pair", () => {
    const use = parseHermesStdoutLine(
      JSON.stringify({ type: "tool_use", tool_use_id: "tu_01", name: "terminal", input: { command: "ls" } }),
      TS,
    );
    expect(use).toEqual([
      { kind: "tool_call", ts: TS, name: "terminal", toolUseId: "tu_01", input: { command: "ls" } },
    ]);
    const result = parseHermesStdoutLine(
      JSON.stringify({ type: "tool_result", tool_use_id: "tu_01", content: "file.txt", is_error: false }),
      TS,
    );
    expect(result).toEqual([
      { kind: "tool_result", ts: TS, toolUseId: "tu_01", content: "file.txt", isError: false },
    ]);
  });

  it("marks erroring tool results", () => {
    const result = parseHermesStdoutLine(
      JSON.stringify({ type: "tool_result", tool_use_id: "tu_02", content: "exit 1", is_error: true }),
      TS,
    );
    expect(result[0]).toMatchObject({ kind: "tool_result", isError: true });
  });

  it("drops init, thinking and result events instead of showing them raw", () => {
    expect(parseHermesStdoutLine(JSON.stringify({ type: "system", subtype: "init", session_id: "x" }), TS)).toEqual([]);
    expect(
      parseHermesStdoutLine(JSON.stringify({ type: "assistant", subtype: "thinking", thinking_delta: "{}" }), TS),
    ).toEqual([]);
    expect(
      parseHermesStdoutLine(JSON.stringify({ type: "result", text: "done", tokens: { input: 1 } }), TS),
    ).toEqual([]);
  });

  it("keeps assistant answers that are themselves JSON visible", () => {
    // A text-mode answer like {"status":"done"} is content, not an event:
    // it must reach the assistant fallback instead of being dropped.
    const line = '{"status":"done"}';
    expect(parseHermesStdoutLine(line, TS)).toEqual([{ kind: "assistant", ts: TS, text: line }]);
  });

  it("keeps unknown event types visible instead of dropping them", () => {
    const line = JSON.stringify({ type: "mystery", payload: 1 });
    expect(parseHermesStdoutLine(line, TS)).toEqual([{ kind: "assistant", ts: TS, text: line }]);
  });

  it("falls back to quiet-mode parsing for lines that are not JSON", () => {
    // Older Hermes builds (and the adapter's own [hermes] log lines) are not
    // JSON and must keep parsing as before.
    expect(parseHermesStdoutLine("[hermes] Session: abc", TS)).toEqual([
      { kind: "system", ts: TS, text: "[hermes] Session: abc" },
    ]);
  });
});
