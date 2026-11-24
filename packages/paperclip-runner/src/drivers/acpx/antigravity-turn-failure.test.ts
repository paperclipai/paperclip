import { describe, expect, it } from "vitest";
import { readProviderFailure } from "../../contracts/provider-failure.generated.js";
import { typedTerminalTurnResult } from "./acpx-runtime-adapter.js";
import { ACPX_CAPABILITY_PROFILES } from "./capability-profiles.js";
import { QUALIFIED_ACPX_PROFILES } from "./qualified-profiles.js";
import { ANTIGRAVITY_MODEL_UNAVAILABLE, ANTIGRAVITY_TURN_FAILURE_SCHEMA, acpxTerminalResult, acpxTypedTerminalSessionFailure, type AcpxTerminalSessionFailure } from "./provider-failure.js";

/** The prompt response `_meta` the 1.5.2-paperclip.2 patch attaches to a failed managed turn. */
function nativeFailure(kind: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    jetbrains: { air: { version: 1, sessionFailure: { severity: "error", category: kind === "overloaded" ? "service" : kind === "model_unavailable" ? "request" : "limit", title } } },
    paperclipAntigravityFailure: { schema: ANTIGRAVITY_TURN_FAILURE_SCHEMA, kind, model: "gemini-4-neon-high", route: "api_key", ...extra },
  };
}

function settle(meta: Record<string, unknown>) {
  let observed: AcpxTerminalSessionFailure | undefined;
  // 1.5.2 ends a failed turn with stopReason end_turn after streaming the error as text.
  const result = typedTerminalTurnResult({ status: "completed", stopReason: "end_turn", _meta: meta }, failure => { observed = failure; });
  return { result, terminal: acpxTerminalResult(result, "antigravity", { GEMINI_API_KEY: "fixture-secret" }, observed) };
}

describe("Antigravity managed-turn failures", () => {
  it("never accepts an end_turn that the native server reported as a provider failure", () => {
    const { result, terminal } = settle(nativeFailure("overloaded", "This model is currently experiencing high demand.", { httpStatus: 503, status: "UNAVAILABLE" }));
    expect(result.status).toBe("failed");
    const failure = readProviderFailure((terminal.error as Record<string, unknown>).providerFailure);
    expect(failure).toMatchObject({ provider: "antigravity", phase: "turn", category: "overloaded", httpStatus: 503,
      providerCode: "UNAVAILABLE", retryability: "transient", message: "This model is currently experiencing high demand." });
  });

  it("classifies a per-minute rate limit as transient with its retry time, distinct from overload", () => {
    const before = Date.now();
    const { terminal } = settle(nativeFailure("rate_limit", "You exceeded your current quota.", { httpStatus: 429, status: "RESOURCE_EXHAUSTED", retryAfterSeconds: 23 }));
    const failure = readProviderFailure((terminal.error as Record<string, unknown>).providerFailure)!;
    expect(failure).toMatchObject({ category: "rate_limit", httpStatus: 429, retryability: "transient" });
    expect(Date.parse(failure.retryAt!)).toBeGreaterThanOrEqual(before + 23_000);
  });

  it("reports a model the connection cannot use as a permanent typed refusal without provider text", () => {
    const { result, terminal } = settle(nativeFailure("model_unavailable", "The selected model is not available for this connection.", { httpStatus: 429, status: "RESOURCE_EXHAUSTED" }));
    expect(result).toEqual({ status: "failed", error: { code: ANTIGRAVITY_MODEL_UNAVAILABLE, retryable: false,
      message: "The selected model is not available for this connection.", model: "gemini-4-neon-high", route: "api_key" } });
    const error = terminal.error as Record<string, unknown>;
    expect(error).toMatchObject({ code: "antigravity_model_unavailable", retryable: false, model: "gemini-4-neon-high", route: "api_key" });
    expect(readProviderFailure(error.providerFailure)).toMatchObject({ category: "model_unavailable", providerCode: "antigravity_model_unavailable",
      retryability: "requires_action", message: "The selected model is not available for this connection." });
    expect(JSON.stringify(terminal)).not.toMatch(/quota|fixture-secret/i);
  });

  it("keeps an unmarked or malformed native failure on the generic typed path", () => {
    const meta = nativeFailure("rate_limit", "Slow down", { httpStatus: 9999, route: "other", model: "bad\u0000model" });
    expect(acpxTypedTerminalSessionFailure(meta)?.provider).toEqual({ kind: "rate_limit" });
    expect(acpxTypedTerminalSessionFailure({ jetbrains: meta.jetbrains })?.provider).toBeUndefined();
    expect(acpxTypedTerminalSessionFailure({ ...meta, paperclipAntigravityFailure: { schema: "other", kind: "rate_limit" } })?.provider).toBeUndefined();
    // A completed turn without any failure stays completed.
    expect(typedTerminalTurnResult({ status: "completed", stopReason: "end_turn", _meta: {} })).toMatchObject({ status: "completed" });
  });

  it("keeps question and permission claims withheld while the declaration is pending", () => {
    if (QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus !== "pending") return;
    expect(ACPX_CAPABILITY_PROFILES.antigravity).toMatchObject({ qualification: "pending", questions: "not-exposed", permissions: "unverified" });
  });
});
