import { describe, expect, it } from "vitest";
import { applyBillingModeOverride } from "@paperclipai/adapter-utils/server-utils";

describe("applyBillingModeOverride", () => {
  it("returns auto-detected value when billingMode is 'auto'", () => {
    expect(applyBillingModeOverride("api", "auto")).toBe("api");
    expect(applyBillingModeOverride("subscription", "auto")).toBe("subscription");
  });

  it("returns auto-detected value when billingMode is empty", () => {
    expect(applyBillingModeOverride("api", "")).toBe("api");
    expect(applyBillingModeOverride("subscription", "")).toBe("subscription");
  });

  it("overrides to subscription when billingMode is 'subscription'", () => {
    expect(applyBillingModeOverride("api", "subscription")).toBe("subscription");
    expect(applyBillingModeOverride("subscription", "subscription")).toBe("subscription");
  });

  it("overrides to api when billingMode is 'metered'", () => {
    expect(applyBillingModeOverride("subscription", "metered")).toBe("api");
    expect(applyBillingModeOverride("api", "metered")).toBe("api");
  });

  it("overrides to api when billingMode is 'api'", () => {
    expect(applyBillingModeOverride("subscription", "api")).toBe("api");
  });

  it("normalizes whitespace and casing", () => {
    expect(applyBillingModeOverride("api", " Subscription ")).toBe("subscription");
    expect(applyBillingModeOverride("subscription", " METERED ")).toBe("api");
    expect(applyBillingModeOverride("api", "  AUTO  ")).toBe("api");
  });

  it("falls through for unrecognized values", () => {
    expect(applyBillingModeOverride("api", "something_else")).toBe("api");
    expect(applyBillingModeOverride("subscription", "credits")).toBe("subscription");
  });
});

describe("pi/opencode billing mode pattern (unknown-default adapters)", () => {
  // Mirrors the inline pattern used in pi-local and opencode-local where
  // the default billing type is "unknown" (no auto-detection available).
  function resolveUnknownDefault(billingMode: string): string {
    const mode = billingMode.trim().toLowerCase();
    return mode === "auto" || mode === "" ? "unknown" : applyBillingModeOverride("api", mode);
  }

  it("returns 'unknown' when billingMode is 'auto' (default)", () => {
    expect(resolveUnknownDefault("auto")).toBe("unknown");
  });

  it("returns 'unknown' when billingMode is empty", () => {
    expect(resolveUnknownDefault("")).toBe("unknown");
  });

  it("returns 'subscription' when billingMode is 'subscription'", () => {
    expect(resolveUnknownDefault("subscription")).toBe("subscription");
  });

  it("returns 'api' when billingMode is 'metered'", () => {
    expect(resolveUnknownDefault("metered")).toBe("api");
  });

  it("returns 'api' when billingMode is 'api'", () => {
    expect(resolveUnknownDefault("api")).toBe("api");
  });
});
