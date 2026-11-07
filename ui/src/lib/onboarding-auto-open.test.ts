import { beforeEach, describe, expect, it } from "vitest";
import { claimOnboardingOffer, dashboardOnboardingOptions, resetOnboardingOffers } from "./onboarding-auto-open";

describe("dashboard onboarding recovery", () => {
  const setup = { id: "setup-1", companyId: "company-1", pauseReason: "setup" as const, status: "paused" as const };
  const draft = JSON.stringify({ createdCompanyId: "company-1", setupAgentId: "setup-1", step: 4 });

  it("resumes the saved setup after a reload", () => {
    expect(dashboardOnboardingOptions("company-1", [setup], draft)).toEqual({ companyId: "company-1", initialStep: 4 });
  });

  it("waits for agents and starts an empty company at the agent step", () => {
    expect(dashboardOnboardingOptions("company-1", undefined, draft)).toBeNull();
    expect(dashboardOnboardingOptions("company-1", [], null)).toEqual({ companyId: "company-1", initialStep: 3 });
  });

  it("keeps the dashboard after the agent is hired or another agent exists", () => {
    expect(dashboardOnboardingOptions("company-1", [{ ...setup, pauseReason: null, status: "idle" }], draft)).toBeNull();
    expect(dashboardOnboardingOptions("company-1", [setup, { ...setup, id: "ready", pauseReason: null, status: "idle" }], draft)).toBeNull();
    expect(dashboardOnboardingOptions("company-1", [setup], JSON.stringify({ createdCompanyId: "company-1", setupAgentId: "setup-1", createdAgentId: "setup-1" }))).toBeNull();
  });

  it("does not adopt missing, malformed, foreign or terminated drafts", () => {
    for (const raw of [null, "{", "null", "[]", JSON.stringify({ createdCompanyId: "company-other", setupAgentId: "setup-1" }), JSON.stringify({ createdCompanyId: "company-1", setupAgentId: "other" })]) {
      expect(dashboardOnboardingOptions("company-1", [setup], raw)).toBeNull();
    }
    expect(dashboardOnboardingOptions("company-other", [setup], draft)).toBeNull();
    expect(dashboardOnboardingOptions("company-1", [{ ...setup, status: "terminated" }], draft)).toBeNull();
  });
});

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
