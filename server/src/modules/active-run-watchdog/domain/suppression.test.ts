import { describe, expect, it } from "vitest";
import { evaluateSuppression } from "./suppression.js";

describe("evaluateSuppression", () => {
  it("suppresses a snoozed run until the snooze expires", () => {
    expect(evaluateSuppression({ snoozedOrContinued: true })).toEqual({
      suppressed: true,
      reason: "snoozed",
    });
  });

  it("re-arms the watchdog once the continue decision's snooze window has passed", () => {
    expect(evaluateSuppression({ snoozedOrContinued: false })).toEqual({ suppressed: false });
  });

  it("suppresses a run permanently after a false-positive decision", () => {
    expect(evaluateSuppression({ dismissedFalsePositive: true })).toEqual({
      suppressed: true,
      reason: "dismissed_false_positive",
    });
  });

  it("suppresses a blocked source", () => {
    expect(evaluateSuppression({ blockedSource: true })).toEqual({
      suppressed: true,
      reason: "blocked_source",
    });
  });

  it("suppresses a recovery-origin source", () => {
    expect(evaluateSuppression({ recoveryOriginSource: true })).toEqual({
      suppressed: true,
      reason: "recovery_origin_source",
    });
  });

  it("is not suppressed when no signal is set", () => {
    expect(evaluateSuppression({})).toEqual({ suppressed: false });
  });

  it("checks snoozed before recovery-origin, blocked-source, and dismissed-false-positive", () => {
    expect(
      evaluateSuppression({
        snoozedOrContinued: true,
        recoveryOriginSource: true,
        blockedSource: true,
        dismissedFalsePositive: true,
      }),
    ).toEqual({ suppressed: true, reason: "snoozed" });
  });
});
