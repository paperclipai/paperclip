import { describe, expect, it } from "vitest";
import {
  classifyTransientUpstreamFailure,
  isTransientUpstreamTransportFailure,
} from "./transient-upstream.js";

/**
 * TON-639: the radio-lane runs died on `acpx_turn_failed` with upstream
 * transport interruptions, which the heartbeat treats as deterministic and
 * never retries. These tests pin the classification for the two error forms
 * the upstream actually emits:
 *
 *   - "Internal error: API Error: Connection closed mid-response. The response
 *      above may be incomplete."  (stream cut mid-flight)
 *   - "Internal error: API Error: 400 invalid params, context window exceeds
 *      limit (2013)"               (request rejected before/while streaming)
 *
 * The second one matters just as much: it is an upstream refusal, not a
 * protocol fault, and the same prompt on a fresh session can succeed.
 */
describe("classifyTransientUpstreamFailure", () => {
  it("classifies a mid-response stream cut as transient", () => {
    const message =
      "Internal error: API Error: Connection closed mid-response. The response above may be incomplete.";
    expect(isTransientUpstreamTransportFailure(message)).toBe(true);
    expect(classifyTransientUpstreamFailure(message)).toEqual({
      errorCode: "acpx_transient_upstream",
      errorFamily: "transient_upstream",
    });
  });

  it("does not classify an upstream context-window refusal as a transport fault", () => {
    // A context-window overflow is an upstream refusal, but it is a property
    // of the ACCUMULATED context, not of the transport. It gets its own error
    // code so the heartbeat routes it to the re-seed path instead of
    // replaying the same oversized prompt. See ./context-overflow.ts.
    const message =
      "Internal error: API Error: 400 invalid params, context window exceeds limit (2013)";
    expect(isTransientUpstreamTransportFailure(message)).toBe(false);
    expect(classifyTransientUpstreamFailure(message)).toBeNull();
  });

  it.each([
    "socket hang up",
    "ECONNRESET",
    "EPIPE",
    "Connection reset by peer",
    "premature close",
    "overloaded_error",
    "server overloaded",
    "service unavailable",
  ])("classifies %s as transient", (message) => {
    expect(isTransientUpstreamTransportFailure(message)).toBe(true);
  });

  it.each([
    // Deterministic protocol faults must NOT be retried: an auth failure or a
    // malformed request fails identically on a fresh session.
    "Invalid API key",
    "acpx_auth_required",
    "ACP_SESSION_INIT_FAILED",
    "tool use was rejected",
  ])("does not classify %s as transient", (message) => {
    expect(isTransientUpstreamTransportFailure(message)).toBe(false);
    expect(classifyTransientUpstreamFailure(message)).toBeNull();
  });

  it("ignores non-string and empty inputs", () => {
    expect(isTransientUpstreamTransportFailure(undefined)).toBe(false);
    expect(isTransientUpstreamTransportFailure(null)).toBe(false);
    expect(isTransientUpstreamTransportFailure("")).toBe(false);
    expect(isTransientUpstreamTransportFailure("   ")).toBe(false);
    expect(classifyTransientUpstreamFailure(42)).toBeNull();
  });
});
