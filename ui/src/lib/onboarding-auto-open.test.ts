import { beforeEach, describe, expect, it } from "vitest";
import { claimOnboardingOffer, resetOnboardingOffers } from "./onboarding-auto-open";

describe("claimOnboardingOffer", () => {
  beforeEach(resetOnboardingOffers);

  it("lets the first offer through", () => {
    expect(claimOnboardingOffer("company-1")).toBe(true);
  });

  it("refuses a second offer for the same company", () => {
    // The dashboard effect re-runs whenever a query behind it refetches, and
    // again on every return to the page. Neither may reopen a wizard the
    // customer closed.
    claimOnboardingOffer("company-1");
    expect(claimOnboardingOffer("company-1")).toBe(false);
  });

  it("offers each company once, in any order", () => {
    // A single stored company id fails here: declining for A, visiting B, then
    // returning to A would offer A again.
    expect(claimOnboardingOffer("company-a")).toBe(true);
    expect(claimOnboardingOffer("company-b")).toBe(true);
    expect(claimOnboardingOffer("company-a")).toBe(false);
    expect(claimOnboardingOffer("company-b")).toBe(false);
  });
});
