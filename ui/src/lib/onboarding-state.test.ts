import { describe, expect, it } from "vitest";
import { restoreOnboardingState } from "./onboarding-state";

const companies = [{ id: "company-new" }];

describe("restoreOnboardingState", () => {
  it("returns null for unusable input", () => {
    expect(restoreOnboardingState(null, companies)).toBeNull();
    expect(restoreOnboardingState("nonsense", companies)).toBeNull();
  });

  it("discards state whose company the user does not own", () => {
    const saved = { step: 4, companyName: "Old Co", createdCompanyId: "company-old" };
    expect(restoreOnboardingState(saved, companies)).toBeNull();
  });

  it("keeps state for a company the user does own", () => {
    const saved = { step: 4, companyName: "New Co", createdCompanyId: "company-new" };
    expect(restoreOnboardingState(saved, companies)?.companyName).toBe("New Co");
  });

  it("keeps in-progress state that has no company yet", () => {
    const saved = { step: 1, companyName: "Draft" };
    expect(restoreOnboardingState(saved, companies)?.companyName).toBe("Draft");
  });

  it("discards a company id against an empty (settled) companies list", () => {
    // Per the CONTRACT in the JSDoc, callers must only invoke this once
    // companies have settled. An empty settled list legitimately means the
    // account owns no companies, so a saved company id is discarded exactly
    // like an unowned one.
    const saved = { step: 4, createdCompanyId: "company-new" };
    expect(restoreOnboardingState(saved, [])).toBeNull();
  });
});
