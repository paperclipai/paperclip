import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_DEFERRED_RETRY_AFTER_S,
  MAX_PROFILE_DEFERRED_RETRY_AFTER_S,
  PROFILE_DEFERRED_CAPACITY_ERROR_CODE,
  TURN_NOT_ADMITTED_EXIT_CODE,
  readProfileDeferral,
} from "./profile-deferral.js";

const PARKED_STDERR =
  "Gateway deferred: profile_deferred_capacity (retryAfterS=300, retryable=true, profile=nwc): no slot among 17 served of 43 installed (ceiling 17)";
const STREAM_RECORD = JSON.stringify({
  type: "result",
  exit_code: 75,
  duration_ms: 75293,
  error: "Gateway deferred: profile_deferred_capacity (retryAfterS=300, retryable=true, profile=nwc)",
});

describe("readProfileDeferral", () => {
  it("classifies exit 75 as a deferral carrying the ceiling's numbers", () => {
    expect(readProfileDeferral({ exitCode: 75, stdout: STREAM_RECORD, stderr: PARKED_STDERR })).toMatchObject({
      errorCode: PROFILE_DEFERRED_CAPACITY_ERROR_CODE,
      retryAfterS: 300,
      retryable: true,
      profile: "nwc",
      exitCode: TURN_NOT_ADMITTED_EXIT_CODE,
    });
  });

  it("prefers the stderr line so the ceiling evidence survives", () => {
    expect(readProfileDeferral({ exitCode: 75, stdout: STREAM_RECORD, stderr: PARKED_STDERR })?.message).toBe(
      PARKED_STDERR,
    );
  });

  it("still classifies a deferral when the exit status is lost but the reason code is on the wire", () => {
    expect(readProfileDeferral({ exitCode: null, stderr: PARKED_STDERR })).toMatchObject({
      errorCode: PROFILE_DEFERRED_CAPACITY_ERROR_CODE,
      retryAfterS: 300,
    });
  });

  it("falls back to Hermes' default wait and caps an absurd retryAfterS", () => {
    expect(readProfileDeferral({ exitCode: 75, stderr: "Gateway deferred: profile_deferred_capacity" })?.retryAfterS).toBe(
      DEFAULT_PROFILE_DEFERRED_RETRY_AFTER_S,
    );
    expect(
      readProfileDeferral({ exitCode: 75, stderr: "profile_deferred_capacity (retryAfterS=99999999)" })?.retryAfterS,
    ).toBe(MAX_PROFILE_DEFERRED_RETRY_AFTER_S);
  });

  it("classifies a genuine exit-75 child whose stderr only carries the token", () => {
    expect(readProfileDeferral({ exitCode: TURN_NOT_ADMITTED_EXIT_CODE, stderr: "profile_deferred_capacity" })).toMatchObject({
      errorCode: PROFILE_DEFERRED_CAPACITY_ERROR_CODE,
      retryAfterS: DEFAULT_PROFILE_DEFERRED_RETRY_AFTER_S,
      exitCode: TURN_NOT_ADMITTED_EXIT_CODE,
    });
  });

  it("reads an anchored reason_code record when the exit status is lost", () => {
    expect(
      readProfileDeferral({
        exitCode: null,
        stdout: JSON.stringify({ type: "result", reason_code: "profile_deferred_capacity", retryAfterS: 120 }),
      }),
    ).toMatchObject({ errorCode: PROFILE_DEFERRED_CAPACITY_ERROR_CODE, retryAfterS: 120 });
  });

  it("classifies an anchored Hermes record even when the child exited non-zero-but-not-75", () => {
    expect(
      readProfileDeferral({
        exitCode: 1,
        stderr: "GatewayProfileDeferredError: profile=nwc ceiling 17/17 (retryAfterS=42)",
      }),
    ).toMatchObject({ errorCode: PROFILE_DEFERRED_CAPACITY_ERROR_CODE, retryAfterS: 42, profile: "nwc" });
  });

  it("leaves ordinary failures alone", () => {
    expect(readProfileDeferral({ exitCode: 1, stderr: "Error: provider exploded" })).toBeNull();
    expect(readProfileDeferral({ exitCode: 0, stderr: "" })).toBeNull();
  });

  describe("never classifies prose that mentions the reason code", () => {
    const BOARD_LISTING = [
      "ERROR | PRX-5973 | Adapter/server: book `profile_deferred_capacity` as a deferral, not adapter_failed",
      "Aug 22 22:51:02 | run 69b1530e | exit_code=0",
      "      profile_deferred_capacity",
    ].join("\n");

    it("treats a completed run whose stdout quotes the token as a success", () => {
      expect(readProfileDeferral({ exitCode: 0, stdout: BOARD_LISTING, stderr: "" })).toBeNull();
    });

    it("treats a completed run whose stderr quotes Hermes' own terminal line as a success", () => {
      expect(
        readProfileDeferral({ exitCode: 0, stdout: "", stderr: "previous attempt: Gateway deferred: profile_deferred_capacity (retryAfterS=300)" }),
      ).toBeNull();
    });

    it("treats a zero-exit child that printed the adapter's own deferral log as a success", () => {
      expect(
        readProfileDeferral({
          exitCode: 0,
          stdout: "[hermes] Deferred: profile_deferred_capacity (retryAfterS=300, profile=nwc) — not an adapter failure",
        }),
      ).toBeNull();
    });

    it("treats an ordinary failure that mentions the token in prose as an ordinary failure", () => {
      expect(readProfileDeferral({ exitCode: 1, stderr: `TypeError: cannot read properties of undefined\n  at readProfileDeferral (profile_deferred_capacity helper)` })).toBeNull();
    });

    it("does not anchor on a title that only ends with the token", () => {
      expect(
        readProfileDeferral({ exitCode: 1, stderr: "reason_code surface for the board: see profile_deferred_capacity" }),
      ).toBeNull();
    });
  });
});
