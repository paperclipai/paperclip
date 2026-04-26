import { describe, expect, it } from "vitest";
import {
  formatCents,
  formatTokens,
  providerDisplayName,
  billingTypeDisplayName,
  financeDirectionDisplayName,
  visibleRunCostUsd,
  issueUrl,
  agentRouteRef,
  agentUrl,
  projectUrl,
} from "./utils.js";

// ============================================================================
// formatCents
// ============================================================================

describe("formatCents", () => {
  it("formats zero cents as $0.00", () => {
    expect(formatCents(0)).toBe("$0.00");
  });

  it("formats 100 cents as $1.00", () => {
    expect(formatCents(100)).toBe("$1.00");
  });

  it("formats 99 cents as $0.99", () => {
    expect(formatCents(99)).toBe("$0.99");
  });

  it("formats large amounts correctly", () => {
    expect(formatCents(10000)).toBe("$100.00");
  });

  it("rounds fractional cents to 2 decimal places", () => {
    expect(formatCents(1)).toBe("$0.01");
  });
});

// ============================================================================
// formatTokens
// ============================================================================

describe("formatTokens", () => {
  it("returns raw number for values below 1000", () => {
    expect(formatTokens(500)).toBe("500");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
  });

  it("formats 1500 as 1.5k", () => {
    expect(formatTokens(1500)).toBe("1.5k");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
  });

  it("formats 2.5M correctly", () => {
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });

  it("formats 0 as '0'", () => {
    expect(formatTokens(0)).toBe("0");
  });
});

// ============================================================================
// providerDisplayName
// ============================================================================

describe("providerDisplayName", () => {
  it("maps 'anthropic' to 'Anthropic'", () => {
    expect(providerDisplayName("anthropic")).toBe("Anthropic");
  });

  it("maps 'openai' to 'OpenAI'", () => {
    expect(providerDisplayName("openai")).toBe("OpenAI");
  });

  it("maps 'google' to 'Google'", () => {
    expect(providerDisplayName("google")).toBe("Google");
  });

  it("maps 'aws_bedrock' to 'AWS Bedrock'", () => {
    expect(providerDisplayName("aws_bedrock")).toBe("AWS Bedrock");
  });

  it("is case-insensitive", () => {
    expect(providerDisplayName("ANTHROPIC")).toBe("Anthropic");
    expect(providerDisplayName("OpenAI")).toBe("OpenAI");
  });

  it("returns the original string for unknown providers", () => {
    expect(providerDisplayName("my-custom-provider")).toBe("my-custom-provider");
  });
});

// ============================================================================
// billingTypeDisplayName
// ============================================================================

describe("billingTypeDisplayName", () => {
  it("maps 'metered_api' to 'Metered API'", () => {
    expect(billingTypeDisplayName("metered_api")).toBe("Metered API");
  });

  it("maps 'subscription_included' to 'Subscription'", () => {
    expect(billingTypeDisplayName("subscription_included")).toBe("Subscription");
  });

  it("maps 'credits' to 'Credits'", () => {
    expect(billingTypeDisplayName("credits")).toBe("Credits");
  });

  it("maps 'unknown' to 'Unknown'", () => {
    expect(billingTypeDisplayName("unknown")).toBe("Unknown");
  });
});

// ============================================================================
// financeDirectionDisplayName
// ============================================================================

describe("financeDirectionDisplayName", () => {
  it("maps 'credit' to 'Credit'", () => {
    expect(financeDirectionDisplayName("credit")).toBe("Credit");
  });

  it("maps 'debit' to 'Debit'", () => {
    expect(financeDirectionDisplayName("debit")).toBe("Debit");
  });
});

// ============================================================================
// visibleRunCostUsd
// ============================================================================

describe("visibleRunCostUsd", () => {
  it("returns 0 for subscription_included billing type", () => {
    expect(visibleRunCostUsd({ billingType: "subscription_included", costUsd: 1.5 })).toBe(0);
  });

  it("returns costUsd from usage when billing type is metered_api", () => {
    expect(visibleRunCostUsd({ billingType: "metered_api", costUsd: 0.05 })).toBe(0.05);
  });

  it("reads cost_usd field as fallback", () => {
    expect(visibleRunCostUsd({ billingType: "metered_api", cost_usd: 0.03 })).toBe(0.03);
  });

  it("returns 0 for null usage", () => {
    expect(visibleRunCostUsd(null)).toBe(0);
  });

  it("uses result billing type when usage has none", () => {
    expect(
      visibleRunCostUsd(
        { costUsd: 0.1 },
        { billingType: "subscription_included" },
      ),
    ).toBe(0);
  });

  it("falls through to result costUsd when usage has no cost", () => {
    expect(
      visibleRunCostUsd(
        { billingType: "metered_api" },
        { costUsd: 0.07 },
      ),
    ).toBe(0.07);
  });
});

// ============================================================================
// issueUrl
// ============================================================================

describe("issueUrl", () => {
  it("uses identifier when present", () => {
    expect(issueUrl({ id: "uuid-1", identifier: "PAP-42" })).toBe("/issues/PAP-42");
  });

  it("falls back to id when identifier is null", () => {
    expect(issueUrl({ id: "uuid-1", identifier: null })).toBe("/issues/uuid-1");
  });

  it("falls back to id when identifier is undefined", () => {
    expect(issueUrl({ id: "uuid-2" })).toBe("/issues/uuid-2");
  });
});

// ============================================================================
// agentRouteRef / agentUrl
// ============================================================================

describe("agentRouteRef", () => {
  it("uses urlKey when present", () => {
    expect(agentRouteRef({ id: "abc", urlKey: "my-agent", name: "My Agent" })).toBe("my-agent");
  });

  it("derives key from name when urlKey is null", () => {
    const ref = agentRouteRef({ id: "abc-123", urlKey: null, name: "Dev Agent" });
    expect(typeof ref).toBe("string");
    expect(ref.length).toBeGreaterThan(0);
  });
});

describe("agentUrl", () => {
  it("returns /agents/<urlKey> when urlKey present", () => {
    expect(agentUrl({ id: "x", urlKey: "my-key" })).toBe("/agents/my-key");
  });

  it("starts with /agents/ when urlKey is null", () => {
    const url = agentUrl({ id: "abc", urlKey: null, name: "Agent" });
    expect(url.startsWith("/agents/")).toBe(true);
  });
});

// ============================================================================
// projectUrl
// ============================================================================

describe("projectUrl", () => {
  it("returns /projects/<urlKey> when urlKey is present", () => {
    expect(projectUrl({ id: "p-1", urlKey: "my-project", name: "My Project" })).toBe(
      "/projects/my-project",
    );
  });

  it("starts with /projects/ when urlKey is null", () => {
    const url = projectUrl({ id: "p-1", urlKey: null, name: "Project" });
    expect(url.startsWith("/projects/")).toBe(true);
  });
});
