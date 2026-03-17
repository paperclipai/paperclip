import { describe, expect, it } from "vitest";
import { parseAmpStreamJson, describeAmpFailure } from "@paperclipai/adapter-amp-local/server";

describe("amp_local stream-json parsing", () => {
  it("parses a successful stream-json output", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-6", session_id: "T-abc123" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello from Amp!" }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Hello from Amp!",
        session_id: "T-abc123",
        model: "claude-opus-4-6",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
        total_cost_usd: 0.005,
      }),
    ].join("\n");

    const parsed = parseAmpStreamJson(stdout);
    expect(parsed.threadId).toBe("T-abc123");
    expect(parsed.model).toBe("claude-opus-4-6");
    expect(parsed.summary).toBe("Hello from Amp!");
    expect(parsed.costUsd).toBe(0.005);
    expect(parsed.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
    });
    expect(parsed.resultJson).not.toBeNull();
  });

  it("handles output with no result event", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-6", session_id: "T-thread1" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "partial response" }] },
      }),
    ].join("\n");

    const parsed = parseAmpStreamJson(stdout);
    expect(parsed.threadId).toBe("T-thread1");
    expect(parsed.summary).toBe("partial response");
    expect(parsed.resultJson).toBeNull();
    expect(parsed.costUsd).toBeNull();
    expect(parsed.usage).toBeNull();
  });

  it("handles empty stdout", () => {
    const parsed = parseAmpStreamJson("");
    expect(parsed.threadId).toBeNull();
    expect(parsed.summary).toBe("");
    expect(parsed.resultJson).toBeNull();
  });

  it("handles non-JSON lines gracefully", () => {
    const stdout = "not json\n" + JSON.stringify({
      type: "result",
      result: "done",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      total_cost_usd: 0.001,
    });

    const parsed = parseAmpStreamJson(stdout);
    expect(parsed.summary).toBe("done");
    expect(parsed.resultJson).not.toBeNull();
  });

  it("concatenates multiple assistant text blocks", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Part 1" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Part 2" }] },
      }),
      JSON.stringify({
        type: "result",
        result: "Final",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
        total_cost_usd: 0,
      }),
    ].join("\n");

    const parsed = parseAmpStreamJson(stdout);
    expect(parsed.summary).toBe("Final");
  });

  it("extracts thread_id from init event", () => {
    const stdout = JSON.stringify({
      type: "system",
      subtype: "init",
      model: "gpt-5.4",
      thread_id: "T-thread-via-field",
    });

    const parsed = parseAmpStreamJson(stdout);
    expect(parsed.threadId).toBe("T-thread-via-field");
  });
});

describe("describeAmpFailure", () => {
  it("describes failure with subtype and result", () => {
    const msg = describeAmpFailure({
      subtype: "error_timeout",
      result: "Operation timed out",
    });
    expect(msg).toBe("Amp run failed: subtype=error_timeout: Operation timed out");
  });

  it("describes failure with error messages", () => {
    const msg = describeAmpFailure({
      subtype: "",
      result: "",
      errors: [{ message: "Something went wrong" }],
    });
    expect(msg).toBe("Amp run failed: Something went wrong");
  });

  it("returns null when no error details", () => {
    const msg = describeAmpFailure({
      subtype: "",
      result: "",
    });
    expect(msg).toBeNull();
  });
});
