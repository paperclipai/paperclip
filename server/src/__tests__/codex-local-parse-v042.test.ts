import { describe, expect, it } from "vitest";
import { parseCodexJsonl } from "@paperclipai/adapter-codex-local/server";

describe("parseCodexJsonl — Codex CLI 0.42.0 compatibility (#1343)", () => {
  it("parses old thread.started event", () => {
    const stdout = JSON.stringify({ type: "thread.started", thread_id: "thread-abc" });
    const result = parseCodexJsonl(stdout);
    expect(result.sessionId).toBe("thread-abc");
  });

  it("parses new session.created event", () => {
    const stdout = JSON.stringify({ type: "session.created", session_id: "session-xyz" });
    const result = parseCodexJsonl(stdout);
    expect(result.sessionId).toBe("session-xyz");
  });

  it("parses session.created with thread_id fallback", () => {
    const stdout = JSON.stringify({ type: "session.created", thread_id: "thread-fallback" });
    const result = parseCodexJsonl(stdout);
    expect(result.sessionId).toBe("thread-fallback");
  });

  it("parses old agent_message with item.type", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello old" } }),
    ].join("\n");
    const result = parseCodexJsonl(lines);
    expect(result.summary).toBe("hello old");
  });

  it("parses new assistant_message with item.item_type", () => {
    const lines = [
      JSON.stringify({ type: "session.created", session_id: "s1" }),
      JSON.stringify({ type: "item.completed", item: { item_type: "assistant_message", text: "hello new" } }),
    ].join("\n");
    const result = parseCodexJsonl(lines);
    expect(result.summary).toBe("hello new");
  });

  it("parses assistant_message with old item.type field", () => {
    const lines = [
      JSON.stringify({ type: "item.completed", item: { type: "assistant_message", text: "compat" } }),
    ].join("\n");
    const result = parseCodexJsonl(lines);
    expect(result.summary).toBe("compat");
  });

  it("prefers item_type over type when both are present", () => {
    const lines = [
      JSON.stringify({
        type: "item.completed",
        item: { item_type: "assistant_message", type: "something_else", text: "preferred" },
      }),
    ].join("\n");
    const result = parseCodexJsonl(lines);
    expect(result.summary).toBe("preferred");
  });

  it("still parses turn.completed usage", () => {
    const lines = [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 20 } }),
    ].join("\n");
    const result = parseCodexJsonl(lines);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cachedInputTokens).toBe(20);
  });
});
