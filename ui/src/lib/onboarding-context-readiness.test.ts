import { describe, expect, it } from "vitest";
import type { HealthStatus } from "../api/health";
import {
  getOnboardingContextReadinessCopy,
  resolveOnboardingContextReadiness,
} from "./onboarding-context-readiness";

const readyHealth: HealthStatus = {
  status: "ok",
  features: {
    companyDeletionEnabled: true,
    onboardingStarterContextDocuments: true,
  },
};

describe("onboarding context readiness", () => {
  it("reports extra context ready when the server exposes starter context documents", () => {
    expect(resolveOnboardingContextReadiness({ health: readyHealth, isLoading: false })).toEqual({
      status: "ready",
      label: "Extra context: ready",
      description: "Selected starter details will be attached invisibly for future agents.",
    });
  });

  it("reports optional fallback while the live check is loading", () => {
    expect(resolveOnboardingContextReadiness({ health: undefined, isLoading: true }).status).toBe("checking");
    expect(getOnboardingContextReadinessCopy({ health: undefined, isLoading: true })).toContain("Checking");
  });

  it("degrades gracefully when health is unavailable or the feature flag is absent", () => {
    expect(resolveOnboardingContextReadiness({ health: undefined, isLoading: false, isError: true })).toMatchObject({
      status: "optional",
      label: "Extra context: optional",
    });
    expect(
      resolveOnboardingContextReadiness({
        health: { status: "ok", features: { companyDeletionEnabled: true } },
        isLoading: false,
      }),
    ).toMatchObject({
      status: "optional",
      label: "Extra context: optional",
    });
  });
});
