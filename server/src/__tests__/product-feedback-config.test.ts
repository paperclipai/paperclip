import { afterEach, describe, expect, it, vi } from "vitest";
import { applyManagedCloudProductFeedbackFloor, loadConfig } from "../config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("product feedback configuration", () => {
  it("enables the credential-free OSS relay by default", () => {
    expect(loadConfig().productFeedback).toEqual({
      enabled: true,
      limits: {
        feedbackMaxLength: 5_000,
        diagnosticCount: 5,
      },
    });
  });

  it("allows an operator to retain the external feedback fallback", () => {
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_ENABLED", "false");
    expect(loadConfig().productFeedback.enabled).toBe(false);
  });

  it("does not expose or load PostHog settings", () => {
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_PROJECT_TOKEN", "phc_should_be_ignored");
    expect(JSON.stringify(loadConfig().productFeedback)).not.toContain("posthog");
    expect(JSON.stringify(loadConfig().productFeedback)).not.toContain("phc_should_be_ignored");
  });

  it("disables both the route capability and relay creation on managed Cloud", () => {
    const configured = loadConfig().productFeedback;
    const runtime = applyManagedCloudProductFeedbackFloor(configured, true);

    expect(configured.enabled).toBe(true);
    expect(runtime).toEqual({ ...configured, enabled: false });
    expect(applyManagedCloudProductFeedbackFloor(configured, false)).toBe(configured);
  });
});
