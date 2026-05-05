import { describe, expect, it } from "vitest";
import {
  deriveOnboardingIssuePrefix,
  sanitizeOnboardingIssuePrefix,
  validateOnboardingIssuePrefix,
} from "./onboarding-company-prefix";

describe("onboarding company issue prefix helpers", () => {
  it("derives the default prefix from the company name", () => {
    expect(deriveOnboardingIssuePrefix("Trading")).toBe("TRA");
    expect(deriveOnboardingIssuePrefix("TRD Trading")).toBe("TRD");
    expect(deriveOnboardingIssuePrefix("123 Open-Pursuit")).toBe("OPE");
  });

  it("normalizes typed prefixes for the onboarding field", () => {
    expect(sanitizeOnboardingIssuePrefix("trd")).toBe("TRD");
    expect(sanitizeOnboardingIssuePrefix("op3n-long")).toBe("OPNL");
  });

  it("validates prefix length and uniqueness", () => {
    expect(validateOnboardingIssuePrefix("TRD", [])).toBeNull();
    expect(validateOnboardingIssuePrefix("T", [])).toContain("2-4");
    expect(
      validateOnboardingIssuePrefix("DEV", [{ issuePrefix: "DEV" }]),
    ).toContain("already in use");
  });
});
