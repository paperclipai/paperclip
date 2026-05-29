import { describe, expect, it } from "vitest";
import { hasCursorTerminalStreamResult, parseCursorJsonl } from "./parse.js";

describe("hasCursorTerminalStreamResult", () => {
  it("returns true when stream-json includes a result event", () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      '{"type":"assistant","message":{"content":[{"type":"output_text","text":"hi"}]}}',
      '{"type":"result","subtype":"success","session_id":"s1","result":"ok"}',
    ].join("\n");

    expect(hasCursorTerminalStreamResult(stdout)).toBe(true);
    expect(parseCursorJsonl(stdout).summary).toBe("hi");
  });

  it("returns false for partial output without a result event", () => {
    const stdout = '{"type":"assistant","message":{"content":[{"type":"output_text","text":"still running"}]}}';
    expect(hasCursorTerminalStreamResult(stdout)).toBe(false);
  });
});
