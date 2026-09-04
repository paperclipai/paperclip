import { describe, expect, it } from "vitest";
import { isAgyUnknownSessionError, parseAgyJsonl, parseAgyUsage } from "./parse.js";

describe("parseAgyUsage", () => {
  it("extracts usage token counts", () => {
    const usage = parseAgyUsage({
      input_tokens: 1500,
      output_tokens: 250,
      cache_read_tokens: 500,
      total_tokens: 2250,
    });
    expect(usage).toEqual({
      inputTokens: 1500,
      outputTokens: 250,
      cachedInputTokens: 500,
    });
  });

  it("returns null for non-object", () => {
    expect(parseAgyUsage(null)).toBeNull();
    expect(parseAgyUsage("invalid")).toBeNull();
  });
});

describe("parseAgyJsonl", () => {
  it("parses successful stream-json output", () => {
    const stdout = [
      JSON.stringify({
        event: "init",
        conversation_id: "conv-1234",
        init: { cwd: "/path/to/project", tools: ["view_file"] },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-1234",
          step_index: 0,
          state: "DONE",
          step_type: "user_input",
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-1234",
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "Hello there!",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 50,
          },
        },
      }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-1234",
          status: "SUCCESS",
          response: "Hello there!",
          duration_seconds: 1.25,
          num_turns: 1,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 50,
            total_tokens: 170,
          },
        },
      }),
    ].join("\n");

    const parsed = parseAgyJsonl(stdout);
    expect(parsed.sessionId).toBe("conv-1234");
    expect(parsed.summary).toBe("Hello there!");
    expect(parsed.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 50,
    });
    expect(parsed.isError).toBe(false);
  });

  it("handles error in tool execution or result", () => {
    const stdout = [
      JSON.stringify({
        event: "init",
        conversation_id: "conv-5678",
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-5678",
          step_index: 1,
          state: "ERROR",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: {
            error: { message: "Command failed with exit code 1" },
          },
        },
      }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-5678",
          status: "ERROR",
          response: "Failed to execute tool",
        },
      }),
    ].join("\n");

    const parsed = parseAgyJsonl(stdout);
    expect(parsed.sessionId).toBe("conv-5678");
    expect(parsed.isError).toBe(true);
    expect(parsed.errorMessage).toBe("Command failed with exit code 1");
  });

  it("falls back to raw stdout when no JSONL events are present", () => {
    const parsed = parseAgyJsonl("Hello! Systems are operational.");
    expect(parsed.summary).toBe("Hello! Systems are operational.");
    expect(parsed.sessionId).toBeNull();
    expect(parsed.isError).toBe(false);
  });
});

describe("isAgyUnknownSessionError", () => {
  it("detects conversation not found", () => {
    expect(
      isAgyUnknownSessionError({
        stdout: 'warning: conversation "1234-5678" not found',
      }),
    ).toBe(true);

    expect(
      isAgyUnknownSessionError({
        stderr: 'Error: conversation "abc" not found in session store',
      }),
    ).toBe(true);

    expect(
      isAgyUnknownSessionError({
        stdout: "All good",
      }),
    ).toBe(false);
  });
});
