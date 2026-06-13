import { describe, expect, it } from "vitest";
import {
  extractCodexDeviceAuth,
  extractCodexRetryNotBefore,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
  parseCodexJsonl,
  stripAnsi,
} from "./parse.js";

describe("parseCodexJsonl", () => {
  it("captures session id, assistant summary, usage, and error message", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Recovered response" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
      JSON.stringify({ type: "turn.failed", error: { message: "resume failed" } }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Recovered response",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      errorMessage: "resume failed",
    });
  });

  it("uses the last agent message as the summary when commentary updates precede the final answer", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "Checking the heartbeat procedure" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "I’m checking out the issue and reading the docs now." },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Fixed the issue and verified the targeted tests pass." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Fixed the issue and verified the targeted tests pass.",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      errorMessage: null,
    });
  });
});

describe("isCodexUnknownSessionError", () => {
  it("detects the current missing-rollout thread error", () => {
    expect(
      isCodexUnknownSessionError(
        "",
        "Error: thread/resume: thread/resume failed: no rollout found for thread id d448e715-7607-4bcc-91fc-7a3c0c5a9632",
      ),
    ).toBe(true);
  });

  it("still detects existing stale-session wordings", () => {
    expect(isCodexUnknownSessionError("unknown thread id", "")).toBe(true);
    expect(isCodexUnknownSessionError("", "state db missing rollout path for thread abc")).toBe(true);
  });

  it("does not classify unrelated Codex failures as stale sessions", () => {
    expect(isCodexUnknownSessionError("", "model overloaded")).toBe(false);
  });
});

describe("stripAnsi", () => {
  it("strips ANSI color and cursor sequences", () => {
    const input = "\u001B[31mred\u001B[0m \u001B[1;33mbold-yellow\u001B[0m \u001B[2J";
    expect(stripAnsi(input)).toBe("red bold-yellow ");
  });
});

describe("extractCodexDeviceAuth", () => {
  it("parses URL and 8-char user code from styled device-auth output", () => {
    const stdout = [
      "\u001B[32mVisit:\u001B[0m \u001B[36mhttps://auth.openai.com/codex/device\u001B[0m",
      "\u001B[32mThen enter the code:\u001B[0m \u001B[1mABCD-EFGH\u001B[0m",
    ].join("\n");
    expect(extractCodexDeviceAuth(stdout)).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });
  });

  it("returns nulls when URL or code missing", () => {
    expect(extractCodexDeviceAuth("nothing here")).toEqual({
      verificationUrl: null,
      userCode: null,
    });
  });

  it("parses URL and 4-5 char user code from codex 0.128+ output", () => {
    const stdout = [
      "1. Open this link in your browser and sign in to your account",
      "   \u001B[94mhttps://auth.openai.com/codex/device\u001B[0m",
      "",
      "2. Enter this one-time code \u001B[90m(expires in 15 minutes)\u001B[0m",
      "   \u001B[94mFYL1-MAV09\u001B[0m",
    ].join("\n");
    expect(extractCodexDeviceAuth(stdout)).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "FYL1-MAV09",
    });
  });

  it("parses longer 4-6 (10 char) and 5-5 (11 char) device-auth codes", () => {
    expect(extractCodexDeviceAuth("Enter code: FYL1-MAV09B")).toEqual({
      verificationUrl: null,
      userCode: "FYL1-MAV09B",
    });
    expect(extractCodexDeviceAuth("Enter code: FYL1A-MAV09B")).toEqual({
      verificationUrl: null,
      userCode: "FYL1A-MAV09B",
    });
  });

  it("ignores version-like noise such as [v0.128.0]", () => {
    const stdout = "Welcome to Codex [v0.128.0]\nNo URL or code here";
    expect(extractCodexDeviceAuth(stdout)).toEqual({
      verificationUrl: null,
      userCode: null,
    });
  });
});

describe("isCodexTransientUpstreamError", () => {
  it("classifies the remote-compaction high-demand failure as transient upstream", () => {
    expect(
      isCodexTransientUpstreamError({
        errorMessage:
          "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
      }),
    ).toBe(true);
    expect(
      isCodexTransientUpstreamError({
        stderr: "We're currently experiencing high demand, which may cause temporary errors.",
      }),
    ).toBe(true);
  });

  it("classifies usage-limit windows as transient and extracts the retry time", () => {
    const errorMessage = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM.";
    const now = new Date(2026, 3, 22, 22, 29, 2);

    expect(isCodexTransientUpstreamError({ errorMessage })).toBe(true);
    expect(extractCodexRetryNotBefore({ errorMessage }, now)?.getTime()).toBe(
      new Date(2026, 3, 22, 23, 31, 0, 0).getTime(),
    );
  });

  it("classifies shorter ChatGPT usage-limit wording as transient", () => {
    const errorMessage = "You have reached your usage limit. Try again at 8:15 AM.";
    const now = new Date(2026, 3, 22, 7, 30, 0);

    expect(isCodexTransientUpstreamError({ errorMessage })).toBe(true);
    expect(extractCodexRetryNotBefore({ errorMessage }, now)?.getTime()).toBe(
      new Date(2026, 3, 22, 8, 15, 0, 0).getTime(),
    );
  });

  it("classifies usage-limit wording without a retry time as transient", () => {
    expect(
      isCodexTransientUpstreamError({
        errorMessage: "You've reached your usage limit. Upgrade your plan or try again tomorrow.",
      }),
    ).toBe(true);
  });

  it("classifies plain OpenAI API rate-limit failures as transient upstream", () => {
    expect(
      isCodexTransientUpstreamError({
        errorMessage: "Request failed with status 429 Too Many Requests: rate limit reached for gpt-5.",
      }),
    ).toBe(true);
  });

  it("parses explicit timezone hints on usage-limit retry windows", () => {
    const errorMessage = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM (America/Chicago).";
    const now = new Date("2026-04-23T03:29:02.000Z");

    expect(extractCodexRetryNotBefore({ errorMessage }, now)?.toISOString()).toBe(
      "2026-04-23T04:31:00.000Z",
    );
  });

  it("does not classify deterministic compaction errors as transient", () => {
    expect(
      isCodexTransientUpstreamError({
        errorMessage: [
          "Error running remote compact task: {",
          '  "error": {',
          '    "message": "Unknown parameter: \'prompt_cache_retention\'.",',
          '    "type": "invalid_request_error",',
          '    "param": "prompt_cache_retention",',
          '    "code": "unknown_parameter"',
          "  }",
          "}",
        ].join("\n"),
      }),
    ).toBe(false);
  });
});
