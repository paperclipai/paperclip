import { describe, expect, it } from "vitest";
import {
  detectAgyAuthRequired,
  detectAgyQuotaExhausted,
  isAgySessionUnrecoverableError,
  isAgySuccessResult,
  isAgyTransientNetworkError,
  isAgyUnknownSessionError,
  parseAgyJsonl,
  parseAgyUsage,
  resolveAgyRunOutcome,
} from "./parse.js";
import {
  DENIED_ACTION_RUN,
  SIMPLE_RUN,
  TOOL_ERROR_RECOVERED_RUN,
  TOOL_RUN,
  TRUNCATED_RUN,
} from "./fixtures.test-util.js";

describe("parseAgyUsage", () => {
  it("extracts usage token counts", () => {
    const result = parseAgyUsage({
      input_tokens: 1500,
      output_tokens: 250,
      cache_read_tokens: 500,
      thinking_tokens: 80,
      total_tokens: 2250,
    });
    expect(result?.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 250,
      cachedInputTokens: 500,
    });
    expect(result?.thinkingTokens).toBe(80);
  });

  it("returns null for non-object", () => {
    expect(parseAgyUsage(null)).toBeNull();
    expect(parseAgyUsage("invalid")).toBeNull();
  });
});

describe("parseAgyJsonl", () => {
  it("parses a simple run: conversation id, status, response, usage", () => {
    const parsed = parseAgyJsonl(SIMPLE_RUN);
    expect(parsed.conversationId).toBe("1d4068bc-62e4-47ec-ad8b-6e83372b5f32");
    expect(parsed.sessionId).toBe("1d4068bc-62e4-47ec-ad8b-6e83372b5f32");
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.response).toBe("HELLO_AGY\n");
    expect(parsed.summary).toBe("HELLO_AGY");
    expect(parsed.numTurns).toBe(1);
    expect(parsed.usage).toEqual({
      inputTokens: 5286,
      outputTokens: 90,
      cachedInputTokens: 8128,
    });
    expect(parsed.thinkingTokens).toBe(86);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.malformedLines).toBe(0);
    expect(isAgySuccessResult(parsed)).toBe(true);
  });

  it("concatenates assistant text deltas in order", () => {
    const parsed = parseAgyJsonl(TOOL_RUN);
    expect(parsed.assistantText).toBe("I have created probe.txt and read it back.");
  });

  it("pairs ACTIVE and DONE tool events into one invocation per step", () => {
    const parsed = parseAgyJsonl(TOOL_RUN);
    expect(parsed.tools.length).toBe(2);

    const [write, view] = parsed.tools;
    expect(write.name).toBe("write_to_file");
    expect(write.stepIndex).toBe(2);
    expect(write.completed).toBe(true);
    expect(write.parameters).toEqual({ TargetFile: "/tmp/agyprobe/probe.txt" });
    expect(write.durationSeconds).toBe(0.01667);

    expect(view.name).toBe("view_file");
    expect(view.output).toBe("2 lines, 7 bytes");
    expect(view.completed).toBe(true);
    expect(view.isError).toBe(false);
  });

  it("uses the result event's run total for usage, not the last step", () => {
    const parsed = parseAgyJsonl(TOOL_RUN);
    expect(parsed.usage?.inputTokens).toBe(18259);
    expect(parsed.usage?.outputTokens).toBe(1111);
    expect(parsed.usage?.cachedInputTokens).toBe(24379);
  });

  it("records the init event's advertised tools and permission mode", () => {
    const parsed = parseAgyJsonl(SIMPLE_RUN);
    expect(parsed.availableTools).toEqual(["view_file", "write_to_file", "run_command"]);
    expect(parsed.permissionMode).toBe("always-proceed");
  });

  it("a truncated stream yields no result event but keeps partial usage", () => {
    const parsed = parseAgyJsonl(TRUNCATED_RUN);
    expect(parsed.resultEvent).toBeNull();
    expect(parsed.status).toBeNull();
    expect(parsed.conversationId).toBe("abc-123");
    expect(parsed.usage?.inputTokens).toBe(10);
    expect(isAgySuccessResult(parsed)).toBe(false);
  });

  it("a non-SUCCESS status produces an error message", () => {
    const parsed = parseAgyJsonl(
      '{"event":"result","result":{"conversation_id":"x","status":"ERROR","error":"model refused"}}',
    );
    expect(parsed.status).toBe("ERROR");
    expect(parsed.errorMessage).toBe("model refused");
  });

  it("a non-SUCCESS status with no error field still explains itself", () => {
    const parsed = parseAgyJsonl('{"event":"result","result":{"status":"CANCELLED"}}');
    expect(parsed.errorMessage).toBe("agy finished with status CANCELLED");
  });

  it("counts malformed JSON lines instead of throwing", () => {
    const parsed = parseAgyJsonl(['{"event":"init","conversation_id":"a"}', "{not json", ""].join("\n"));
    expect(parsed.conversationId).toBe("a");
    expect(parsed.malformedLines).toBe(1);
  });

  it("ignores non-JSON banner lines without counting them as malformed", () => {
    const parsed = parseAgyJsonl(["Fetching...", SIMPLE_RUN].join("\n"));
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.status).toBe("SUCCESS");
  });

  it("falls back to raw stdout when no JSONL events are present", () => {
    const parsed = parseAgyJsonl("Hello! Systems are operational.");
    expect(parsed.summary).toBe("Hello! Systems are operational.");
    expect(parsed.sessionId).toBeNull();
    expect(parsed.isError).toBe(false);
  });

  it("keeps a recoverable tool error out of the terminal error when agy reports SUCCESS", () => {
    const parsed = parseAgyJsonl(TOOL_ERROR_RECOVERED_RUN);
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.isError).toBe(false);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrorMessage).toMatch(/no such file or directory/);
    expect(parsed.tools[0].isError).toBe(true);
    expect(parsed.summary).toBe("RECOVERED");
  });

  it("parses denied_actions from the result event", () => {
    const parsed = parseAgyJsonl(DENIED_ACTION_RUN);
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.response).toBe("");
    expect(parsed.deniedActions).toEqual([{ action: "write_file", displayName: "WriteToFile" }]);
  });

  it("returns no denied actions when the result has none", () => {
    expect(parseAgyJsonl(SIMPLE_RUN).deniedActions).toEqual([]);
  });

  it("does not use the raw JSON stream as the summary when agy returns an empty response", () => {
    expect(parseAgyJsonl(DENIED_ACTION_RUN).summary).toBe("");
  });
});

