import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createStdoutParser,
  parseHermesStdoutLine,
  resetHermesStdoutParser,
} from "./parse-stdout.js";

const TS = "2026-06-29T12:00:00.000Z";

// ── Reasoning box fixtures ────────────────────────────────────────────────
// Shapes verified from a production quiet-mode run log (run 22e178e0).

function reasoningBorder(width = 80): string {
  return `┌─ Reasoning ${"─".repeat(Math.max(1, width - 15))}┐`;
}

function closingBorder(width = 80): string {
  return `└${"─".repeat(Math.max(1, width - 2))}┘`;
}

/** Shape of the fields these tests assert on (subset of TranscriptEntry). */
type TestEntry = { kind: string; ts?: string; text?: string; delta?: boolean };
type LineParser = { parseLine: (line: string, ts: string) => readonly unknown[] };

/** Feed a chunk stream through the framework's line split, then the parser. */
function parseChunks(parser: LineParser, chunks: string[]): TestEntry[] {
  const entries: TestEntry[] = [];
  let buffer = "";
  for (const chunk of chunks) {
    const lines = (buffer + chunk).split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      entries.push(...(parser.parseLine(trimmed, TS) as TestEntry[]));
    }
  }
  const trailing = buffer.trim();
  if (trailing) {
    entries.push(...(parser.parseLine(trailing, TS) as TestEntry[]));
  }
  return entries;
}

/**
 * Join coalescable thinking entries the way appendTranscriptEntry does
 * (delta entries append with no separator) so tests assert on rendered text.
 */
function coalescedThinkingText(entries: TestEntry[]): string {
  let text = "";
  for (const entry of entries) {
    if (entry.kind !== "thinking") continue;
    if (entry.delta) {
      text += entry.text ?? "";
      continue;
    }
    text += `${text ? "\n" : ""}${entry.text ?? ""}`;
  }
  return text;
}

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

