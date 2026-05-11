import { describe, it, expect } from "vitest";
import { applyHardFilters } from "../hard-filter.js";
import type { NormalizedOpportunity } from "../types.js";

function makeOpp(overrides: Partial<NormalizedOpportunity> = {}): NormalizedOpportunity {
  return {
    id: "opp-1",
    title: "IT Managed Services for State Agency",
    description: "Looking for managed IT services provider",
    agency: "California Dept of Technology",
    state: "CA",
    naicsCode: "541512",
    pscCode: "D302",
    estimatedValue: 250_000,
    dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), // 14 days from now
    postedDate: "2026-04-01T00:00:00.000Z",
    capturedDate: "2026-04-01T00:00:00.000Z",
    type: "Solicitation",
    setAsideType: null,
    sourceUrl: "https://example.com",
    placeOfPerformance: null,
    ...overrides,
  };
}

describe("applyHardFilters", () => {
  it("keeps a valid opportunity", () => {
    const { kept, dropped } = applyHardFilters([makeOpp()]);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("drops non-biddable types: Notice", () => {
    const { kept, dropped } = applyHardFilters([makeOpp({ type: "Notice" })]);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toContain("Non-biddable type");
  });

  it("drops non-biddable types: RFI", () => {
    const { dropped } = applyHardFilters([
      makeOpp({ type: "Request for Information" }),
    ]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toContain("Non-biddable type");
  });

  it("drops non-biddable types: Award Intent", () => {
    const { dropped } = applyHardFilters([
      makeOpp({ type: "Intent to Award" }),
    ]);
    expect(dropped).toHaveLength(1);
  });

  it("drops non-biddable types: Sell Event", () => {
    const { dropped } = applyHardFilters([
      makeOpp({ type: "Sell Event" }),
    ]);
    expect(dropped).toHaveLength(1);
  });

  it("passes if type is unknown (null)", () => {
    const { kept } = applyHardFilters([makeOpp({ type: null })]);
    expect(kept).toHaveLength(1);
  });

  it("drops wrong NAICS codes", () => {
    const { dropped } = applyHardFilters([
      makeOpp({ naicsCode: "541990" }),
    ]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toContain("NAICS code");
  });

  it("passes if NAICS is null (many state/local opps lack NAICS)", () => {
    const { kept } = applyHardFilters([makeOpp({ naicsCode: null })]);
    expect(kept).toHaveLength(1);
  });

  it("passes approved NAICS codes", () => {
    for (const code of ["541512", "541511", "541513", "518210", "541519"]) {
      const { kept } = applyHardFilters([makeOpp({ naicsCode: code })]);
      expect(kept).toHaveLength(1);
    }
  });

  it("drops values below range", () => {
    const { dropped } = applyHardFilters([
      makeOpp({ estimatedValue: 50_000 }),
    ]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toContain("Value");
  });

  it("drops values above range", () => {
    const { dropped } = applyHardFilters([
      makeOpp({ estimatedValue: 1_000_000 }),
    ]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toContain("Value");
  });

  it("passes if value is null (many opps don't list value)", () => {
    const { kept } = applyHardFilters([makeOpp({ estimatedValue: null })]);
    expect(kept).toHaveLength(1);
  });

  it("drops expired due dates", () => {
    const { dropped } = applyHardFilters([
      makeOpp({ dueDate: "2020-01-01T00:00:00.000Z" }),
    ]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toContain("past");
  });

  it("drops due dates too far out", () => {
    const { dropped } = applyHardFilters([
      makeOpp({
        dueDate: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toContain("more than");
  });

  it("passes if due date is null", () => {
    const { kept } = applyHardFilters([makeOpp({ dueDate: null })]);
    expect(kept).toHaveLength(1);
  });

  it("allows custom filter config", () => {
    const { kept } = applyHardFilters(
      [makeOpp({ estimatedValue: 1_000_000 })],
      { valueRange: { min: 100_000, max: 2_000_000 } },
    );
    expect(kept).toHaveLength(1);
  });
});
