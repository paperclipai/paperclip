import { describe, expect, it } from "vitest";
import { normalizeCursorStreamLine } from "./stream.js";

describe("normalizeCursorStreamLine", () => {
  it("returns empty line and null stream for empty string", () => {
    expect(normalizeCursorStreamLine("")).toEqual({ stream: null, line: "" });
  });

  it("returns empty line and null stream for whitespace-only string", () => {
    expect(normalizeCursorStreamLine("   ")).toEqual({ stream: null, line: "" });
  });

  it("returns trimmed line with null stream for plain JSON", () => {
    const result = normalizeCursorStreamLine('{"type":"result"}');
    expect(result.stream).toBeNull();
    expect(result.line).toBe('{"type":"result"}');
  });

  it("strips stdout: prefix and returns stdout stream", () => {
    const result = normalizeCursorStreamLine('stdout: {"type":"text"}');
    expect(result.stream).toBe("stdout");
    expect(result.line).toBe('{"type":"text"}');
  });

  it("strips stderr: prefix and returns stderr stream", () => {
    const result = normalizeCursorStreamLine('stderr: {"type":"error"}');
    expect(result.stream).toBe("stderr");
    expect(result.line).toBe('{"type":"error"}');
  });

  it("strips stdout= prefix (equals sign variant)", () => {
    const result = normalizeCursorStreamLine('stdout= {"type":"result"}');
    expect(result.stream).toBe("stdout");
  });

  it("handles case-insensitive STDOUT prefix", () => {
    const result = normalizeCursorStreamLine('STDOUT: {"type":"ok"}');
    expect(result.stream).toBe("stdout");
  });

  it("handles case-insensitive STDERR prefix", () => {
    const result = normalizeCursorStreamLine('STDERR: {"type":"err"}');
    expect(result.stream).toBe("stderr");
  });

  it("trims surrounding whitespace before matching", () => {
    const result = normalizeCursorStreamLine('  stdout: {"x":1}  ');
    expect(result.stream).toBe("stdout");
    expect(result.line).toBe('{"x":1}');
  });

  it("only matches prefix when followed by JSON-like content ([ or {)", () => {
    // A line starting with "stdout" but not followed by JSON — falls through to plain line
    const result = normalizeCursorStreamLine("stdout: plain text");
    expect(result.stream).toBeNull();
    expect(result.line).toBe("stdout: plain text");
  });

  it("matches stdout prefix followed by array JSON", () => {
    const result = normalizeCursorStreamLine("stdout: [1,2,3]");
    expect(result.stream).toBe("stdout");
    expect(result.line).toBe("[1,2,3]");
  });
});
