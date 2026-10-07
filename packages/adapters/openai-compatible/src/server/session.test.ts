import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./client.js";
import { dropOrphanToolMessages, readSession, sessionCodec, trimSessionMessages } from "./session.js";

const call = (id: string) => ({ id, type: "function" as const, function: { name: "paperclip_api_request", arguments: "{}" } });

describe("openai_compatible session", () => {
  it("round-trips through the codec and exposes the display id", () => {
    const params = {
      sessionId: "s-1",
      apiUrl: "https://api.example.com/v1",
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [call("c1")] },
        { role: "tool", tool_call_id: "c1", content: "HTTP 200" },
        { role: "assistant", content: "done", reasoning_content: "dropped" },
      ],
    };
    const serialized = sessionCodec.serialize(params);
    expect(sessionCodec.deserialize(serialized)).toEqual(serialized);
    expect(sessionCodec.getDisplayId?.(serialized)).toBe("s-1");
    expect((serialized?.messages as ChatMessage[])[3]).toEqual({ role: "assistant", content: "done" });
  });

  it("rejects params without a session id or api url", () => {
    expect(readSession({ sessionId: "x" })).toBeNull();
    expect(readSession(null)).toBeNull();
  });

  it("drops tool exchanges that are missing results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "thinking aloud", tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "ok" },
      { role: "tool", tool_call_id: "zzz", content: "orphan" },
    ];
    expect(dropOrphanToolMessages(messages)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "thinking aloud" },
    ]);
  });

  it("trims oldest history and restarts at a user message", () => {
    const big = "x".repeat(500);
    const messages: ChatMessage[] = [
      { role: "user", content: big },
      { role: "assistant", content: "", tool_calls: [call("c1")] },
      { role: "tool", tool_call_id: "c1", content: big },
      { role: "assistant", content: "first done" },
      { role: "user", content: "second wake" },
      { role: "assistant", content: "second done" },
    ];
    expect(trimSessionMessages(messages, 300)).toEqual([
      { role: "user", content: "second wake" },
      { role: "assistant", content: "second done" },
    ]);
    expect(trimSessionMessages(messages, 1_000_000)).toHaveLength(6);
  });
});