describe("resolveAgyRunOutcome", () => {
  it("passes a SUCCESS run even when a tool step errored along the way", () => {
    const outcome = resolveAgyRunOutcome(parseAgyJsonl(TOOL_ERROR_RECOVERED_RUN), 0);
    expect(outcome).toEqual({ failed: false, errorMessage: null, permissionDenied: false });
  });

  it("fails a non-SUCCESS terminal status with its error", () => {
    const outcome = resolveAgyRunOutcome(
      parseAgyJsonl('{"event":"result","result":{"status":"ERROR","error":"model refused"}}'),
      0,
    );
    expect(outcome).toEqual({ failed: true, errorMessage: "model refused", permissionDenied: false });
  });

  it("fails a SUCCESS run whose only work was auto-denied", () => {
    const outcome = resolveAgyRunOutcome(parseAgyJsonl(DENIED_ACTION_RUN), 0);
    expect(outcome.failed).toBe(true);
    expect(outcome.permissionDenied).toBe(true);
    expect(outcome.errorMessage).toMatch(/WriteToFile/);
    expect(outcome.errorMessage).toMatch(/dangerouslySkipPermissions/);
  });

  it("passes a SUCCESS run that still answered after a denied action", () => {
    const stdout = DENIED_ACTION_RUN.replace('"response":""', '"response":"Could not write note.txt; here is the text instead."');
    const outcome = resolveAgyRunOutcome(parseAgyJsonl(stdout), 0);
    expect(outcome).toEqual({ failed: false, errorMessage: null, permissionDenied: false });
  });

  it("fails a SUCCESS result when the process still exited non-zero", () => {
    const outcome = resolveAgyRunOutcome(parseAgyJsonl(SIMPLE_RUN), 1);
    expect(outcome.failed).toBe(true);
  });

  it("falls back to the tool error when the stream ends without a result event", () => {
    const stdout = TOOL_ERROR_RECOVERED_RUN.split("\n").slice(0, 5).join("\n");
    const outcome = resolveAgyRunOutcome(parseAgyJsonl(stdout), 1);
    expect(outcome.failed).toBe(true);
    expect(outcome.errorMessage).toMatch(/no such file or directory/);
  });

  it("passes a stream without a result event when the process exited cleanly", () => {
    expect(resolveAgyRunOutcome(parseAgyJsonl(TRUNCATED_RUN), 0).failed).toBe(false);
  });
});

