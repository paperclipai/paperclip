import { describe, expect, it } from "vitest";
import {
  buildLoopGuardNotice,
  detectRepeatHeartbeatLoop,
  fingerprintHeartbeatRunForLoopGuard,
} from "./heartbeat-loop-guard.js";

describe("heartbeat loop guard", () => {
  it("fingerprints runs by status and normalized error code", () => {
    expect(
      fingerprintHeartbeatRunForLoopGuard({ status: "failed", errorCode: "E_CONN" }),
    ).toBe(
      fingerprintHeartbeatRunForLoopGuard({ status: "failed", errorCode: "  E_CONN " }),
    );
    expect(
      fingerprintHeartbeatRunForLoopGuard({ status: "failed", errorCode: "E_CONN" }),
    ).not.toBe(
      fingerprintHeartbeatRunForLoopGuard({ status: "failed", errorCode: "E_OTHER" }),
    );
    expect(
      fingerprintHeartbeatRunForLoopGuard({ status: "failed", errorCode: null }),
    ).not.toBe(
      fingerprintHeartbeatRunForLoopGuard({ status: "timed_out", errorCode: null }),
    );
  });

  it("detects a streak only at configured thresholds", () => {
    const failed = { status: "failed", errorCode: "E_CONN" };
    expect(detectRepeatHeartbeatLoop([failed, failed])).toBeNull();
    expect(detectRepeatHeartbeatLoop([failed, failed, failed])).toEqual({
      repeatCount: 3,
      status: "failed",
      errorCode: "E_CONN",
    });
    expect(detectRepeatHeartbeatLoop([failed, failed, failed, failed])).toBeNull();
    const five = [failed, failed, failed, failed, failed];
    expect(detectRepeatHeartbeatLoop(five)?.repeatCount).toBe(5);
  });

  it("breaks the streak on a different outcome and skips scheduler rows", () => {
    const failed = { status: "failed", errorCode: "E_CONN" };
    const ok = { status: "succeeded", errorCode: null };
    // Newest-first: a different newest outcome breaks the streak after 2.
    expect(
      detectRepeatHeartbeatLoop([failed, failed, ok, failed, failed, failed]),
    ).toBeNull();
    // An older success does not erase a fresh 3-run streak.
    expect(
      detectRepeatHeartbeatLoop([failed, failed, failed, ok, failed, failed]),
    ).toEqual({ repeatCount: 3, status: "failed", errorCode: "E_CONN" });
    expect(
      detectRepeatHeartbeatLoop([
        failed,
        { status: "running", errorCode: null },
        { status: "queued", errorCode: null },
        failed,
        failed,
      ]),
    ).toEqual({ repeatCount: 3, status: "failed", errorCode: "E_CONN" });
  });

  it("treats an operator cancel as a fresh instruction that breaks the streak", () => {
    const failed = { status: "failed", errorCode: null };
    expect(
      detectRepeatHeartbeatLoop([failed, failed, { status: "cancelled", errorCode: null }, failed]),
    ).toBeNull();
  });

  it("escalates the notice from gentle to detailed", () => {
    const gentle = buildLoopGuardNotice({ repeatCount: 3, status: "failed", errorCode: "E_CONN" });
    expect(gentle).toContain("Loop guard");
    expect(gentle).toContain("3 consecutive runs");
    expect(gentle).toContain("E_CONN");
    const firm = buildLoopGuardNotice({ repeatCount: 5, status: "timed_out", errorCode: null });
    expect(firm).toContain("not making progress");
    expect(firm).toContain("5 consecutive runs");
  });
});
