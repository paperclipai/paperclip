import { describe, it, expect } from "vitest";
import {
  findPriorSolicitation,
  buildAgencyIndex,
  normAgency,
  type SeenStore,
} from "../../cli/seen-set.js";
import { isQandA, isAddendumOrRepost } from "../addendum.js";
import type { ScoredOpportunity } from "../types.js";

function opp(overrides: Partial<ScoredOpportunity> = {}): ScoredOpportunity {
  return {
    id: "new-id",
    title: "Cybersecurity Risk Assessment and Penetration Testing Services",
    description: "",
    agency: "Oakland Housing Authority",
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
    placeOfPerformance: null,
    score: 62,
    scoreBreakdown: { serviceAlignment: 35, bidReadiness: 15, competitivePosition: 7, valueFit: 5 },
    serviceCategory: "cybersecurity",
    reasoning: "",
    disqualifiers: [],
    ...overrides,
  };
}

function storeWith(entries: Array<{ id: string; title: string; agency: string }>): SeenStore {
  const store: SeenStore = { entries: {}, fingerprints: {} };
  for (const e of entries) {
    store.entries[e.id] = {
      firstSeen: "2026-05-01T00:00:00Z",
      lastDueDate: null,
      lastScore: 60,
      lastTitle: e.title,
      agency: e.agency,
    };
  }
  return store;
}

describe("normAgency", () => {
  it("strips City of / County of prefixes", () => {
    expect(normAgency("City of Redwood City")).toBe("redwood city");
    expect(normAgency("Redwood City")).toBe("redwood city");
    expect(normAgency("County of Los Angeles")).toBe("los angeles");
  });
});

describe("findPriorSolicitation — US-3 repost detection", () => {
  it("catches a re-post with a NEW id but the SAME title (fingerprint)", () => {
    const store = storeWith([
      { id: "old-1", title: "Cybersecurity Risk Assessment and Penetration Testing Services", agency: "Oakland Housing Authority" },
    ]);
    const idx = buildAgencyIndex(store);
    expect(findPriorSolicitation(opp({ id: "fresh-id" }), store, idx)).not.toBeNull();
  });

  it("catches a re-post whose TITLE mutated, via agency + similarity (fuzzy)", () => {
    const store = storeWith([
      { id: "old-1", title: "RFP - Professional Services - Microsoft 365-based Intranet and Collaboration Platform (SharePoint)", agency: "City of Redwood City" },
    ]);
    const idx = buildAgencyIndex(store);
    const mutated = opp({
      id: "fresh-id",
      agency: "Redwood City",
      title: "RFP Professional services to perform implementation of a Microsoft 365-based intranet",
    });
    expect(findPriorSolicitation(mutated, store, idx)).toBe("fuzzy");
  });

  it("does NOT collapse two different RFPs from the same agency", () => {
    const store = storeWith([
      { id: "old-1", title: "Microsoft 365 SharePoint intranet implementation", agency: "City of Springfield" },
    ]);
    const idx = buildAgencyIndex(store);
    const different = opp({ id: "x", agency: "City of Springfield", title: "Snow plow fleet telematics GPS hardware" });
    expect(findPriorSolicitation(different, store, idx)).toBeNull();
  });

  it("returns null for a genuinely new solicitation", () => {
    const store = storeWith([]);
    const idx = buildAgencyIndex(store);
    expect(findPriorSolicitation(opp(), store, idx)).toBeNull();
  });
});

describe("isQandA — US-3 Q&A drop", () => {
  it("flags Q&A / clarification documents", () => {
    for (const t of [
      "RFP Questions and Answers",
      "Q&A Responses",
      "Addendum 2 - Answers to Vendor Questions",
      "Clarification of Scope",
      "Response to Bidder Questions",
    ]) {
      expect(isQandA(t), t).toBe(true);
    }
  });

  it("does not flag real solicitations", () => {
    for (const t of ["RFP - Managed IT Services", "Cybersecurity Assessment Services", "Software Implementation Services"]) {
      expect(isQandA(t), t).toBe(false);
    }
  });
});

describe("isAddendumOrRepost still works alongside Q&A", () => {
  it("flags addenda", () => {
    expect(isAddendumOrRepost("Addendum 1 - Revised Scope")).toBe(true);
    expect(isAddendumOrRepost("RFP - Managed IT Services (REBID)")).toBe(true);
  });
});
