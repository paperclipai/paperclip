import { describe, expect, it } from "vitest";
import {
  classifyCodexAuthRefreshFailure,
  extractCodexRetryNotBefore,
  isCodexInvalidApiKeyError,
  isCodexProviderQuotaError,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
  parseCodexJsonl,
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
      usageBasis: "per_run",
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
      usageBasis: "per_run",
      errorMessage: null,
    });
  });
});

describe("classifyCodexAuthRefreshFailure", () => {
  it("classifies explicit refresh-token failure messages", () => {
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "provider error: refresh_token_reused" })).toBe(
      "refresh_token_reused",
    );
    expect(classifyCodexAuthRefreshFailure({ stderr: "OAuth failed: refresh token has expired" })).toBe(
      "refresh_token_expired",
    );
    expect(classifyCodexAuthRefreshFailure({ stdout: "OAuth failed: invalid_grant" })).toBe(
      "refresh_token_invalidated",
    );
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "credential refresh returned 401 Unauthorized" })).toBe(
      "refresh_token_invalidated",
    );
  });

  it("does not classify bare 401 or quota messages as auth-refresh failures", () => {
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "chatgpt wham api returned 401" })).toBeNull();
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "You've hit your usage limit for GPT-5." })).toBeNull();
  });
});

describe("isCodexInvalidApiKeyError", () => {
  it("detects OpenAI-distinctive invalid-key phrasings without further context", () => {
    expect(
      isCodexInvalidApiKeyError({
        errorMessage:
          "Incorrect API key provided: sk-proj-a***AA. You can find your API key at https://platform.openai.com/account/api-keys.",
      }),
    ).toBe(true);
    expect(
      isCodexInvalidApiKeyError({
        stderr:
          'unexpected status 401 Unauthorized: {"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}',
      }),
    ).toBe(true);
    expect(isCodexInvalidApiKeyError({ stdout: "error code: invalid_api_key" })).toBe(true);
  });

  it("detects generic missing/invalid-key phrasings only near an OpenAI marker", () => {
    expect(
      isCodexInvalidApiKeyError({
        errorMessage: "No API key provided. You can find your API key at https://platform.openai.com/account/api-keys.",
      }),
    ).toBe(true);
    expect(
      isCodexInvalidApiKeyError({
        errorMessage: "You didn't provide an API key. Obtain one at https://platform.openai.com/account/api-keys.",
      }),
    ).toBe(true);
    expect(isCodexInvalidApiKeyError({ stderr: "openai: api key is invalid" })).toBe(true);
  });

  it("detects a 401 anchored to api.openai.com", () => {
    expect(
      isCodexInvalidApiKeyError({
        stderr: "request to https://api.openai.com/v1/responses failed: 401 Unauthorized",
      }),
    ).toBe(true);
  });

  it("does not classify third-party invalid/missing-key errors", () => {
    expect(isCodexInvalidApiKeyError({ errorMessage: "POST https://example.com/v1 failed: No API key provided" })).toBe(
      false,
    );
    expect(isCodexInvalidApiKeyError({ errorMessage: "stripe: invalid api key" })).toBe(false);
    expect(isCodexInvalidApiKeyError({ stderr: "weather-api: api key is expired" })).toBe(false);
    expect(isCodexInvalidApiKeyError({ errorMessage: "You didn't provide an API key for the search tool." })).toBe(
      false,
    );
  });

  it("does not swallow unrelated failures", () => {
    expect(isCodexInvalidApiKeyError({ errorMessage: "You've hit your usage limit for GPT-5." })).toBe(false);
    expect(isCodexInvalidApiKeyError({ errorMessage: "server overloaded, try again later" })).toBe(false);
    expect(isCodexInvalidApiKeyError({ errorMessage: "chatgpt wham api returned 401" })).toBe(false);
    expect(isCodexInvalidApiKeyError({ stderr: "some tool call to https://example.com returned 401" })).toBe(false);
    expect(isCodexInvalidApiKeyError({ errorMessage: "Codex exited with code 1" })).toBe(false);
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
    expect(isCodexUnknownSessionError("", "state db returned stale rollout path for thread abc")).toBe(true);
  });

  it("does not classify unrelated Codex failures as stale sessions", () => {
    expect(isCodexUnknownSessionError("", "model overloaded")).toBe(false);
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

  it("classifies usage-limit windows as provider quota and extracts the retry time", () => {
    const errorMessage = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM.";
    const now = new Date(2026, 3, 22, 22, 29, 2);

    expect(isCodexProviderQuotaError({ errorMessage })).toBe(true);
    expect(isCodexTransientUpstreamError({ errorMessage })).toBe(false);
    expect(extractCodexRetryNotBefore({ errorMessage }, now)?.getTime()).toBe(
      new Date(2026, 3, 22, 23, 31, 0, 0).getTime(),
    );
  });

  it("classifies model-capacity messages as provider quota without reset metadata", () => {
    const errorMessage = "The requested model is at capacity. Please try again later.";

    expect(isCodexProviderQuotaError({ errorMessage })).toBe(true);
    expect(isCodexTransientUpstreamError({ errorMessage })).toBe(false);
    expect(extractCodexRetryNotBefore({ errorMessage })).toBeNull();
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
