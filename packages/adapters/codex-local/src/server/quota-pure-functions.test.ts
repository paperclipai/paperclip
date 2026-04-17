import { describe, it, expect } from "vitest";
import { secondsToWindowLabel, mapCodexRpcQuota } from "./quota.js";

// ============================================================================
// secondsToWindowLabel
// ============================================================================

describe("secondsToWindowLabel", () => {
  it("returns fallback for null", () => {
    expect(secondsToWindowLabel(null, "unknown")).toBe("unknown");
  });

  it("returns fallback for undefined", () => {
    expect(secondsToWindowLabel(undefined, "N/A")).toBe("N/A");
  });

  it("uses the provided fallback string verbatim", () => {
    expect(secondsToWindowLabel(null, "custom-fallback")).toBe("custom-fallback");
  });

  it("returns '5h' for 0 seconds", () => {
    expect(secondsToWindowLabel(0, "fallback")).toBe("5h");
  });

  it("returns '5h' for 3600 seconds (1 hour)", () => {
    expect(secondsToWindowLabel(3600, "fallback")).toBe("5h");
  });

  it("returns '5h' for 18000 seconds (5 hours — just below 6h threshold)", () => {
    expect(secondsToWindowLabel(18000, "fallback")).toBe("5h");
  });

  it("returns '5h' for 21599 seconds (just under 6 hours)", () => {
    expect(secondsToWindowLabel(21599, "fallback")).toBe("5h");
  });

  it("returns '24h' for exactly 6 hours (21600 seconds)", () => {
    expect(secondsToWindowLabel(21600, "fallback")).toBe("24h");
  });

  it("returns '24h' for 43200 seconds (12 hours)", () => {
    expect(secondsToWindowLabel(43200, "fallback")).toBe("24h");
  });

  it("returns '24h' for exactly 24 hours (86400 seconds)", () => {
    expect(secondsToWindowLabel(86400, "fallback")).toBe("24h");
  });

  it("returns '7d' for 86401 seconds (just over 24 hours)", () => {
    expect(secondsToWindowLabel(86401, "fallback")).toBe("7d");
  });

  it("returns '7d' for 3 days (259200 seconds)", () => {
    expect(secondsToWindowLabel(259200, "fallback")).toBe("7d");
  });

  it("returns '7d' for exactly 168 hours (604800 seconds)", () => {
    expect(secondsToWindowLabel(604800, "fallback")).toBe("7d");
  });

  it("returns 'Xd' for more than 168 hours", () => {
    // 10 days = 864000 seconds → Math.round(240/24) = 10
    expect(secondsToWindowLabel(864000, "fallback")).toBe("10d");
  });

  it("returns '30d' for 30 days", () => {
    expect(secondsToWindowLabel(30 * 24 * 3600, "fallback")).toBe("30d");
  });

  it("returns '8d' for 8 days", () => {
    expect(secondsToWindowLabel(8 * 24 * 3600, "fallback")).toBe("8d");
  });
});

// ============================================================================
// mapCodexRpcQuota
// ============================================================================

