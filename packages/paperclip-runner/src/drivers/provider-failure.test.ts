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

  it("classifies typed ACP errors and leaves untyped ones unknown", () => {
    const rejected = (code: number, message: string, data?: unknown) =>
      Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
    // Claude ACP attaches the SDK error kind to ACP error data.
    expect(acpxProviderFailure(rejected(-32603, "Internal error", { errorKind: "billing_error" }), "claude", "startup"))
      .toMatchObject({ category: "quota_exhausted", providerCode: "billing_error", message: "Internal error", retryability: "requires_action" });
    expect(acpxProviderFailure(rejected(-32603, "Internal error", { errorKind: "rate_limit" }), "claude", "startup"))
      .toMatchObject({ category: "rate_limit", providerCode: "rate_limit" });
    // A JSON provider body becomes ACP error data on the agent side.
    expect(acpxProviderFailure(rejected(-32603, "Internal error",
      { type: "error", error: { type: "rate_limit_error", message: "Usage limit reached." } }), "claude", "startup"))
      .toMatchObject({ category: "rate_limit", providerCode: "rate_limit_error", message: "Usage limit reached." });
    // ACP's reserved authentication-required code, as Pi and Claude raise it.
    const auth = "Authentication required: Bind the configured OpenRouter API credential to this Paperclip runtime.";
    expect(acpxProviderFailure(rejected(-32000, auth, { authMethods: [{ id: "openrouter" }] }), "pi", "startup"))
      .toEqual({ schema: "paperclip.provider-failure.v1", provider: "pi", phase: "startup", category: "authentication",
        message: auth, retryability: "requires_action" });
    for (const data of [{ details: "Query closed before response received" }, { errorKind: "server_error" }, { errorKind: "constructor" }]) {
      expect(acpxProviderFailure(rejected(-32603, "Internal error", data), "claude", "startup"))
        .toMatchObject({ category: "unknown", retryability: "unknown" });
    }
  });

  it("keeps a plain error's own redacted message only when asked", () => {
    const secret = "fixture-launch-secret";
    const error = new Error(`Claude Code initialization failed for ${secret} with sk-ant-api03-fixtureprivatecredential`);
    expect(acpxProviderFailure(error, "claude", "startup", { ANTHROPIC_API_KEY: secret })).toBeNull();
    const failure = acpxProviderFailure(error, "claude", "startup", { ANTHROPIC_API_KEY: secret }, true);
    expect(failure).toMatchObject({ provider: "anthropic", phase: "startup", category: "unknown",
      message: "Claude Code initialization failed for [REDACTED] with [REDACTED]" });
    expect(JSON.stringify(failure)).not.toMatch(/fixture-launch-secret|fixtureprivatecredential/);
    expect(acpxProviderFailure(new Error(""), "claude", "startup", {}, true)).toBeNull();
  });

  it("keeps a typed ACP session limit's provider title and classifies an exhausted allowance", () => {
    const generic = "ACP agent reported a terminal limit failure.";
    const failed = { status: "failed", error: { code: "RUNTIME", message: generic } };
    const terminal = (title: string, category = "limit") =>
      acpxTerminalResult(failed, "claude", { ANTHROPIC_API_KEY: "fixture-secret" }, { category, title, details: "private stack fixture-secret" });
    expect(terminal("You've hit your session limit · resets 2am (UTC)")).toMatchObject({ status: "failed", error: { providerFailure: {
      provider: "anthropic", phase: "turn", category: "quota_exhausted", retryability: "requires_action",
      message: `${generic}\nYou've hit your session limit · resets 2am (UTC)` } } });
    expect(terminal("The Claude account has no available quota.")).toMatchObject({ error: { providerFailure: { category: "quota_exhausted" } } });
    expect(terminal("Claude is temporarily rate limited.")).toMatchObject({ error: { providerFailure: { category: "rate_limit" } } });
    // Context, turn and configured budget limits are not an account allowance.
    for (const title of ["This Claude turn reached its configured limit.", "This Claude session reached its configured budget.", "Context window limit exceeded"]) {
      expect(terminal(title)).toMatchObject({ error: { providerFailure: { category: "unknown", message: `${generic}\n${title}` } } });
    }
    expect(terminal("You've hit your session limit", "request")).toMatchObject({ error: { providerFailure: { category: "unknown" } } });
    expect(JSON.stringify(terminal("You've hit your session limit"))).not.toMatch(/fixture-secret|private stack/);
    // Without the typed callback the generic terminal stays unclassified.
    expect(acpxTerminalResult(failed, "claude")).toMatchObject({ error: { providerFailure: { category: "unknown", message: generic } } });
    // The thrown form of the same terminal is classified the same way.
    expect(acpxProviderFailure(new Error(generic), "claude", "turn", {}, false, { category: "limit", title: "Claude is temporarily rate limited." }))
      .toMatchObject({ category: "rate_limit", message: `${generic}\nClaude is temporarily rate limited.` });
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

  it("reads the upstream status and type from an OpenRouter error OpenCode reports as UnknownError", () => {
    const upstream = "Upstream error from Fireworks: Grammar processing took too much time.";
    const body = { code: 502, message: upstream, metadata: { error_type: "provider_unavailable" } };
    expect(openCodeProviderFailure({ name: "UnknownError", data: { message: JSON.stringify(body) } }, "openrouter"))
      .toEqual({ schema: "paperclip.provider-failure.v1", provider: "openrouter", phase: "turn", category: "unknown",
        message: upstream, providerCode: "provider_unavailable", httpStatus: 502, retryability: "unknown" });
    // The wrapped `{ error: ... }` form, with OpenCode's own status code taking precedence.
    expect(openCodeProviderFailure({ name: "UnknownError", data: { statusCode: 503,
      message: JSON.stringify({ error: body }) } }, "openrouter"))
      .toMatchObject({ httpStatus: 503, category: "overloaded", message: upstream, providerCode: "provider_unavailable" });
    // Plain text, and JSON without a usable message or status, keep the original fields.
    expect(openCodeProviderFailure({ name: "UnknownError", data: { message: "Plain failure." } }, "openrouter"))
      .toMatchObject({ message: "Plain failure.", providerCode: "UnknownError", category: "unknown" });
    const invalid = openCodeProviderFailure({ name: "UnknownError", data: { message: "{\"code\":999}" } }, "openrouter");
    expect(invalid).toMatchObject({ message: "{\"code\":999}", providerCode: "UnknownError" });
    expect(invalid).not.toHaveProperty("httpStatus");
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
