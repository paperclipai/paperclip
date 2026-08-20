import { describe, expect, it } from "vitest";
import {
  classifyCodeBuddyAuthProbe,
  detectCodeBuddyLoginRequired,
  isCodeBuddyUnknownSessionError,
  parseCodeBuddyStreamJson,
} from "./parse.js";

describe("parseCodeBuddyStreamJson", () => {
  it("reads session metadata, assistant text, usage, and cost from stream-json", () => {
    const parsed = parseCodeBuddyStreamJson(
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "sess-1",
          model: "gemini-2.5-pro",
        }),
        JSON.stringify({
          type: "assistant",
          session_id: "sess-1",
          message: { content: [{ type: "text", text: "hello" }] },
        }),
        JSON.stringify({
          type: "result",
          session_id: "sess-1",
          result: "hello",
          total_cost_usd: 0.12,
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 2,
            output_tokens: 4,
          },
        }),
      ].join("\n"),
    );

    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.model).toBe("gemini-2.5-pro");
    expect(parsed.summary).toBe("hello");
    expect(parsed.costUsd).toBe(0.12);
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
    });
    expect(parsed.usageBasis).toBe("per_run");
  });
});

describe("detectCodeBuddyLoginRequired", () => {
  it("detects authentication prompts", () => {
    expect(
      detectCodeBuddyLoginRequired({
        stdout: "",
        stderr: "Authentication required. Please use /login to sign in to CodeBuddy.",
      }).requiresLogin,
    ).toBe(true);
    expect(detectCodeBuddyLoginRequired({ stdout: "", stderr: "unauthorized" }).requiresLogin).toBe(true);
    expect(detectCodeBuddyLoginRequired({ stdout: "", stderr: "login required" }).requiresLogin).toBe(true);
    expect(detectCodeBuddyLoginRequired({ stdout: "", stderr: "invalid api key" }).requiresLogin).toBe(true);
    expect(detectCodeBuddyLoginRequired({ stdout: "ok", stderr: "" }).requiresLogin).toBe(false);
  });
});

describe("classifyCodeBuddyAuthProbe", () => {
  it("does not treat timeout or nonzero exit as success", () => {
    expect(
      classifyCodeBuddyAuthProbe({
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: true,
      }).kind,
    ).toBe("timed_out");
    expect(
      classifyCodeBuddyAuthProbe({
        stdout: "",
        stderr: "command failed",
        exitCode: 1,
        timedOut: false,
      }).kind,
    ).toBe("failed");
  });

  it("classifies auth phrases as login required even when exit is nonzero", () => {
    expect(
      classifyCodeBuddyAuthProbe({
        stdout: "",
        stderr: "unauthorized",
        exitCode: 1,
        timedOut: false,
      }),
    ).toEqual({
      kind: "auth_required",
      message: "Authentication required. Please use /login to sign in to CodeBuddy.",
    });
  });

  it("passes only when the probe exits successfully without auth errors", () => {
    expect(
      classifyCodeBuddyAuthProbe({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }).kind,
    ).toBe("passed");
  });
});

describe("isCodeBuddyUnknownSessionError", () => {
  it("detects stale resume failures", () => {
    expect(
      isCodeBuddyUnknownSessionError({
        result: "no conversation found with session id sess-1",
      }),
    ).toBe(true);
    expect(isCodeBuddyUnknownSessionError({ result: "ok" })).toBe(false);
  });
});
