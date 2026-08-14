import { describe, expect, it } from "vitest";
import {
  companyPrefixFromOnboardingPath,
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

describe("companyPrefixFromOnboardingPath", () => {
  it("reads the prefix from a company onboarding path", () => {
    expect(companyPrefixFromOnboardingPath("/PC7409/onboarding")).toBe("PC7409");
  });

  it("keeps the prefix as written so the caller decides how to compare it", () => {
    // resolveRouteOnboardingOptions already matches case-insensitively.
    // Normalising here as well would hide which half owns the comparison.
    expect(companyPrefixFromOnboardingPath("/pc7409/Onboarding")).toBe("pc7409");
  });

  it("has no prefix to read on the unprefixed route", () => {
    expect(companyPrefixFromOnboardingPath("/onboarding")).toBeUndefined();
  });

  it("ignores paths that only look like onboarding", () => {
    expect(companyPrefixFromOnboardingPath("/PC7409/onboarding/extra")).toBeUndefined();
    expect(companyPrefixFromOnboardingPath("/PC7409/dashboard")).toBeUndefined();
    expect(companyPrefixFromOnboardingPath("/")).toBeUndefined();
  });

  it("agrees with isOnboardingPath about what an onboarding path is", () => {
    // The two parse the same shape. If they ever disagree the wizard would
    // open on a path that resolves no company, or resolve a company on a path
    // that is not onboarding.
    for (const pathname of ["/onboarding", "/PC1/onboarding", "/PC1/dash", "/a/b/c"]) {
      const prefix = companyPrefixFromOnboardingPath(pathname);
      if (prefix !== undefined) expect(isOnboardingPath(pathname)).toBe(true);
    }
  });

  it("feeds resolveRouteOnboardingOptions the prefix useParams cannot supply", () => {
    // The regression this fixes: the wizard renders beside <Routes>, so
    // useParams() returned nothing and every company route opened at step 1.
    const companies = [{ id: "c1", issuePrefix: "PC7409" }];
    const pathname = "/PC7409/onboarding";

    expect(
      resolveRouteOnboardingOptions({ pathname, companyPrefix: undefined, companies }),
    ).toEqual({ initialStep: 1 });

    expect(
      resolveRouteOnboardingOptions({
        pathname,
        companyPrefix: companyPrefixFromOnboardingPath(pathname),
        companies,
      }),
    ).toEqual({ initialStep: 2, companyId: "c1" });
  });
});

describe("navigating away from a company's onboarding route", () => {
  const companies = [{ id: "c1", issuePrefix: "PC1" }];

  // The wizard is a persistent overlay, so it survives navigation and keeps
  // its state. Once the route can supply a companyId - which it could not
  // before companyPrefixFromOnboardingPath existed - leaving that route has to
  // withdraw it, or the wizard shows "create a company" while still holding
  // the previous one.
  it("stops supplying a company once the path no longer names one", () => {
    const onCompanyRoute = resolveRouteOnboardingOptions({
      pathname: "/PC1/onboarding",
      companyPrefix: companyPrefixFromOnboardingPath("/PC1/onboarding"),
      companies,
    });
    expect(onCompanyRoute).toEqual({ initialStep: 2, companyId: "c1" });

    const afterNavigating = resolveRouteOnboardingOptions({
      pathname: "/onboarding",
      companyPrefix: companyPrefixFromOnboardingPath("/onboarding"),
      companies,
    });
    expect(afterNavigating).toEqual({ initialStep: 1 });
    expect(afterNavigating?.companyId).toBeUndefined();
  });

  it("supplies no company for a prefix that matches nothing", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/NOPE/onboarding",
        companyPrefix: companyPrefixFromOnboardingPath("/NOPE/onboarding"),
        companies,
      }),
    ).toEqual({ initialStep: 1 });
  });
});
