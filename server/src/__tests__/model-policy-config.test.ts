import { describe, expect, it } from "vitest";
import {
  parseModelPolicies,
  selectCompanyModelPolicy,
} from "../services/model-policy-config.ts";

const rawJson = JSON.stringify({
  "company-a": [
    { when: { issuePriority: ["high"] }, modelProfile: "deep" },
    { when: {}, modelProfile: "cheap" },
  ],
});

describe("parseModelPolicies", () => {
  it("parses a JSON map of companyId -> rules", () => {
    const map = parseModelPolicies(rawJson);
    expect(map["company-a"]).toHaveLength(2);
    expect(map["company-a"][0].modelProfile).toBe("deep");
  });

  it("returns an empty map for undefined input", () => {
    expect(parseModelPolicies(undefined)).toEqual({});
  });

  it("returns an empty map for malformed JSON (and does not throw)", () => {
    expect(parseModelPolicies("{not json")).toEqual({});
  });
});

describe("selectCompanyModelPolicy", () => {
  it("returns the rules for a known company", () => {
    const map = parseModelPolicies(rawJson);
    expect(selectCompanyModelPolicy(map, "company-a")).toHaveLength(2);
  });

  it("returns an empty rule list for an unknown company", () => {
    const map = parseModelPolicies(rawJson);
    expect(selectCompanyModelPolicy(map, "company-z")).toEqual([]);
  });
});