describe("failure and session error classification", () => {
  it("classifies auth, quota, network and dead-session failures", () => {
    expect(detectAgyAuthRequired({ stderr: "Error: not logged in" }).requiresAuth).toBe(true);
    expect(detectAgyAuthRequired({ stderr: "authentication required" }).requiresAuth).toBe(true);
    expect(detectAgyAuthRequired({ stderr: "some other failure" }).requiresAuth).toBe(false);

    expect(detectAgyQuotaExhausted({ stderr: "RESOURCE_EXHAUSTED" })).toBe(true);
    expect(detectAgyQuotaExhausted({ stderr: "429 too many requests" })).toBe(true);
    expect(detectAgyQuotaExhausted({ stderr: "file not found" })).toBe(false);

    expect(isAgyTransientNetworkError("", "read ECONNRESET")).toBe(true);
    expect(isAgyTransientNetworkError("", "503 Service Unavailable")).toBe(true);
    expect(isAgyTransientNetworkError("", "syntax error")).toBe(false);

    expect(isAgySessionUnrecoverableError("", "conversation abc-123 not found")).toBe(true);
    expect(isAgySessionUnrecoverableError("", "invalid conversation")).toBe(true);
    expect(isAgySessionUnrecoverableError("", "tool call failed")).toBe(false);
  });

  it("detects conversation not found via isAgyUnknownSessionError", () => {
    expect(
      isAgyUnknownSessionError({
        stdout: 'conversation "conv-123" not found',
      }),
    ).toBe(true);

    expect(
      isAgyUnknownSessionError({
        stderr: "No conversation found with id conv-456",
      }),
    ).toBe(true);

    expect(
      isAgyUnknownSessionError({
        errorMessage: "Unknown conversation",
      }),
    ).toBe(true);

    expect(
      isAgyUnknownSessionError({
        stdout: "All tasks completed successfully",
      }),
    ).toBe(false);
  });

  it("ignores error-looking words inside the agent's own transcript", () => {
    const transcript = [
      '{"event":"init","conversation_id":"conv-1"}',
      '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"There is no unauthenticated dashboard. No 401/403, 429 or 503 responses in the logs; session abc not found in cache."}}',
      '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":2,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","output":"HTTP 401 Unauthorized\\nrate limit exceeded\\nconnection refused"}}}',
      '{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"Audit done: unauthenticated access is blocked."}}',
    ].join("\n");
    const parsed = parseAgyJsonl(transcript);
    expect(detectAgyAuthRequired({ stdout: transcript, parsed }).requiresAuth).toBe(false);
    expect(detectAgyQuotaExhausted({ stdout: transcript, parsed })).toBe(false);
    expect(isAgyTransientNetworkError(transcript, "")).toBe(false);
    expect(isAgySessionUnrecoverableError(transcript, "")).toBe(false);
    expect(isAgyUnknownSessionError({ stdout: transcript, errorMessage: parsed.errorMessage })).toBe(false);
  });

  it("still detects CLI errors printed as plain stdout lines around the JSON stream", () => {
    const stdout = ["Error: not logged in. Run agy login.", SIMPLE_RUN].join("\n");
    expect(detectAgyAuthRequired({ stdout }).requiresAuth).toBe(true);
  });

  it("still detects failures carried in the terminal result error", () => {
    const parsed = parseAgyJsonl(
      '{"event":"result","result":{"status":"ERROR","error":"RESOURCE_EXHAUSTED: quota exceeded"}}',
    );
    expect(detectAgyQuotaExhausted({ parsed })).toBe(true);
  });
});
