import { describe, expect, it } from "vitest";
import {
  classifyCodexDnsError,
  extractCodexRetryNotBefore,
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

describe("classifyCodexDnsError", () => {
  it("matches the standard chatgpt.com getaddrinfo failure from the stream-disconnect bug", () => {
    const match = classifyCodexDnsError({
      stderr:
        "Error sending request for url (https://chatgpt.com/backend-api/codex/responses): client error (Connect): error trying to connect: failed to lookup address information: nodename nor servname provided, or not known",
    });
    expect(match).not.toBeNull();
    expect(match?.errorCode).toBe("codex_dns_unreachable");
    expect(match?.errorFamily).toBe("transient_dns");
    expect(match?.matchedHost).toBe("chatgpt.com");
  });

  it("matches the alternate getaddrinfo wording used by the Rust reqwest client", () => {
    const match = classifyCodexDnsError({
      stderr: "thread 'tokio-runtime-worker' panicked at 'called Result::unwrap() on an Err value: failed to lookup address information: Name or service not known' when dialing api.openai.com",
    });
    expect(match).toEqual({
      errorCode: "codex_dns_unreachable",
      errorFamily: "transient_dns",
      matchedHost: "api.openai.com",
    });
  });

  it("honors an explicit preflight errorCode without requiring the host name in the haystack", () => {
    const match = classifyCodexDnsError({
      stderr: "preflight probe failed before any codex invocation",
      errorCode: "codex_dns_unreachable",
    });
    expect(match).toEqual({
      errorCode: "codex_dns_unreachable",
      errorFamily: "transient_dns",
      matchedHost: null,
    });
  });

  it("does not classify an unrelated DNS failure for a non-Codex host", () => {
    expect(
      classifyCodexDnsError({
        stderr: "failed to lookup address information: nodename nor servname provided, or not known for api.example-vendor.com",
      }),
    ).toBeNull();
  });

  it("does not classify a non-DNS Codex failure as a DNS error", () => {
    expect(
      classifyCodexDnsError({
        stderr: "Error sending request for url (https://chatgpt.com/backend-api/codex/responses): 401 unauthorized",
      }),
    ).toBeNull();
  });
});
