// Unit tests for Antigravity stream-json parser

import { describe, expect, it } from "vitest";
import {
  parseAntigravityJsonl,
  isAntigravitySessionUnrecoverableError,
  detectAntigravityAuthRequired,
  describeAntigravityFailure,
} from "./parse.js";

describe("antigravity_local parser", () => {
  it("extracts sessionId, response, token usage, and status from valid stream-json events", () => {
    const stdout = [
      JSON.stringify({
        event: "init",
        conversation_id: "conv-12345",
        init: { cwd: "/workspace", tools: ["view_file", "write_to_file"] },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-12345",
          step_index: 0,
          state: "DONE",
          step_type: "user_input",
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-12345",
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "Hello from Antigravity!",
          duration_seconds: 1.2,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            thinking_tokens: 10,
            cache_read_tokens: 50,
            total_tokens: 120,
          },
        },
      }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-12345",
          status: "SUCCESS",
          response: "Hello from Antigravity!",
          duration_seconds: 2.5,
          num_turns: 1,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            thinking_tokens: 10,
            cache_read_tokens: 50,
            total_tokens: 120,
          },
        },
      }),
    ].join("\n");

    const parsed = parseAntigravityJsonl(stdout);
    expect(parsed.sessionId).toBe("conv-12345");
    expect(parsed.summary).toBe("Hello from Antigravity!");
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.usage.inputTokens).toBe(100);
    expect(parsed.usage.outputTokens).toBe(20);
    expect(parsed.usage.cachedInputTokens).toBe(50);
  });

  it("handles non-JSON warning banners without throwing", () => {
    const stdout = [
      "warning: conversation \"old-id\" not found",
      JSON.stringify({
        event: "init",
        conversation_id: "fresh-id-999",
        init: { cwd: "/workspace" },
      }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "fresh-id-999",
          status: "SUCCESS",
          response: "recovered",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ].join("\n");

    const parsed = parseAntigravityJsonl(stdout);
    expect(parsed.sessionId).toBe("fresh-id-999");
    expect(parsed.summary).toBe("recovered");
    expect(parsed.status).toBe("SUCCESS");
  });

  it("extracts error message from ERROR result events", () => {
    const stdout = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-err",
        status: "ERROR",
        response: "",
        error: "model invalid-model is not recognized",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    const parsed = parseAntigravityJsonl(stdout);
    expect(parsed.sessionId).toBe("conv-err");
    expect(parsed.status).toBe("ERROR");
    expect(parsed.errorMessage).toBe("model invalid-model is not recognized");
  });

  it("generates fallback error message when status is FAILURE without error field", () => {
    const stdout = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-fail",
        status: "FAILURE",
        response: "",
      },
    });

    const parsed = parseAntigravityJsonl(stdout);
    expect(parsed.sessionId).toBe("conv-fail");
    expect(parsed.status).toBe("FAILURE");
    expect(parsed.errorMessage).toBe("Antigravity run reported status: FAILURE");
  });

  it("concatenates streaming deltas if final result response is empty", () => {
    const stdout = [
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "agent_response",
          text_delta: "part 1, ",
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "agent_response",
          text_delta: "part 2",
        },
      }),
    ].join("\n");

    const parsed = parseAntigravityJsonl(stdout);
    expect(parsed.summary).toBe("part 1, part 2");
  });

  it("returns safe defaults for completely empty output", () => {
    const parsed = parseAntigravityJsonl("");
    expect(parsed.sessionId).toBeNull();
    expect(parsed.summary).toBe("");
    expect(parsed.status).toBeNull();
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.usage.inputTokens).toBe(0);
    expect(parsed.usage.outputTokens).toBe(0);
  });
});

describe("isAntigravitySessionUnrecoverableError", () => {
  it("detects missing conversation warning", () => {
    expect(isAntigravitySessionUnrecoverableError("warning: conversation \"123\" not found", "")).toBe(true);
    expect(isAntigravitySessionUnrecoverableError("", "conversation not found")).toBe(true);
    expect(isAntigravitySessionUnrecoverableError("unknown conversation", "")).toBe(true);
  });

  it("returns false for normal errors", () => {
    expect(isAntigravitySessionUnrecoverableError("file not found", "")).toBe(false);
    expect(isAntigravitySessionUnrecoverableError("", "syntax error")).toBe(false);
  });
});

describe("detectAntigravityAuthRequired", () => {
  it("detects authentication requirements", () => {
    expect(detectAntigravityAuthRequired({ parsed: null, stdout: "please authenticate to proceed", stderr: "" }).requiresAuth).toBe(true);
    expect(detectAntigravityAuthRequired({ parsed: null, stdout: "", stderr: "login required" }).requiresAuth).toBe(true);
  });
});

describe("describeAntigravityFailure", () => {
  it("formats structured failure message", () => {
    const desc = describeAntigravityFailure({
      result: {
        status: "ERROR",
        error: "Quota exceeded",
      },
    });
    expect(desc).toBe("Antigravity run failed: status=ERROR: Quota exceeded");
  });

  it("formats status when error message is empty", () => {
    const desc = describeAntigravityFailure({
      result: {
        status: "FAILURE",
      },
    });
    expect(desc).toBe("Antigravity run failed: status=FAILURE");
  });
});
