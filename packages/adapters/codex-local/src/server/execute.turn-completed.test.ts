import { describe, expect, it } from "vitest";
import { stdoutChunkHasTurnCompleted } from "./execute.js";

describe("stdoutChunkHasTurnCompleted", () => {
  it("returns true for a complete turn.completed JSON line", () => {
    expect(
      stdoutChunkHasTurnCompleted('{"type":"turn.completed","usage":{"input_tokens":10}}\n'),
    ).toBe(true);
  });

  it("returns true when turn.completed is one of several JSONL lines", () => {
    const chunk =
      '{"type":"item.completed","item":{"id":"1"}}\n' +
      '{"type":"turn.completed","usage":{"input_tokens":5}}\n';
    expect(stdoutChunkHasTurnCompleted(chunk)).toBe(true);
  });

  it("returns false for a partial JSON chunk that is not yet parseable", () => {
    expect(stdoutChunkHasTurnCompleted('{"type":"turn.compl')).toBe(false);
  });

  it("returns false when 'turn.completed' only appears as a substring, not the type", () => {
    expect(
      stdoutChunkHasTurnCompleted('{"type":"agent_message","text":"the turn.completed event"}'),
    ).toBe(false);
  });

  it("returns false for a JSON line with a different type", () => {
    expect(stdoutChunkHasTurnCompleted('{"type":"turn.started"}\n')).toBe(false);
  });

  it("returns false for empty, non-JSON, or non-string input", () => {
    expect(stdoutChunkHasTurnCompleted("")).toBe(false);
    expect(stdoutChunkHasTurnCompleted("plain log line without json\n")).toBe(false);
    // @ts-expect-error exercising the runtime guard for non-string input
    expect(stdoutChunkHasTurnCompleted(undefined)).toBe(false);
  });
});