describe("parseHermesStdoutLine — Reasoning box", () => {
  beforeEach(() => {
    resetHermesStdoutParser();
  });

  it("parses a full box into thinking entries only", () => {
    const parser = createStdoutParser();
    const entries = parseChunks(parser, [
      `${reasoningBorder()}\r\n`,
      " First wrapped line of reasoning.\r\n",
      "\r\n",
      " Second wrapped line continues the thought\r\n",
      "and wraps without a trailing space.\r\n",
      `${closingBorder()}\r\n`,
      "  ┊ 💬 Here is the answer.\r\n",
    ]);

    const kinds = entries.map((e) => e.kind);
    // Every box line is thinking; the only assistant entry is the trailing
    // ┊ 💬 bubble that follows the closed box.
    expect(kinds).toEqual(["thinking", "thinking", "thinking", "assistant"]);
    expect(entries.filter((e) => e.kind === "thinking").length).toBeGreaterThan(0);

    const assistant = entries.filter((e) => e.kind === "assistant");
    expect(assistant).toEqual([
      { kind: "assistant", ts: TS, text: "Here is the answer." },
    ]);

    const joined = coalescedThinkingText(entries);
    expect(joined).toContain("First wrapped line of reasoning.");
    expect(joined).toContain("Second wrapped line continues the thought\nand wraps without a trailing space.");
    expect(joined).not.toContain("┌");
    expect(joined).not.toContain("└");
    expect(joined).not.toContain("┐");
    expect(joined).not.toContain("┘");
  });

  it("marks every interior line as a coalescable delta", () => {
    const parser = createStdoutParser();
    const entries = parseChunks(parser, [
      `${reasoningBorder()}\n`,
      " alpha\n",
      " beta\n",
      " gamma\n",
      `${closingBorder()}\n`,
    ]);

    // One entry per wrapped line — the UI's appendTranscriptEntry merges the
    // consecutive delta entries into a single thinking bubble. The chain head
    // must itself be a delta: appendTranscriptEntry refuses to merge into a
    // non-delta entry, so a `delta: false` first line would split every box
    // into two bubbles.
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.delta)).toEqual([true, true, true]);
    expect(entries.map((e) => e.text)).toEqual(["alpha\n", "beta\n", "gamma\n"]);
    // No separator is lost when the UI concatenates delta text.
    expect(coalescedThinkingText(entries)).toBe("alpha\nbeta\ngamma\n");
  });

  it("keeps two adjacent boxes in one thinking chain", () => {
    const parser = createStdoutParser();
    const entries = parseChunks(parser, [
      `${reasoningBorder()}\n`,
      " first box body\n",
      " first box tail\n",
      `${closingBorder()}\n`,
      `${reasoningBorder()}\n`,
      " second box body\n",
      `${closingBorder()}\n`,
    ]);

    // No assistant entry separates the boxes, and the delta contract cannot
    // start a new segment within one kind — the second box's lines stay in the
    // same coalescable chain as the first. That renders as a single bubble
    // holding both boxes' reasoning; fragmenting each box in two (a non-delta
    // chain head) would be worse. Reasoning boxes are normally separated by
    // the model's answer text, which does start a fresh region.
    expect(entries.map((e) => e.kind)).toEqual(["thinking", "thinking", "thinking"]);
    expect(entries.map((e) => e.delta)).toEqual([true, true, true]);
    expect(entries[2]?.text).toContain("second box body");
    expect(coalescedThinkingText(entries)).toBe(
      "first box body\nfirst box tail\nsecond box body\n",
    );
  });

  it("emits nothing for a standalone opening or closing border", () => {
    const parser = createStdoutParser();
    expect(parser.parseLine(reasoningBorder(), TS)).toEqual([]);
    expect(parser.parseLine(closingBorder(), TS)).toEqual([]);
    // A border of a different width is still a border.
    expect(parser.parseLine(reasoningBorder(40), TS)).toEqual([]);
    expect(parser.parseLine(closingBorder(40), TS)).toEqual([]);
  });

  it("handles the closing border glued to the last text line", () => {
    const parser = createStdoutParser();
    const entries = parseChunks(parser, [
      `${reasoningBorder()}\n`,
      " lead with the answer.\n└────────────────┘\n",
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "thinking",
      text: "lead with the answer.\n",
      delta: true,
    });
    expect(coalescedThinkingText(entries)).not.toContain("└");
    // The box is closed: a later plain line is assistant text again.
    expect(parser.parseLine("plain answer text", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "plain answer text" },
    ]);
  });

  it("keeps classifying interior lines as thinking when the box never closes", () => {
    const parser = createStdoutParser();
    const entries = parseChunks(parser, [
      `${reasoningBorder()}\n`,
      " still deciding\n",
      " Error: this looks like an error line but is not\n",
      " more reasoning\n",
    ]);

    expect(entries.map((e) => e.kind)).toEqual([
      "thinking",
      "thinking",
      "thinking",
    ]);
    expect(coalescedThinkingText(entries)).toContain(
      "Error: this looks like an error line but is not",
    );
  });

  it("parses two consecutive boxes", () => {
    const parser = createStdoutParser();
    const entries = parseChunks(parser, [
      `${reasoningBorder()}\n`,
      " first box body\n",
      `${closingBorder()}\n`,
      "  ┊ 💬 Interim answer.\n",
      `${reasoningBorder()}\n`,
      " second box body\n",
      `${closingBorder()}\n`,
      "  ┊ 💬 Final answer.\n",
    ]);

    expect(entries.map((e) => e.kind)).toEqual([
      "thinking",
      "assistant",
      "thinking",
      "assistant",
    ]);
    expect(coalescedThinkingText(entries)).toContain("first box body");
    expect(coalescedThinkingText(entries)).toContain("second box body");
  });

  it("strips ANSI from border and interior lines", () => {
    const parser = createStdoutParser();
    const entries = parseChunks(parser, [
      `\x1b[2m${reasoningBorder()}\x1b[0m\n`,
      "\x1b[2m dim reasoning line \x1b[0m\n",
      `\x1b[2m${closingBorder()}\x1b[0m\n`,
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "thinking", text: "dim reasoning line\n" });
  });

  it("treats tool lines inside a box as reasoning, not tool calls", () => {
    const parser = createStdoutParser();
    const entries = parseChunks(parser, [
      `${reasoningBorder()}\n`,
      "  ┊ 💻 $ ls -la 0.3s\n",
      `${closingBorder()}\n`,
    ]);

    expect(entries.map((e) => e.kind)).toEqual(["thinking"]);
    expect(coalescedThinkingText(entries)).toContain("ls -la");
  });

  it("reset clears an unclosed box so later lines parse normally", () => {
    const parser = createStdoutParser();
    parser.parseLine(reasoningBorder(), TS);
    parser.parseLine(" dangling reasoning\n", TS);
    parser.reset();
    expect(parser.parseLine("back to assistant", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "back to assistant" },
    ]);
  });

  it("keeps Reasoning-box state on the shared default instance", () => {
    expect(parseHermesStdoutLine(reasoningBorder(), TS)).toEqual([]);
    expect(parseHermesStdoutLine(" shared instance body", TS)).toEqual([
      { kind: "thinking", ts: TS, text: "shared instance body\n", delta: true },
    ]);
    expect(parseHermesStdoutLine(closingBorder(), TS)).toEqual([]);
    expect(parseHermesStdoutLine("after the box", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "after the box" },
    ]);
  });

  it("does not regress assistant and tool parsing after a box", () => {
    const parser = createStdoutParser();
    parseChunks(parser, [`${reasoningBorder()}\n`, " body\n", `${closingBorder()}\n`]);

    expect(parser.parseLine("  ┊ 💬 Answer text", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "Answer text" },
    ]);
    const tool = parser.parseLine("┊ 🔍 search \"pattern\" 0.5s", TS);
    expect(tool.map((e) => e.kind)).toEqual(["tool_call", "tool_result"]);
    expect(tool[0]).toMatchObject({ kind: "tool_call", name: "search" });
    expect(parser.parseLine("[hermes] session started", TS)).toEqual([
      { kind: "system", ts: TS, text: "[hermes] session started" },
    ]);
    expect(parser.parseLine("Error: real failure", TS)).toEqual([
      { kind: "stderr", ts: TS, text: "Error: real failure" },
    ]);
  });
});

