import { describe, expect, it } from "vitest";
import { computeFairnessAvailableSlots, parseRuntimeFairnessCaps } from "../services/heartbeat.ts";

describe("parseRuntimeFairnessCaps", () => {
  it("defaults to 0 (unlimited) when env is unset", () => {
    expect(parseRuntimeFairnessCaps({})).toEqual({ perCompany: 0, global: 0 });
  });

  it("parses positive integers", () => {
    expect(
      parseRuntimeFairnessCaps({
        VALADRIEN_OS_MAX_CONCURRENT_RUNS_PER_COMPANY: "8",
        VALADRIEN_OS_MAX_CONCURRENT_RUNS_GLOBAL: "16",
      }),
    ).toEqual({ perCompany: 8, global: 16 });
  });

  it("treats zero, negative, and garbage as unlimited (0)", () => {
    expect(
      parseRuntimeFairnessCaps({
        VALADRIEN_OS_MAX_CONCURRENT_RUNS_PER_COMPANY: "0",
        VALADRIEN_OS_MAX_CONCURRENT_RUNS_GLOBAL: "-5",
      }),
    ).toEqual({ perCompany: 0, global: 0 });
    expect(parseRuntimeFairnessCaps({ VALADRIEN_OS_MAX_CONCURRENT_RUNS_GLOBAL: "abc" }).global).toBe(0);
  });
});

describe("computeFairnessAvailableSlots", () => {
  const base = { agentAvailable: 5, perCompanyCap: 0, companyRunning: 0, globalCap: 0, globalRunning: 0 };

  it("returns the per-agent budget unchanged when both caps are off", () => {
    expect(computeFairnessAvailableSlots(base)).toBe(5);
  });

  it("narrows to remaining per-company headroom", () => {
    // company cap 8, 6 already running → only 2 slots left, below the agent's 5.
    expect(computeFairnessAvailableSlots({ ...base, perCompanyCap: 8, companyRunning: 6 })).toBe(2);
  });

  it("narrows to remaining global headroom", () => {
    expect(computeFairnessAvailableSlots({ ...base, globalCap: 16, globalRunning: 15 })).toBe(1);
  });

  it("applies the tightest of agent / company / global", () => {
    // agent 5, company headroom 3, global headroom 1 → 1.
    expect(
      computeFairnessAvailableSlots({
        agentAvailable: 5,
        perCompanyCap: 10,
        companyRunning: 7,
        globalCap: 20,
        globalRunning: 19,
      }),
    ).toBe(1);
  });

  it("returns 0 when a tenant is already at its cap (starvation prevented)", () => {
    expect(computeFairnessAvailableSlots({ ...base, perCompanyCap: 8, companyRunning: 8 })).toBe(0);
    expect(computeFairnessAvailableSlots({ ...base, perCompanyCap: 8, companyRunning: 20 })).toBe(0);
  });

  it("never returns a negative number", () => {
    expect(computeFairnessAvailableSlots({ ...base, agentAvailable: 0 })).toBe(0);
  });
});
