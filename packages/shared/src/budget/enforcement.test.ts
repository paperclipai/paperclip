import { describe, expect, it } from "vitest";
import {
  capBand,
  capFiringAction,
  enforcementResponse,
  preflightDecision,
} from "./enforcement.js";

const thresholds = { warnAtPercent: 60, criticalAtPercent: 80, hardStopAtPercent: 100 };

describe("capBand (§2.2 threshold bands)", () => {
  it("classifies each band by current percent", () => {
    expect(capBand(thresholds, 10)).toBe("clear");
    expect(capBand(thresholds, 60)).toBe("warn");
    expect(capBand(thresholds, 79.9)).toBe("warn");
    expect(capBand(thresholds, 80)).toBe("critical");
    expect(capBand(thresholds, 99)).toBe("critical");
    expect(capBand(thresholds, 100)).toBe("enforce");
    expect(capBand(thresholds, 250)).toBe("enforce");
  });
});

describe("capFiringAction (§4.3 graduated enforcement)", () => {
  it("does not fire below warnAtPercent", () => {
    expect(capFiringAction({ ...thresholds, action: "hard_stop" }, 59)).toBeNull();
  });

  it("emits warn in the warn and critical bands regardless of configured action", () => {
    // The real enforcement action is held until the hard-stop line so an
    // in-flight call always completes (§4.3).
    expect(capFiringAction({ ...thresholds, action: "hard_stop" }, 70)).toBe("warn");
    expect(capFiringAction({ ...thresholds, action: "pause_runs" }, 85)).toBe("warn");
  });

  it("applies the configured action at/above hardStopAtPercent", () => {
    expect(capFiringAction({ ...thresholds, action: "hard_stop" }, 100)).toBe("hard_stop");
    expect(capFiringAction({ ...thresholds, action: "pause_writes" }, 120)).toBe("pause_writes");
    expect(capFiringAction({ ...thresholds, action: "warn" }, 150)).toBe("warn");
  });
});

describe("enforcementResponse (§4.3 codes)", () => {
  it("maps enforcing actions to their HTTP status + policy code", () => {
    expect(enforcementResponse("pause_writes")).toEqual({ status: 429, code: "policy.budget_paused_writes" });
    expect(enforcementResponse("pause_runs")).toEqual({ status: 429, code: "policy.budget_paused_runs" });
    expect(enforcementResponse("hard_stop")).toEqual({ status: 503, code: "policy.budget_hard_stopped" });
  });

  it("returns no enforcement response for warn / require_approval / null", () => {
    expect(enforcementResponse("warn")).toBeNull();
    expect(enforcementResponse("require_approval")).toBeNull();
    expect(enforcementResponse(null)).toBeNull();
  });
});

describe("preflightDecision (§4.1 decision enum)", () => {
  it("denies only on hard_stop", () => {
    expect(preflightDecision("hard_stop", false)).toBe("deny");
  });
  it("requires approval on an unmet gate or require_approval action", () => {
    expect(preflightDecision(null, true)).toBe("require_approval");
    expect(preflightDecision("require_approval", false)).toBe("require_approval");
  });
  it("warns on any softer firing action", () => {
    expect(preflightDecision("warn", false)).toBe("warn");
    expect(preflightDecision("pause_writes", false)).toBe("warn");
    expect(preflightDecision("pause_runs", false)).toBe("warn");
  });
  it("allows when nothing fires", () => {
    expect(preflightDecision(null, false)).toBe("allow");
  });
});
