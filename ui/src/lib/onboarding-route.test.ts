import { describe, expect, it } from "vitest";
import {
  isOnboardingPath,
  resolveRouteOnboardingOptions,
  shouldRedirectGlobalOnboardingToBoard,
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

describe("shouldRedirectGlobalOnboardingToBoard", () => {
  it("redirects the global onboarding route back to the board when companies exist", () => {
    expect(
      shouldRedirectGlobalOnboardingToBoard({
        pathname: "/onboarding",
        hasCompanies: true,
      }),
    ).toBe(true);
  });

  it("does not redirect company-prefixed onboarding routes", () => {
    expect(
      shouldRedirectGlobalOnboardingToBoard({
        pathname: "/pap/onboarding",
        hasCompanies: true,
      }),
    ).toBe(false);
  });

  it("does not redirect global onboarding when no companies exist", () => {
    expect(
      shouldRedirectGlobalOnboardingToBoard({
        pathname: "/onboarding",
        hasCompanies: false,
      }),
    ).toBe(false);
  });
});
