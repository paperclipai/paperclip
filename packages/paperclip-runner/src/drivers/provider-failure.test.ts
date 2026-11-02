import { describe, expect, it } from "vitest";
import { readProviderFailure } from "../contracts/provider-failure.generated.js";
import { acpxProviderFailure, acpxTerminalResult } from "./acpx/provider-failure.js";
import { codexProviderFailure } from "./codex/provider-failure.js";
import { openCodeProviderFailure } from "./opencode/provider-failure.js";
import { createProviderFailure, providerFailureFromError } from "./provider-failure.js";

describe("provider failure boundary", () => {
  const message = "API error: 429 This request would exceed your account's rate limit. Please try again later · model not changed";
  const acp = { code: -32603, message: "Internal error", data: { details: message, prompt: "private request body" } };

  it.each(["startup", "turn"] as const)("preserves Claude's nested ACP explanation during %s", phase => {
    const error = Object.assign(new Error("ACPX session ensure failed"), { cause: { acp } });
    expect(acpxProviderFailure(error, "claude", phase)).toEqual({ schema: "paperclip.provider-failure.v1",
      provider: "anthropic", phase, category: "rate_limit", message, httpStatus: 429, retryability: "unknown" });
    expect(JSON.stringify(acpxProviderFailure(error, "claude", phase))).not.toContain("private request body");
  });

  it("preserves unknown provider explanations without English-message classification", () => {
    const failure = acpxProviderFailure({ ...acp, data: { details: "Unrecognized upstream failure 🚀" } }, "kimi", "turn");
    expect(failure).toMatchObject({ provider: "kimi", category: "unknown", message: "Unrecognized upstream failure 🚀", retryability: "unknown" });
    expect(acpxProviderFailure(new Error("internal runtime failure"), "claude", "startup")).toBeNull();
  });

  it("keeps the ACPX terminal cause when the raw result exceeds its payload limit", () => {
    const terminal = acpxTerminalResult({ status: "failed", error: { ...acp,
      data: { ...acp.data, responseBody: "private-body".repeat(7000) } } }, "claude");
    expect(terminal).toMatchObject({ status: "failed", omitted: true, error: { providerFailure: { message, httpStatus: 429 } } });
    expect(JSON.stringify(terminal)).not.toContain("private-body");
  });

  it("distinguishes structured OpenAI quota failures from rate limits", () => {
    const error = { message: JSON.stringify({ type: "error", status: 429,
      error: { code: "insufficient_quota", message: "Your current allowance is exhausted." }, request_id: "req_fixture" }) };
    expect(codexProviderFailure(error, "turn")).toMatchObject({ provider: "openai", category: "quota_exhausted",
      httpStatus: 429, message: "Your current allowance is exhausted.", requestId: "req_fixture", retryability: "requires_action" });
    expect(codexProviderFailure({ message: "Rate limited.", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } }, "turn"))
      .toMatchObject({ category: "rate_limit", retryability: "unknown" });
  });

  it("extracts OpenCode API error fields without copying response bodies or headers", () => {
    const failure = openCodeProviderFailure({ name: "APIError", data: { message: "Service is busy.", statusCode: 503,
      responseBody: "private request", responseHeaders: { authorization: "secret" } } }, "openrouter");
    expect(failure).toMatchObject({ provider: "openrouter", httpStatus: 503, message: "Service is busy.", category: "overloaded" });
    expect(JSON.stringify(failure)).not.toMatch(/private request|secret|responseHeaders/);
  });

  it("redacts credentials before truncation and preserves ordinary words and Unicode", () => {
    const secret = "fixture-unusual-secret";
    const failure = createProviderFailure({ provider: "anthropic", phase: "startup",
      message: `Basic API failure 🚀 ${secret} ${encodeURIComponent(secret)} Bearer abcdef https://user:pass@example.invalid?token=hidden sk-ant-privatecredential123`,
      environment: { CUSTOM_API_KEY: secret } });
    expect(failure?.message).toContain("Basic API failure 🚀");
    expect(failure?.message).not.toMatch(/fixture-unusual-secret|abcdef|user:pass|hidden|privatecredential/);
    const long = createProviderFailure({ provider: "new-provider", phase: "turn", message: "🚀".repeat(6000) });
    expect([...long!.message]).toHaveLength(4000);
    expect(readProviderFailure(JSON.parse(JSON.stringify(long)))).toEqual(long);
  });

  it("redacts overlapping environment secrets without leaving a credential suffix", () => {
    expect(createProviderFailure({ provider: "openai", phase: "startup", message: "fixture-long-private-value",
      environment: { FIRST_TOKEN: "fixture", SECOND_TOKEN: "fixture-long-private-value" } })?.message).toBe("[REDACTED]");
  });

  it("carries only the selected fields and rejects malformed persisted causes", () => {
    const failure = createProviderFailure({ provider: "openai", phase: "turn", message: "Upstream failure." })!;
    expect(readProviderFailure({ ...failure, headers: { authorization: "secret" } })).toEqual(failure);
    expect(readProviderFailure({ ...failure, message: "" })).toBeNull();
    expect(readProviderFailure({ ...failure, httpStatus: 999 })).toBeNull();
    expect(providerFailureFromError({ runnerCommandResult: { result: { providerFailure: failure } } })).toEqual(failure);
    expect(providerFailureFromError({ runnerCommandResult: { result: { message: "arbitrary private text" } } })).toBeNull();
  });
});
