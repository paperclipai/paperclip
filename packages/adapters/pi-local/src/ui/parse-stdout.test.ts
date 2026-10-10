import { describe, expect, it } from "vitest";
import { parsePiStdoutLine } from "./parse-stdout.js";

const ts = "2026-08-20T10:00:00.000Z";

describe("parsePiStdoutLine message_end", () => {
  it("renders user messages as user transcript entries", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "## Paperclip Wake Payload" }],
      },
    });

    expect(parsePiStdoutLine(line, ts)).toEqual([
      { kind: "user", ts, text: "## Paperclip Wake Payload" },
    ]);
  });

  it("does not duplicate tool-result messages", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "file contents" }],
      },
    });

    expect(parsePiStdoutLine(line, ts)).toEqual([]);
  });

  it("keeps assistant text and thinking entries", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking" },
          { type: "text", text: "done" },
        ],
      },
    });

    expect(parsePiStdoutLine(line, ts)).toEqual([
      { kind: "thinking", ts, text: "checking" },
      { kind: "assistant", ts, text: "done" },
    ]);
  });

  it("ignores unsupported message roles", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: { role: "system", content: "internal message" },
    });

    expect(parsePiStdoutLine(line, ts)).toEqual([]);
  });
});
