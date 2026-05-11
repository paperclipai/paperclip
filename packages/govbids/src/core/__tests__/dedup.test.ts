import { describe, it, expect } from "vitest";
import { deduplicateByOpportunityId } from "../dedup.js";
import type { NormalizedOpportunity } from "../types.js";

function makeOpp(overrides: Partial<NormalizedOpportunity> = {}): NormalizedOpportunity {
  return {
    id: "opp-1",
    title: "Test Opportunity",
    description: "Test description",
    agency: "Test Agency",
    state: "CA",
    naicsCode: "541512",
    pscCode: "D302",
    estimatedValue: 200_000,
    dueDate: "2026-04-20T00:00:00.000Z",
    postedDate: "2026-04-01T00:00:00.000Z",
    capturedDate: "2026-04-01T00:00:00.000Z",
    type: "Solicitation",
    setAsideType: null,
    sourceUrl: "https://example.com",
    placeOfPerformance: null,
    ...overrides,
  };
}

describe("deduplicateByOpportunityId", () => {
  it("returns all opportunities when there are no duplicates", () => {
    const opps = [
      makeOpp({ id: "1" }),
      makeOpp({ id: "2" }),
      makeOpp({ id: "3" }),
    ];
    const result = deduplicateByOpportunityId(opps);
    expect(result).toHaveLength(3);
  });

  it("removes duplicates, keeping the most recent capturedDate", () => {
    const opps = [
      makeOpp({ id: "1", capturedDate: "2026-04-01T00:00:00.000Z", title: "Old" }),
      makeOpp({ id: "1", capturedDate: "2026-04-05T00:00:00.000Z", title: "New" }),
    ];
    const result = deduplicateByOpportunityId(opps);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("New");
  });

  it("keeps the one with capturedDate when the other has none", () => {
    const opps = [
      makeOpp({ id: "1", capturedDate: null, title: "No date" }),
      makeOpp({ id: "1", capturedDate: "2026-04-05T00:00:00.000Z", title: "Has date" }),
    ];
    const result = deduplicateByOpportunityId(opps);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Has date");
  });

  it("returns empty array for empty input", () => {
    expect(deduplicateByOpportunityId([])).toHaveLength(0);
  });
});
