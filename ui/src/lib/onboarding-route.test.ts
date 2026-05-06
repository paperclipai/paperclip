import { describe, expect, it } from "vitest";
import {
  isClassicOnboardingPath,
  isOnboardingPath,
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

  it("matches the classic onboarding suffix at the global route", () => {
    expect(isOnboardingPath("/onboarding/classic")).toBe(true);
  });

  it("matches the classic onboarding suffix at the company-prefixed route", () => {
    expect(isOnboardingPath("/pap/onboarding/classic")).toBe(true);
  });

  it("ignores non-onboarding routes", () => {
    expect(isOnboardingPath("/pap/dashboard")).toBe(false);
  });
});

describe("isClassicOnboardingPath", () => {
  it("matches the global classic onboarding route", () => {
    expect(isClassicOnboardingPath("/onboarding/classic")).toBe(true);
  });

  it("matches the company-prefixed classic onboarding route", () => {
    expect(isClassicOnboardingPath("/pap/onboarding/classic")).toBe(true);
  });

  it("does not match the bare onboarding route", () => {
    expect(isClassicOnboardingPath("/onboarding")).toBe(false);
  });

  it("does not match the company-prefixed bare onboarding route", () => {
    expect(isClassicOnboardingPath("/pap/onboarding")).toBe(false);
  });
});

describe("resolveRouteOnboardingOptions", () => {
  it("opens company creation for the global classic onboarding route", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/onboarding/classic",
        companies: [],
      }),
    ).toEqual({ initialStep: 1 });
  });

  it("opens agent creation when the classic prefixed company exists", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding/classic",
        companyPrefix: "pap",
        companies: [{ id: "company-1", issuePrefix: "PAP" }],
      }),
    ).toEqual({ initialStep: 2, companyId: "company-1" });
  });

  it("falls back to company creation when the classic prefixed company is missing", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding/classic",
        companyPrefix: "pap",
        companies: [],
      }),
    ).toEqual({ initialStep: 1 });
  });

  it("does not auto-open the wizard for the new Coach onboarding route", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/onboarding",
        companies: [],
      }),
    ).toBeNull();
  });

  it("does not auto-open the wizard for the company-prefixed Coach onboarding route", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding",
        companyPrefix: "pap",
        companies: [{ id: "company-1", issuePrefix: "PAP" }],
      }),
    ).toBeNull();
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

  it("does not redirect when already on classic onboarding", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/onboarding/classic",
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
