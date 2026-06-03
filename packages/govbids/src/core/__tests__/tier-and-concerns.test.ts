import { describe, it, expect } from "vitest";
import { tierOf } from "../../cli/output.js";
import { stripSoftDisqualifiers } from "../scorer.js";
import type { ScoredOpportunity } from "../types.js";

function makeScored(overrides: Partial<ScoredOpportunity> = {}): ScoredOpportunity {
  return {
    id: "x",
    title: "RFP - SharePoint / M365 intranet implementation",
    description: "",
    agency: "City of Redwood City",
    state: "CA",
    naicsCode: null,
    pscCode: null,
    estimatedValue: null,
    dueDate: null,
    postedDate: null,
    capturedDate: null,
    type: "Solicitation",
    setAsideType: null,
    sourceUrl: null,
    placeOfPerformance: "CA",
    score: 75,
    scoreBreakdown: { serviceAlignment: 38, bidReadiness: 18, competitivePosition: 9, valueFit: 10 },
    serviceCategory: "app-dev",
    reasoning: "",
    disqualifiers: [],
    ...overrides,
  };
}

describe("tierOf — US-5 GREEN promotion", () => {
  it("promotes a well-scoped core implementation (score>=70, sa>=35) to GREEN", () => {
    expect(tierOf(makeScored({ score: 75, scoreBreakdown: { serviceAlignment: 38, bidReadiness: 18, competitivePosition: 9, valueFit: 10 } }))).toBe("GREEN");
  });

  it("covers all core categories, not just MSP/cyber", () => {
    for (const cat of ["erp", "cloud", "ai-data", "app-dev", "managed-it", "cybersecurity"] as const) {
      expect(tierOf(makeScored({ serviceCategory: cat, score: 72 }))).toBe("GREEN");
    }
  });

  it("does NOT promote an AMBER-grade row (score<70) even with strong alignment", () => {
    expect(tierOf(makeScored({ score: 65, scoreBreakdown: { serviceAlignment: 40, bidReadiness: 12, competitivePosition: 8, valueFit: 5 } }))).toBe("AMBER");
  });

  it("does NOT promote when a real disqualifier is present", () => {
    expect(tierOf(makeScored({ score: 75, disqualifiers: ["Requires FedRAMP authorization"] }))).toBe("YELLOW");
  });

  it("does NOT promote pure website work (low alignment stays out)", () => {
    expect(tierOf(makeScored({ serviceCategory: "app-dev", score: 62, scoreBreakdown: { serviceAlignment: 12, bidReadiness: 18, competitivePosition: 9, valueFit: 5 } }))).toBe("AMBER");
  });
});

describe("stripSoftDisqualifiers — US-6 specific concerns", () => {
  it("strips bare vagueness concerns", () => {
    expect(stripSoftDisqualifiers(["unclear requirements"])).toHaveLength(0);
    expect(stripSoftDisqualifiers(["Requirements are unclear"])).toHaveLength(0);
    expect(stripSoftDisqualifiers(["vague scope"])).toHaveLength(0);
  });

  it("keeps specific, actionable gaps", () => {
    expect(stripSoftDisqualifiers(["No contract value stated"])).toHaveLength(1);
    expect(stripSoftDisqualifiers(["Scope references Exhibit A which is not included"])).toHaveLength(1);
    expect(stripSoftDisqualifiers(["Requires FedRAMP authorization ConsultAdd lacks"])).toHaveLength(1);
  });
});
