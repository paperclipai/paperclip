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
