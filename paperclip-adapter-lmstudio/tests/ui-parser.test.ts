import { describe, it, expect } from "vitest";
import { createStdoutParser } from "../src/ui-parser.js";

describe("createStdoutParser", () => {
  it("parses assistant text tokens", () => {
    const parser = createStdoutParser();
    const entries = parser.parseLine("Hello world", "2026-04-16T12:00:00Z");
    expect(entries).toEqual([
      { kind: "assistant", ts: "2026-04-16T12:00:00Z", text: "Hello world", delta: true },
    ]);
  });

  it("skips empty lines", () => {
    const parser = createStdoutParser();
    const entries = parser.parseLine("", "2026-04-16T12:00:00Z");
    expect(entries).toEqual([]);
  });

  it("resets state", () => {
    const parser = createStdoutParser();
    parser.parseLine("test", "2026-04-16T12:00:00Z");
    parser.reset();
    const entries = parser.parseLine("after reset", "2026-04-16T12:00:00Z");
    expect(entries).toHaveLength(1);
  });
});

describe("createStdoutParser — tool events", () => {
  it("parses tool_call JSON lines", () => {
    const parser = createStdoutParser();
    const line = JSON.stringify({
      kind: "tool_call",
      name: "fs_write_file",
      input: { path: "a.txt", content: "x" },
      toolUseId: "call_1",
    });
    const entries = parser.parseLine(line, "2026-04-18T12:00:00Z");
    expect(entries).toEqual([
      {
        kind: "tool_call",
        ts: "2026-04-18T12:00:00Z",
        name: "fs_write_file",
        input: { path: "a.txt", content: "x" },
        toolUseId: "call_1",
      },
    ]);
  });

  it("parses tool_result JSON lines", () => {
    const parser = createStdoutParser();
    const line = JSON.stringify({
      kind: "tool_result",
      toolUseId: "call_1",
      toolName: "fs_write_file",
      content: "File written: a.txt",
      isError: false,
    });
    const entries = parser.parseLine(line, "2026-04-18T12:00:00Z");
    expect(entries[0].kind).toBe("tool_result");
    expect(entries[0]).toMatchObject({
      toolUseId: "call_1",
      toolName: "fs_write_file",
      content: "File written: a.txt",
      isError: false,
    });
  });

  it("treats non-JSON as assistant text", () => {
    const parser = createStdoutParser();
    const entries = parser.parseLine("Hello world", "2026-04-18T12:00:00Z");
    expect(entries[0].kind).toBe("assistant");
    expect(entries[0].text).toBe("Hello world");
  });
});
