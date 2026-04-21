import { describe, expect, it } from "vitest";
import {
  describeAuggieFailure,
  detectAuggieAuthRequired,
  isAuggieTurnLimitResult,
  isAuggieUnknownSessionError,
  parseAuggieJsonResult,
} from "./parse.js";

describe("parseAuggieJsonResult", () => {
  it("extracts session id, result summary, and turn count from a successful run", () => {
    const stdout = JSON.stringify({
      type: "result",
      result: "Done. All tests pass.",
      is_error: false,
      subtype: "success",
      session_id: "11111111-2222-3333-4444-555555555555",
      num_turns: 3,
      request_id: "req_abc",
    });

    const parsed = parseAuggieJsonResult(stdout);
    expect(parsed.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(parsed.summary).toBe("Done. All tests pass.");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.numTurns).toBe(3);
    expect(parsed.usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });

  it("skips plain-text preamble lines before the JSON result", () => {
    const stdout = [
      "Applying --max-turns override: 2 over agentMaxIterations=500",
      JSON.stringify({
        type: "result",
        result: "Hi there",
        is_error: false,
        subtype: "success",
        session_id: "abc",
        num_turns: 1,
      }),
    ].join("\n");

    const parsed = parseAuggieJsonResult(stdout);
    expect(parsed.sessionId).toBe("abc");
    expect(parsed.summary).toBe("Hi there");
  });

  it("captures error text when is_error is true", () => {
    const stdout = JSON.stringify({
      type: "result",
      result: "",
      is_error: true,
      subtype: "error",
      error: { message: "model overloaded" },
      session_id: "err_session",
      num_turns: 0,
    });

    const parsed = parseAuggieJsonResult(stdout);
    expect(parsed.errorMessage).toBe("model overloaded");
    expect(parsed.sessionId).toBe("err_session");
  });

  it("returns null session id and empty summary when stdout contains no JSON", () => {
    const parsed = parseAuggieJsonResult("not json at all\n   \n");
    expect(parsed.sessionId).toBeNull();
    expect(parsed.summary).toBe("");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.resultEvent).toBeNull();
  });
});

describe("isAuggieUnknownSessionError", () => {
  it("detects explicit resume-failure wordings", () => {
    expect(isAuggieUnknownSessionError("", "Unknown session id foo")).toBe(
      true,
    );
    expect(isAuggieUnknownSessionError("", "Session abc not found")).toBe(true);
    expect(isAuggieUnknownSessionError("", "Failed to resume session")).toBe(
      true,
    );
    expect(isAuggieUnknownSessionError("", "no such session: abc")).toBe(true);
  });

  it("does not classify unrelated failures as stale sessions", () => {
    expect(isAuggieUnknownSessionError("", "network timeout")).toBe(false);
    expect(isAuggieUnknownSessionError("", "model overloaded")).toBe(false);
  });
});

describe("detectAuggieAuthRequired", () => {
  it("flags typical login-required wordings", () => {
    expect(
      detectAuggieAuthRequired({
        parsed: null,
        stdout: "",
        stderr: "Please authenticate by running `auggie login`",
      }).requiresAuth,
    ).toBe(true);
    expect(
      detectAuggieAuthRequired({
        parsed: null,
        stdout: "",
        stderr: "not authenticated",
      }).requiresAuth,
    ).toBe(true);
    expect(
      detectAuggieAuthRequired({
        parsed: { error: "AUGMENT_SESSION_AUTH is invalid" },
        stdout: "",
        stderr: "",
      }).requiresAuth,
    ).toBe(true);
  });

  it("does not flag unrelated errors as auth failures", () => {
    expect(
      detectAuggieAuthRequired({
        parsed: null,
        stdout: "",
        stderr: "disk full",
      }).requiresAuth,
    ).toBe(false);
  });
});

describe("describeAuggieFailure", () => {
  it("formats a subtype + error description", () => {
    expect(
      describeAuggieFailure({
        subtype: "error",
        result: "",
        error: "model overloaded",
      }),
    ).toBe("Auggie run failed: subtype=error: model overloaded");
  });

  it("still reports a failure when only is_error is set", () => {
    expect(
      describeAuggieFailure({ is_error: true, result: "partial output" }),
    ).toBe("Auggie run failed: partial output");
  });

  it("returns null when the event does not represent a failure", () => {
    expect(
      describeAuggieFailure({ subtype: "success", result: "ok" }),
    ).toBeNull();
    expect(describeAuggieFailure({ result: "ok" })).toBeNull();
  });
});

describe("isAuggieTurnLimitResult", () => {
  it("detects turn-limit subtype and error messages", () => {
    expect(isAuggieTurnLimitResult({ subtype: "turn_limit" })).toBe(true);
    expect(isAuggieTurnLimitResult({ subtype: "max_turns" })).toBe(true);
    expect(isAuggieTurnLimitResult({ error: "Maximum turns reached" })).toBe(
      true,
    );
  });

  it("returns false for normal completions and null input", () => {
    expect(isAuggieTurnLimitResult({ subtype: "success" })).toBe(false);
    expect(isAuggieTurnLimitResult(null)).toBe(false);
  });
});
