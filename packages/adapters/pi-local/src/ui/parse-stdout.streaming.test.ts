import { beforeEach, describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parsePiStdoutLine, resetParserState } from "./parse-stdout.js";

const TS = "2026-01-01T00:00:00.000Z";

function parse(events: unknown[]): TranscriptEntry[] {
  return events.flatMap((event) => parsePiStdoutLine(JSON.stringify(event), TS));
}

function texts(entries: TranscriptEntry[], kind: "assistant" | "thinking"): string[] {
  return entries.flatMap((entry) => (entry.kind === kind ? [entry.text] : []));
}

const message = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "Check the log." },
    { type: "text", text: "Now I post the reply." },
  ],
  usage: { input: 10, output: 5 },
};

describe("parsePiStdoutLine assistant messages", () => {
  beforeEach(() => resetParserState());

  // Event order from pi-agent-core agent-loop.js: message_start, message_update*,
  // message_end, then turn_end and agent_end repeat the finished message.
  it("shows a streamed message once", () => {
    const entries = parse([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Check the log." } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "Check the log." } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Now I post " } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "the reply." } },
      { type: "message_update", assistantMessageEvent: { type: "text_end", content: "Now I post the reply." } },
      { type: "message_end", message },
      { type: "turn_end", message, toolResults: [] },
      { type: "agent_end", messages: [message] },
    ]);

    expect(texts(entries, "thinking")).toEqual(["Check the log."]);
    expect(texts(entries, "assistant")).toEqual(["Now I post ", "the reply."]);
    expect(entries.at(-1)?.kind).toBe("result");
  });

  it("shows a message that did not stream from message_end", () => {
    const entries = parse([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_end", message },
      { type: "turn_end", message, toolResults: [] },
    ]);

    expect(texts(entries, "thinking")).toEqual(["Check the log."]);
    expect(texts(entries, "assistant")).toEqual(["Now I post the reply."]);
  });
});
