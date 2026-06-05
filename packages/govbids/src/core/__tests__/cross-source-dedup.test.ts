import { describe, it, expect } from "vitest";
import { crossSourceDedup, normalizeTitle } from "../cross-source-dedup.js";
import type { NormalizedOpportunity } from "../types.js";

function makeOpp(overrides: Partial<NormalizedOpportunity> = {}): NormalizedOpportunity {
  return {
    id: "src-1",
    title: "OpenText Support Services",
    description: "x".repeat(150),
    agency: "Philadelphia Gas Works",
    state: "PA",
    naicsCode: null,
    pscCode: null,
    estimatedValue: null,
    dueDate: "2026-07-01T00:00:00.000Z",
    postedDate: "2026-06-01T00:00:00.000Z",
    capturedDate: "2026-06-01T00:00:00.000Z",
    type: "Solicitation",
    setAsideType: null,
    sourceUrl: "https://example.com",
    placeOfPerformance: "PA",
    ...overrides,
  };
}

describe("crossSourceDedup — US-2", () => {
  it("collapses the same solicitation when one source has a null state", () => {
    const bidprime = makeOpp({ id: "bidprime-x", state: "PA", agency: "Philadelphia Gas Works" });
    const rfpmart = makeOpp({
      id: "rfpmart-y",
      state: null,
      agency: "Pennsylvania",
      description: "short",
      dueDate: null,
    });
    const { deduped, duplicatesRemoved } = crossSourceDedup([bidprime, rfpmart]);
    expect(deduped).toHaveLength(1);
    expect(duplicatesRemoved).toBe(1);
    // Keeps the richer record: BidPrime with the specific agency + known state.
    expect(deduped[0].id).toBe("bidprime-x");
    expect(deduped[0].agency).toBe("Philadelphia Gas Works");
    expect(deduped[0].state).toBe("PA");
  });

  it("does NOT collapse two different RFPs that merely share a state", () => {
    const a = makeOpp({ id: "a", title: "Managed IT Services", state: "CA" });
    const b = makeOpp({ id: "b", title: "Penetration Testing Services", state: "CA" });
    const { deduped } = crossSourceDedup([a, b]);
    expect(deduped).toHaveLength(2);
  });

  it("prefers a specific agency over a bare state-name agency on a tie", () => {
    const specific = makeOpp({ id: "specific", agency: "Philadelphia Gas Works", state: "PA" });
    const bare = makeOpp({ id: "bare", agency: "Pennsylvania", state: "PA" });
    const { deduped } = crossSourceDedup([bare, specific]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].agency).toBe("Philadelphia Gas Works");
  });

  it("normalizeTitle strips RFP prefixes and punctuation", () => {
    expect(normalizeTitle("RFP - OpenText Support Services")).toBe(
      "opentext support services",
    );
  });
});
