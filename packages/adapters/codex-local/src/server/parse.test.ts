import { describe, expect, it } from "vitest";
import { parseCodexJsonl, isCodexUnknownSessionError } from "./parse.js";

describe("parseCodexJsonl", () => {
  it("parses usage, cost, assistant text, and session id from JSONL output", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "Finished the task",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        total_cost_usd: 0.123456,
        usage: {
          input_tokens: 1200,
          cached_input_tokens: 200,
          output_tokens: 80,
        },
      }),
    ].join("\n");

    const parsed = parseCodexJsonl(stdout);
    expect(parsed.sessionId).toBe("thread_123");
    expect(parsed.summary).toBe("Finished the task");
    expect(parsed.usage).toEqual({
      inputTokens: 1200,
      cachedInputTokens: 200,
      outputTokens: 80,
    });
    expect(parsed.costUsd).toBeCloseTo(0.123456, 6);
    expect(parsed.errorMessage).toBeNull();
  });

  it("detects missing-session failures", () => {
    expect(isCodexUnknownSessionError("unknown session id", "")).toBe(true);
    expect(isCodexUnknownSessionError("", "thread abc not found")).toBe(true);
    expect(isCodexUnknownSessionError("all good", "")).toBe(false);
  });
});