describe("ui-parser.cjs mirror parity", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mirrorPath = path.resolve(here, "../../ui-parser.cjs");

  function loadMirror(): LineParser {
    const source = readFileSync(mirrorPath, "utf8");
    const moduleShim = { exports: {} as Record<string, unknown> };
    const context = vm.createContext({ module: moduleShim, exports: moduleShim.exports });
    vm.runInContext(source, context, { filename: "ui-parser.cjs" });
    const resolved = moduleShim.exports as {
      parseStdoutLine?: unknown;
      createStdoutParser?: () => LineParser;
    };
    expect(typeof resolved.parseStdoutLine).toBe("function");
    expect(typeof resolved.createStdoutParser).toBe("function");
    return resolved.createStdoutParser!();
  }

  it("exports both parseStdoutLine and createStdoutParser", () => {
    const source = readFileSync(mirrorPath, "utf8");
    expect(source).toContain("module.exports = { parseStdoutLine, createStdoutParser }");
  });

  it("behaves identically to the TypeScript parser on box fixtures", () => {
    const chunks = [
      `${reasoningBorder()}\n`,
      " wrapped reasoning one\n",
      "\n",
      " wrapped reasoning two continues\n",
      " lead with the answer.\n└────────────┘\n",
      "  ┊ 💬 Answer.\n",
      `${reasoningBorder(40)}\n`,
      " unclosed second box\n",
    ];

    const tsEntries = parseChunks(createStdoutParser(), chunks);
    const mirrorEntries = parseChunks(loadMirror(), chunks);

    expect(mirrorEntries).toEqual(tsEntries);
    expect(tsEntries.length).toBeGreaterThan(0);
    expect(tsEntries.every((e) => e.kind === "thinking" || e.kind === "assistant")).toBe(true);
  });

  it("mirror borders emit nothing, matching the TypeScript parser", () => {
    const mirror = loadMirror();
    expect(mirror.parseLine(reasoningBorder(), TS)).toEqual([]);
    expect(mirror.parseLine(closingBorder(), TS)).toEqual([]);
  });
});
