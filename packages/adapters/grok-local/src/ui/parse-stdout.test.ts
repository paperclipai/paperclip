import { describe, expect, it } from "vitest";
import { createGrokStdoutParser, parseGrokStdoutLine } from "./parse-stdout.js";

describe("parseGrokStdoutLine", () => {
  const ts = "2026-05-15T00:00:00.000Z";

  it("maps thought/text/end events into transcript entries", () => {
    expect(parseGrokStdoutLine(JSON.stringify({ type: "thought", data: "Plan first." }), ts)).toEqual([
      { kind: "thinking", ts, text: "Plan first.", delta: true },
    ]);
    expect(parseGrokStdoutLine(JSON.stringify({ type: "text", data: "hello" }), ts)).toEqual([
      { kind: "assistant", ts, text: "hello", delta: true },
    ]);
    expect(parseGrokStdoutLine(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1" }), ts)).toEqual([
      { kind: "system", ts, text: "stop_reason=EndTurn session=sess-1" },
    ]);
  });

  it("surfaces structured Grok error payload text", () => {
    expect(parseGrokStdoutLine(JSON.stringify({
      type: "error",
      error: { message: "Authentication required" },
    }), ts)).toEqual([
      { kind: "stderr", ts, text: "Authentication required" },
    ]);
  });
});

describe("createGrokStdoutParser", () => {
  const ts = "2026-05-15T00:00:00.000Z";

  function thoughtTexts(chunks: string[]): string {
    const parser = createGrokStdoutParser();
    return chunks
      .map((data) => parser.parseLine(JSON.stringify({ type: "thought", data }), ts))
      .flat()
      .map((entry) => entry.kind === "thinking" ? entry.text : "")
      .join("");
  }

  it("inserts a newline between reasoning turns that grok streaming-json glues together", () => {
    // Reproduces PAPA-349: token stream "...using `ls`" then a new turn "The `ls` command returned"
    expect(thoughtTexts(["The user uses `", "ls", "`", "The", " `", "ls", "`", " returned"]))
      .toBe("The user uses `ls`\nThe `ls` returned");
  });

  it("inserts a newline when a turn ends with a colon and the next turn starts capitalized", () => {
    expect(thoughtTexts(["returned", ":", "Confirmed", ":", " 4 files"]))
      .toBe("returned:\nConfirmed: 4 files");
  });

  it("resets state between independent transcript builds", () => {
    const parser = createGrokStdoutParser();
    parser.parseLine(JSON.stringify({ type: "thought", data: "first:" }), ts);
    parser.reset();
    expect(parser.parseLine(JSON.stringify({ type: "thought", data: "Second" }), ts)).toEqual([
      { kind: "thinking", ts, text: "Second", delta: true },
    ]);
  });

  it("does not modify assistant `text` chunks", () => {
    // PAPA-349 review feedback: keep final assistant text streaming verbatim;
    // the boundary heuristic is scoped to reasoning.
    const parser = createGrokStdoutParser();
    parser.parseLine(JSON.stringify({ type: "text", data: "Done." }), ts);
    expect(parser.parseLine(JSON.stringify({ type: "text", data: "Next" }), ts)).toEqual([
      { kind: "assistant", ts, text: "Next", delta: true },
    ]);
  });
});
