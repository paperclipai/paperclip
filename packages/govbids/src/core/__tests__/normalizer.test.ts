import { describe, it, expect } from "vitest";
import { normalizeOpportunity } from "../normalizer.js";
import type { HigherGovOpportunity } from "../types.js";

function makeRaw(overrides: Partial<HigherGovOpportunity> = {}): HigherGovOpportunity {
  return {
    opp_key: "abc123",
    version_key: "abc123",
    opp_cat: "SLED Contract Opportunity",
    title: "Managed IT Services",
    description_text: "Looking for managed IT services provider",
    ai_summary: "AI summary of the opportunity",
    source_id: "BID-001",
    source_id_version: "BID-001-0",
    captured_date: "2026-04-02",
    posted_date: "2026-04-01",
    due_date: "2026-04-30",
    agency: {
      agency_key: 123,
      agency_name: "CA Dept of Technology",
      agency_abbreviation: "CDT",
      agency_type: "SLED",
      path: "/agency/cdt-123/",
    },
    naics_code: { naics_code: "541512" },
    psc_code: { psc_code: "D302" },
    opp_type: { description: "Solicitation" },
    primary_contact_email: null,
    set_aside: { description: "MBE" },
    val_est_low: "200000",
    val_est_high: "400000",
    pop_country: "USA",
    pop_state: "CA",
    pop_city: "Sacramento",
    pop_zip: "95814",
    source_type: "sled",
    sole_source_flag: false,
    product_service: "S",
    path: "/sl/contract-opportunity/abc123/",
    source_path: null,
    document_path: null,
    ...overrides,
  };
}

describe("normalizeOpportunity", () => {
  it("extracts key fields from raw API data", () => {
    const result = normalizeOpportunity(makeRaw());

    expect(result.id).toBe("abc123");
    expect(result.title).toBe("Managed IT Services");
    expect(result.agency).toBe("CA Dept of Technology");
    expect(result.state).toBe("CA");
    expect(result.naicsCode).toBe("541512");
    expect(result.pscCode).toBe("D302");
    expect(result.estimatedValue).toBe(300000); // avg of 200k and 400k
    expect(result.type).toBe("Solicitation");
    expect(result.setAsideType).toBe("MBE");
    expect(result.sourceUrl).toContain("highergov.com");
    expect(result.dueDate).toContain("2026-04-30");
    expect(result.placeOfPerformance).toBe("Sacramento, CA");
  });

  it("uses ai_summary over description_text", () => {
    const result = normalizeOpportunity(makeRaw());
    expect(result.description).toBe("AI summary of the opportunity");
  });

  it("falls back to description_text when ai_summary is empty", () => {
    const result = normalizeOpportunity(makeRaw({ ai_summary: "" }));
    expect(result.description).toBe("Looking for managed IT services provider");
  });

  it("handles missing/null fields gracefully", () => {
    const result = normalizeOpportunity(makeRaw({
      agency: null,
      naics_code: null,
      psc_code: null,
      opp_type: null,
      set_aside: null,
      val_est_low: null,
      val_est_high: null,
      due_date: null,
      pop_state: null,
      pop_city: null,
    }));

    expect(result.agency).toBe("");
    expect(result.naicsCode).toBeNull();
    expect(result.estimatedValue).toBeNull();
    expect(result.dueDate).toBeNull();
    expect(result.type).toBeNull();
    expect(result.state).toBeNull();
  });
});
