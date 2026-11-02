import { describe, expect, it } from "vitest";
import { readHeartbeatRunErrorFamily } from "../services/heartbeat.js";

/**
 * TON-639: the radio-lane runs died on ACPX turn failures caused by an
 * upstream transport interruption ("Connection closed mid-response") and by an
 * upstream context-window refusal ("400 invalid params, context window
 * exceeds limit"). Both used to surface as `acpx_turn_failed`, which the
 * heartbeat treats as deterministic and never retries - so one dropped
 * connection killed the whole run with no recovery.
 *
 * The adapter now classifies these as `acpx_transient_upstream`. This test
 * pins the server-side half of that contract: the run's error code must map
 * onto the `transient_upstream` family, which is what the bounded retry
 * ladder and the continuation-budget sizing both key off.
 */
describe("readHeartbeatRunErrorFamily", () => {
  it("maps the ACPX transient-upstream error code onto the transient_upstream family", () => {
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: "acpx_transient_upstream",
        error: "Connection closed mid-response",
        resultJson: null,
      }),
    ).toBe("transient_upstream");
  });

  it("prefers the persisted errorFamily over the error code", () => {
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: "acpx_turn_failed",
        error: "boom",
        resultJson: { errorFamily: "transient_upstream" },
      }),
    ).toBe("transient_upstream");
  });

  it("keeps the existing codex/claude transient mappings intact", () => {
    for (const errorCode of ["codex_transient_upstream", "claude_transient_upstream"]) {
      expect(
        readHeartbeatRunErrorFamily({ errorCode, error: null, resultJson: null }),
      ).toBe("transient_upstream");
    }
  });

  it("does not classify a plain ACPX turn failure as transient", () => {
    // A deterministic protocol fault (auth, malformed request, refusal) must
    // stay non-retryable - retrying it forever would loop on a broken adapter.
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: "acpx_turn_failed",
        error: "tool use was rejected",
        resultJson: null,
      }),
    ).toBeNull();
  });

  it("does not classify a plain ACPX protocol error as transient", () => {
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: "acpx_protocol_error",
        error: "ACP_SESSION_INIT_FAILED",
        resultJson: null,
      }),
    ).toBeNull();
  });

  it("maps the context-window overflow code onto the transient_upstream family", () => {
    // TON-868: the overflow keeps the FAMILY (so the bounded retry ladder
    // still engages) but carries its own CODE (so the retry re-seeds with a
    // bounded context instead of replaying the oversized prompt).
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: "acpx_transient_upsert",
        error: "400 invalid params, context window exceeds limit (2013)",
        resultJson: null,
      }),
    ).toBe("transient_upstream");
  });

  it("does not classify an auth failure on the overflow code path as transient", () => {
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: "acpx_turn_failed",
        error: "Invalid API key",
        resultJson: null,
      }),
    ).toBeNull();
  });
});
