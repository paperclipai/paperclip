import { describe, expect, it } from "vitest";
import {
  isOnboardingPath,
  isOnboardingWizardActive,
  resolveRouteOnboardingOptions,
  shouldRedirectCompanylessRouteToOnboarding,
} from "./onboarding-route";

describe("isOnboardingPath", () => {
  it("matches the global onboarding route", () => {
    expect(isOnboardingPath("/onboarding")).toBe(true);
  });

  it("matches a company-prefixed onboarding route", () => {
    expect(isOnboardingPath("/pap/onboarding")).toBe(true);
  });

  it("ignores non-onboarding routes", () => {
    expect(isOnboardingPath("/pap/dashboard")).toBe(false);
  });
});

describe("resolveRouteOnboardingOptions", () => {
  it("opens company creation for the global onboarding route", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/onboarding",
        companies: [],
      }),
    ).toEqual({ initialStep: 1 });
  });

  it("opens agent creation when the prefixed company exists", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding",
        companyPrefix: "pap",
        companies: [{ id: "company-1", issuePrefix: "PAP" }],
      }),
    ).toEqual({ initialStep: 2, companyId: "company-1" });
  });

  it("falls back to company creation when the prefixed company is missing", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding",
        companyPrefix: "pap",
        companies: [],
      }),
    ).toEqual({ initialStep: 1 });
  });
});

describe("shouldRedirectCompanylessRouteToOnboarding", () => {
  it("redirects companyless entry routes into onboarding", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/",
        hasCompanies: false,
      }),
    ).toBe(true);
  });

  it("does not redirect when already on onboarding", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/onboarding",
        hasCompanies: false,
      }),
    ).toBe(false);
  });

  it("does not redirect when companies exist", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/issues",
        hasCompanies: true,
      }),
    ).toBe(false);
  });
});

describe("isOnboardingWizardActive", () => {
  it("is active on the freshly-landed onboarding route (auto-open, not dismissed)", () => {
    expect(
      isOnboardingWizardActive({ onboardingOpen: false, routeDismissed: false }),
    ).toBe(true);
  });

  it("hands off to the launcher once the wizard is dismissed and not re-opened", () => {
    expect(
      isOnboardingWizardActive({ onboardingOpen: false, routeDismissed: true }),
    ).toBe(false);
  });

  it("stays active when explicitly re-opened after a dismissal", () => {
    expect(
      isOnboardingWizardActive({ onboardingOpen: true, routeDismissed: true }),
    ).toBe(true);
  });
});
