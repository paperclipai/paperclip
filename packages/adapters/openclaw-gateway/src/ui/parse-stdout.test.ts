import { describe, it, expect } from "vitest";
import { parseOpenClawGatewayStdoutLine } from "./parse-stdout.js";

const TS = "2026-04-17T00:00:00.000Z";

describe("parseOpenClawGatewayStdoutLine", () => {
  it("returns empty array for an empty line", () => {
    expect(parseOpenClawGatewayStdoutLine("", TS)).toEqual([]);
  });

  it("returns empty array for a whitespace-only line", () => {
    expect(parseOpenClawGatewayStdoutLine("   ", TS)).toEqual([]);
  });

  it("returns stdout transcript entry for a plain line with no prefix", () => {
    expect(parseOpenClawGatewayStdoutLine("hello", TS)).toEqual([
      { kind: "stdout", ts: TS, text: "hello" },
    ]);
  });

  it("returns stderr transcript entry when the line has a stderr prefix", () => {
    expect(parseOpenClawGatewayStdoutLine("stderr: something went wrong", TS)).toEqual([
      { kind: "stderr", ts: TS, text: "something went wrong" },
    ]);
  });

  it("emits a system entry for an [openclaw-gateway] lifecycle line", () => {
    const result = parseOpenClawGatewayStdoutLine("[openclaw-gateway] session started", TS);
    expect(result).toEqual([
      { kind: "system", ts: TS, text: "session started" },
    ]);
  });

  it("emits assistant transcript entry for an [openclaw-gateway:event] assistant delta", () => {
    const eventLine = `[openclaw-gateway:event] run=run-1 stream=assistant data=${JSON.stringify({ delta: "Hello " })}`;
    const result = parseOpenClawGatewayStdoutLine(eventLine, TS);
    expect(result).toEqual([
      { kind: "assistant", ts: TS, text: "Hello ", delta: true },
    ]);
  });

  it("emits assistant transcript entry for an [openclaw-gateway:event] assistant full text", () => {
    const eventLine = `[openclaw-gateway:event] run=run-1 stream=assistant data=${JSON.stringify({ text: "Final text" })}`;
    const result = parseOpenClawGatewayStdoutLine(eventLine, TS);
    expect(result).toEqual([
      { kind: "assistant", ts: TS, text: "Final text" },
    ]);
  });

  it("emits stderr entry for an [openclaw-gateway:event] error stream", () => {
    const eventLine = `[openclaw-gateway:event] run=run-1 stream=error data=${JSON.stringify({ error: "something failed" })}`;
    const result = parseOpenClawGatewayStdoutLine(eventLine, TS);
    expect(result).toEqual([
      { kind: "stderr", ts: TS, text: "something failed" },
    ]);
  });

  it("returns empty array for [openclaw-gateway:event] error stream with no message", () => {
    const eventLine = `[openclaw-gateway:event] run=run-1 stream=error data={}`;
    const result = parseOpenClawGatewayStdoutLine(eventLine, TS);
    expect(result).toEqual([]);
  });

  it("emits stderr entry for [openclaw-gateway:event] lifecycle failed with message", () => {
    const eventLine = `[openclaw-gateway:event] run=run-1 stream=lifecycle data=${JSON.stringify({ phase: "failed", message: "timed out" })}`;
    const result = parseOpenClawGatewayStdoutLine(eventLine, TS);
    expect(result).toEqual([
      { kind: "stderr", ts: TS, text: "timed out" },
    ]);
  });

  it("returns empty array for [openclaw-gateway:event] lifecycle non-error phase", () => {
    const eventLine = `[openclaw-gateway:event] run=run-1 stream=lifecycle data=${JSON.stringify({ phase: "started" })}`;
    const result = parseOpenClawGatewayStdoutLine(eventLine, TS);
    expect(result).toEqual([]);
  });

  it("returns stdout entry for an unrecognized [openclaw-gateway:event] stream", () => {
    const eventLine = `[openclaw-gateway:event] run=run-1 stream=unknown data={}`;
    const result = parseOpenClawGatewayStdoutLine(eventLine, TS);
    expect(result).toEqual([]);
  });

  it("returns stdout entry for a line that does not match the event format", () => {
    const result = parseOpenClawGatewayStdoutLine("[openclaw-gateway:event] malformed", TS);
    expect(result).toEqual([
      { kind: "stdout", ts: TS, text: "[openclaw-gateway:event] malformed" },
    ]);
  });

  it("propagates the ts parameter into all transcript entries", () => {
    const customTs = "2026-01-01T12:00:00.000Z";
    const result = parseOpenClawGatewayStdoutLine("plain output", customTs);
    expect(result[0]?.ts).toBe(customTs);
  });
});