describe("mapCodexRpcQuota", () => {
  it("returns empty windows and nulls for empty result", () => {
    const result = mapCodexRpcQuota({});
    expect(result).toEqual({ windows: [], email: null, planType: null });
  });

  it("returns empty windows when rateLimits has no primary or secondary", () => {
    const result = mapCodexRpcQuota({ rateLimits: {} });
    expect(result.windows).toEqual([]);
  });

  it("includes a '5h limit' window when rateLimits has a primary window", () => {
    const result = mapCodexRpcQuota({
      rateLimits: { primary: { usedPercent: 50, resetsAt: null } },
    });
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.label).toBe("5h limit");
    expect(result.windows[0]?.usedPercent).toBe(50);
  });

  it("includes a 'Weekly limit' window when rateLimits has a secondary window", () => {
    const result = mapCodexRpcQuota({
      rateLimits: { secondary: { usedPercent: 25, resetsAt: null } },
    });
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.label).toBe("Weekly limit");
    expect(result.windows[0]?.usedPercent).toBe(25);
  });

  it("includes both primary and secondary windows in order", () => {
    const result = mapCodexRpcQuota({
      rateLimits: {
        primary: { usedPercent: 50, resetsAt: null },
        secondary: { usedPercent: 25, resetsAt: null },
      },
    });
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]?.label).toBe("5h limit");
    expect(result.windows[1]?.label).toBe("Weekly limit");
  });

  it("normalizes a fractional usedPercent (< 1) by multiplying by 100", () => {
    const result = mapCodexRpcQuota({
      rateLimits: { primary: { usedPercent: 0.75, resetsAt: null } },
    });
    expect(result.windows[0]?.usedPercent).toBe(75);
  });

  it("caps usedPercent at 100", () => {
    const result = mapCodexRpcQuota({
      rateLimits: { primary: { usedPercent: 150, resetsAt: null } },
    });
    expect(result.windows[0]?.usedPercent).toBe(100);
  });

  it("converts unix timestamp resetsAt to ISO string", () => {
    const unixTs = 1700000000;
    const result = mapCodexRpcQuota({
      rateLimits: { primary: { usedPercent: 50, resetsAt: unixTs } },
    });
    expect(result.windows[0]?.resetsAt).toBe(new Date(unixTs * 1000).toISOString());
  });

  it("leaves resetsAt as null when not set", () => {
    const result = mapCodexRpcQuota({
      rateLimits: { primary: { usedPercent: 50, resetsAt: null } },
    });
    expect(result.windows[0]?.resetsAt).toBeNull();
  });

  it("includes a Credits window when credits are present and not unlimited", () => {
    const result = mapCodexRpcQuota({
      rateLimits: { credits: { balance: 1000, unlimited: false } },
    });
    const creditsWindow = result.windows.find((w) => w.label === "Credits");
    expect(creditsWindow).toBeDefined();
    expect(creditsWindow?.valueLabel).toBe("$1000.00 remaining");
  });

  it("omits Credits window when unlimited is true", () => {
    const result = mapCodexRpcQuota({
      rateLimits: { credits: { balance: 1000, unlimited: true } },
    });
    expect(result.windows.find((w) => w.label === "Credits")).toBeUndefined();
  });

  it("shows 'N/A' for credits valueLabel when balance is null", () => {
    const result = mapCodexRpcQuota({
      rateLimits: { credits: { balance: null, unlimited: false } },
    });
    const creditsWindow = result.windows.find((w) => w.label === "Credits");
    expect(creditsWindow?.valueLabel).toBe("N/A");
  });

  it("formats string balance as dollar amount when parseable", () => {
    const result = mapCodexRpcQuota({
      rateLimits: { credits: { balance: "500", unlimited: false } },
    });
    const creditsWindow = result.windows.find((w) => w.label === "Credits");
    expect(creditsWindow?.valueLabel).toBe("$500.00 remaining");
  });

  it("extracts email from account", () => {
    const result = mapCodexRpcQuota({}, {
      account: { email: "user@example.com", type: "paid", planType: null },
    });
    expect(result.email).toBe("user@example.com");
  });

  it("trims whitespace from account email", () => {
    const result = mapCodexRpcQuota({}, {
      account: { email: "  user@example.com  ", type: "paid", planType: null },
    });
    expect(result.email).toBe("user@example.com");
  });

  it("returns null email when account email is absent", () => {
    const result = mapCodexRpcQuota({}, { account: { planType: null } });
    expect(result.email).toBeNull();
  });

  it("returns null email when account is null", () => {
    const result = mapCodexRpcQuota({}, null);
    expect(result.email).toBeNull();
  });

  it("extracts planType from account", () => {
    const result = mapCodexRpcQuota({}, {
      account: { planType: "plus", email: null },
    });
    expect(result.planType).toBe("plus");
  });

  it("falls back to planType from rateLimits when account has no planType", () => {
    const result = mapCodexRpcQuota(
      { rateLimits: { planType: "pro" } },
      { account: null },
    );
    expect(result.planType).toBe("pro");
  });

  it("returns null planType when neither account nor rateLimits has it", () => {
    const result = mapCodexRpcQuota({});
    expect(result.planType).toBeNull();
  });

  it("uses rateLimitsByLimitId for non-codex limits with prefixed labels", () => {
    const result = mapCodexRpcQuota({
      rateLimitsByLimitId: {
        custom: {
          limitName: "Custom Limit",
          primary: { usedPercent: 10, resetsAt: null },
        },
      },
    });
    const customPrimary = result.windows.find((w) => w.label === "Custom Limit · 5h limit");
    expect(customPrimary).toBeDefined();
    expect(customPrimary?.usedPercent).toBe(10);
  });

  it("uses limitId as prefix when limitName is absent for rateLimitsByLimitId entries", () => {
    const result = mapCodexRpcQuota({
      rateLimitsByLimitId: {
        mykey: {
          primary: { usedPercent: 5, resetsAt: null },
        },
      },
    });
    const window = result.windows.find((w) => w.label === "mykey · 5h limit");
    expect(window).toBeDefined();
  });

  it("codex limit from rateLimitsByLimitId uses no prefix", () => {
    const result = mapCodexRpcQuota({
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 60, resetsAt: null },
        },
      },
    });
    const window = result.windows.find((w) => w.label === "5h limit");
    expect(window).toBeDefined();
    expect(window?.usedPercent).toBe(60);
  });

  it("prefers rateLimits when no rateLimitsByLimitId entry matches codex", () => {
    const result = mapCodexRpcQuota({
      rateLimits: {
        primary: { usedPercent: 80, resetsAt: null },
      },
      rateLimitsByLimitId: {
        other: { primary: { usedPercent: 20, resetsAt: null } },
      },
    });
    const codexPrimary = result.windows.find((w) => w.label === "5h limit");
    expect(codexPrimary?.usedPercent).toBe(80);
  });
});
