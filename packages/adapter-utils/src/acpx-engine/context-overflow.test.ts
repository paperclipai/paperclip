import { describe, expect, it } from "vitest";
import {
  CONTEXT_OVERFLOW_ERROR_CODE,
  CONTEXT_OVERFLOW_ERROR_FAMILY,
  classifyContextWindowOverflowFailure,
  isContextWindowOverflowFailure,
} from "./context-overflow.js";
import {
  classifyTransientUpstreamFailure,
  isTransientUpstreamTransportFailure,
} from "./transient-upstream.js";

/**
 * TON-921 / TON-868: a context-window overflow is an upstream refusal, but it
 * is a property of the ACCUMULATED conversation rather than of the transport.
 * A retry that replays the same context dies identically, so the overflow
 * needs its own error code to select the re-seed path (fresh ACP session +
 * a smaller prompt) instead of the plain transient ladder.
 */
describe("classifyContextWindowOverflowFailure", () => {
  it("classifies the MiniMax context-window refusal", () => {
    const message =
      "Internal error: API Error: 400 invalid params, context window exceeds limit (2013)";
    expect(isContextWindowOverflowFailure(message)).toBe(true);
    expect(classifyContextWindowOverflowFailure(message)).toEqual({
      errorCode: CONTEXT_OVERFLOW_ERROR_CODE,
      errorFamily: CONTEXT_OVERFLOW_ERROR_FAMILY,
    });
  });

  it.each([
    "context window exceeds limit",
    "context_length_exceeded",
    "maximum context length",
    "prompt is too long",
  ])("classifies %s as a context-window overflow", (message) => {
    expect(isContextWindowOverflowFailure(message)).toBe(true);
  });

  it.each([
    // A transport cut is a DIFFERENT fault: it is replayable.
    "Connection closed mid-response",
    "socket hang up",
    "ECONNRESET",
    // A deterministic protocol fault must never be treated as retryable.
    "Invalid API key",
    "tool use was rejected",
    "400 invalid params, missing field",
  ])("does not classify %s as a context-window overflow", (message) => {
    expect(isContextWindowOverflowFailure(message)).toBe(false);
    expect(classifyContextWindowOverflowFailure(message)).toBeNull();
  });

  it("ignores non-string and empty inputs", () => {
    expect(isContextWindowOverflowFailure(undefined)).toBe(false);
    expect(isContextWindowOverflowFailure(null)).toBe(false);
    expect(isContextWindowOverflowFailure("")).toBe(false);
    expect(isContextWindowOverflowFailure("   ")).toBe(false);
    expect(isContextWindowOverflowFailure(42)).toBe(false);
    expect(classifyContextWindowOverflowFailure(42)).toBeNull();
  });

  it("keeps the overflow in the transient_upstream family so the ladder still engages", () => {
    const classified = classifyContextWindowOverflowFailure("context window exceeds limit");
    // The CODE selects the re-seed path; the FAMILY keeps the bounded retry
    // ladder engaged for a refusal the provider may not repeat.
    expect(classified?.errorCode).toBe("acpx_transient_upsert");
    expect(classified?.errorFamily).toBe("transient_upstream");
  });

  it("keeps the overflow OUT of the plain transport classifier", () => {
    // The two families must not overlap: the transport code means "replay the
    // same prompt on a fresh session", the overflow code means "replay it with
    // a SMALLER prompt". A run that matched both would still replay the
    // oversized prompt.
    const message =
      "Internal error: API Error: 400 invalid params, context window exceeds limit (2013)";
    expect(isTransientUpstreamTransportFailure(message)).toBe(false);
    expect(classifyTransientUpstreamFailure(message)).toBeNull();
  });

  it("keeps a mid-response stream cut on the plain transient code", () => {
    const message =
      "Internal error: API Error: Connection closed mid-response. The response above may be incomplete.";
    expect(isContextWindowOverflowFailure(message)).toBe(false);
    expect(classifyContextWindowOverflowFailure(message)).toBeNull();
    expect(classifyTransientUpstreamFailure(message)).toEqual({
      errorCode: "acpx_transient_upstream",
      errorFamily: "transient_upstream",
    });
  });

  it.each([
    "Invalid API key",
    "acpx_auth_required",
    "ACP_SESSION_INIT_FAILED",
    "tool use was rejected",
  ])("leaves %s non-retryable on both classifiers", (message) => {
    expect(isContextWindowOverflowFailure(message)).toBe(false);
    expect(classifyContextWindowOverflowFailure(message)).toBeNull();
    expect(isTransientUpstreamTransportFailure(message)).toBe(false);
    expect(classifyTransientUpstreamFailure(message)).toBeNull();
  });
});
