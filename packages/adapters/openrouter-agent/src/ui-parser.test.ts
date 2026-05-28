import { describe, expect, it } from "vitest";
import { parseStdoutLine } from "./ui-parser.js";

const TS = "2026-05-04T00:00:00.000Z";

describe("parseStdoutLine", () => {
  it("returns nothing for empty input", () => {
    expect(parseStdoutLine("", TS)).toEqual([]);
    expect(parseStdoutLine("   ", TS)).toEqual([]);
  });

  it("passes plain text through as a stdout entry", () => {
    expect(parseStdoutLine("hello world", TS)).toEqual([
      { kind: "stdout", ts: TS, text: "hello world" },
    ]);
  });

  it("parses a known-kind JSON line as the corresponding entry", () => {
    const line = JSON.stringify({
      kind: "assistant",
      ts: "2030-01-01T00:00:00.000Z",
      text: "hi",
    });
    expect(parseStdoutLine(line, TS)).toEqual([
      { kind: "assistant", ts: "2030-01-01T00:00:00.000Z", text: "hi" },
    ]);
  });

  it("falls back to stdout for JSON without a known kind", () => {
    const line = JSON.stringify({ kind: "??", ts: TS, text: "x" });
    expect(parseStdoutLine(line, TS)).toEqual([
      { kind: "stdout", ts: TS, text: line },
    ]);
  });

  it("falls back to stdout for invalid JSON that starts with '{'", () => {
    const line = "{not json";
    expect(parseStdoutLine(line, TS)).toEqual([
      { kind: "stdout", ts: TS, text: line },
    ]);
  });

  it("backfills ts when missing from the JSON payload", () => {
    const line = JSON.stringify({ kind: "system", text: "no ts" });
    expect(parseStdoutLine(line, TS)).toEqual([
      { kind: "system", ts: TS, text: "no ts" },
    ]);
  });
});
