import { describe, expect, it } from "vitest";
import { extractProviderId, extractProviderIdWithFallback, extractModelName } from "./model-utils.js";

// ============================================================================
// extractProviderId
// ============================================================================

describe("extractProviderId", () => {
  it("extracts the provider from 'provider/model'", () => {
    expect(extractProviderId("openai/gpt-4")).toBe("openai");
  });

  it("extracts provider from 'anthropic/claude-3'", () => {
    expect(extractProviderId("anthropic/claude-3")).toBe("anthropic");
  });

  it("returns null when there is no slash", () => {
    expect(extractProviderId("gpt-4")).toBeNull();
  });

  it("returns null when provider part is empty", () => {
    expect(extractProviderId("/gpt-4")).toBeNull();
  });

  it("trims whitespace from input", () => {
    expect(extractProviderId("  openai/gpt-4  ")).toBe("openai");
  });

  it("handles nested paths by taking only the first segment", () => {
    expect(extractProviderId("openai/org/gpt-4")).toBe("openai");
  });
});

// ============================================================================
// extractProviderIdWithFallback
// ============================================================================

describe("extractProviderIdWithFallback", () => {
  it("returns the extracted provider when present", () => {
    expect(extractProviderIdWithFallback("openai/gpt-4")).toBe("openai");
  });

  it("returns default fallback 'other' when no provider", () => {
    expect(extractProviderIdWithFallback("gpt-4")).toBe("other");
  });

  it("returns custom fallback when provided", () => {
    expect(extractProviderIdWithFallback("gpt-4", "unknown")).toBe("unknown");
  });
});

// ============================================================================
// extractModelName
// ============================================================================

describe("extractModelName", () => {
  it("returns the model part after the slash", () => {
    expect(extractModelName("openai/gpt-4")).toBe("gpt-4");
  });

  it("returns the full string when there is no slash", () => {
    expect(extractModelName("gpt-4")).toBe("gpt-4");
  });

  it("handles nested paths by returning everything after first slash", () => {
    expect(extractModelName("openai/org/gpt-4")).toBe("org/gpt-4");
  });

  it("trims whitespace", () => {
    expect(extractModelName("  openai/gpt-4  ")).toBe("gpt-4");
  });

  it("handles empty provider (slash at start)", () => {
    expect(extractModelName("/gpt-4")).toBe("gpt-4");
  });
});
