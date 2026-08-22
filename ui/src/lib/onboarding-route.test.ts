import { describe, expect, it } from "vitest";
import {
  companyPrefixFromOnboardingPath,
  isOnboardingPath,
  isOnboardingWizardActive,
  onboardingStepForCompany,
  resolveRouteOnboardingOptions,
  shouldRedirectCompanylessRouteToOnboarding,
  shouldRouteAgentlessCompanyToOnboarding,
  ONBOARDING_AGENT_STEP,
  ONBOARDING_MISSION_STEP,
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

describe("shouldRouteAgentlessCompanyToOnboarding", () => {
  it("sends a company with no agents to onboarding", () => {
    expect(
      shouldRouteAgentlessCompanyToOnboarding({
        pathname: "/PC1/dashboard",
        agentsLoaded: true,
        agentCount: 0,
      }),
    ).toBe(true);
  });

  it("leaves a company that has agents alone", () => {
    expect(
      shouldRouteAgentlessCompanyToOnboarding({
        pathname: "/PC1/dashboard",
        agentsLoaded: true,
        agentCount: 1,
      }),
    ).toBe(false);
  });

  it("waits for the agent list before deciding", () => {
    // In flight, the list is undefined and reads exactly like an empty one.
    // Deciding here would bounce every user through onboarding on each cold
    // load — the count is zero only because nothing has arrived yet.
    expect(
      shouldRouteAgentlessCompanyToOnboarding({
        pathname: "/PC1/dashboard",
        agentsLoaded: false,
        agentCount: 0,
      }),
    ).toBe(false);
  });

  it("does not redirect onto onboarding from onboarding", () => {
    // The loop: finish the wizard without creating an agent, and a redirect
    // that ignored the current path would send you straight back in.
    for (const pathname of ["/onboarding", "/PC1/onboarding"]) {
      expect(
        shouldRouteAgentlessCompanyToOnboarding({
          pathname,
          agentsLoaded: true,
          agentCount: 0,
        }),
      ).toBe(false);
    }
  });
});

describe("resolveRouteOnboardingOptions — the agent step", () => {
  const companies = [{ id: "c1", issuePrefix: "PC1" }];

  it("opens a company that already has its mission on the agent step", () => {
    // Cloud collected the mission at signup and the seed wrote it as a
    // company-level goal. Re-asking it is the seam the seeded arc removes.
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/PC1/onboarding",
        companyPrefix: "PC1",
        companies,
        companyHasMission: true,
      }),
    ).toEqual({ initialStep: ONBOARDING_AGENT_STEP, companyId: "c1" });
  });

  it("still asks for the mission when the company has none", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/PC1/onboarding",
        companyPrefix: "PC1",
        companies,
        companyHasMission: false,
      }),
    ).toEqual({ initialStep: 2, companyId: "c1" });
  });

  it("treats an unknown mission as absent while the goal query is in flight", () => {
    // Costing the mission step is recoverable; skipping a question that was
    // never answered leaves the company without one.
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/PC1/onboarding",
        companyPrefix: "PC1",
        companies,
        companyHasMission: undefined,
      }),
    ).toEqual({ initialStep: 2, companyId: "c1" });
  });

  it("keeps sending an unmatched prefix to company creation", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/NOPE/onboarding",
        companyPrefix: "NOPE",
        companies,
        companyHasMission: true,
      }),
    ).toEqual({ initialStep: 1 });
  });
});

describe("onboardingStepForCompany", () => {
  it("skips the mission question for a company that has one", () => {
    expect(onboardingStepForCompany(true)).toBe(ONBOARDING_AGENT_STEP);
  });

  it("asks for the mission when the company has none", () => {
    expect(onboardingStepForCompany(false)).toBe(ONBOARDING_MISSION_STEP);
  });

  it("asks for the mission when the lookup has not answered", () => {
    // Both an in-flight and a failed lookup arrive here as `undefined`.
    // Costing the mission step is recoverable — the customer answers it. The
    // opposite error skips a question nobody answered and leaves the company
    // without a mission.
    expect(onboardingStepForCompany(undefined)).toBe(ONBOARDING_MISSION_STEP);
  });
});
