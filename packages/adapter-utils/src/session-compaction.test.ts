import { describe, expect, it } from "vitest";
import {
  getAdapterSessionManagement,
  readSessionCompactionOverride,
  resolveSessionCompactionPolicy,
  hasSessionCompactionThresholds,
  LEGACY_SESSIONED_ADAPTER_TYPES,
} from "./session-compaction.js";

// ============================================================================
// getAdapterSessionManagement
// ============================================================================

describe("getAdapterSessionManagement", () => {
  it("returns management for a known adapter type", () => {
    const result = getAdapterSessionManagement("claude_local");
    expect(result).not.toBeNull();
    expect(result?.supportsSessionResume).toBe(true);
  });

  it("returns null for unknown adapter type", () => {
    expect(getAdapterSessionManagement("unknown_adapter")).toBeNull();
  });

  it("returns null for null", () => {
    expect(getAdapterSessionManagement(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(getAdapterSessionManagement(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(getAdapterSessionManagement("")).toBeNull();
  });

  it("claude_local has confirmed native context management", () => {
    const result = getAdapterSessionManagement("claude_local");
    expect(result?.nativeContextManagement).toBe("confirmed");
  });

  it("gemini_local has unknown native context management", () => {
    const result = getAdapterSessionManagement("gemini_local");
    expect(result?.nativeContextManagement).toBe("unknown");
  });
});

// ============================================================================
// readSessionCompactionOverride
// ============================================================================

describe("readSessionCompactionOverride", () => {
  it("returns empty object for null config", () => {
    expect(readSessionCompactionOverride(null)).toEqual({});
  });

  it("returns empty object for empty object", () => {
    expect(readSessionCompactionOverride({})).toEqual({});
  });

  it("reads enabled from heartbeat.sessionCompaction", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { enabled: true } },
    });
    expect(result.enabled).toBe(true);
  });

  it("reads enabled=false as boolean false", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { enabled: false } },
    });
    expect(result.enabled).toBe(false);
  });

  it("reads maxSessionRuns as number", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxSessionRuns: 50 } },
    });
    expect(result.maxSessionRuns).toBe(50);
  });

  it("reads maxRawInputTokens as number", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxRawInputTokens: 1000000 } },
    });
    expect(result.maxRawInputTokens).toBe(1000000);
  });

  it("reads maxSessionAgeHours as number", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxSessionAgeHours: 48 } },
    });
    expect(result.maxSessionAgeHours).toBe(48);
  });

  it("reads string numbers as integers", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxSessionRuns: "100" } },
    });
    expect(result.maxSessionRuns).toBe(100);
  });

  it("falls back to heartbeat.sessionRotation when sessionCompaction not set", () => {
    const result = readSessionCompactionOverride({
      heartbeat: { sessionRotation: { maxSessionRuns: 25 } },
    });
    expect(result.maxSessionRuns).toBe(25);
  });

  it("falls back to root sessionCompaction", () => {
    const result = readSessionCompactionOverride({
      sessionCompaction: { maxSessionAgeHours: 24 },
    });
    expect(result.maxSessionAgeHours).toBe(24);
  });
});

// ============================================================================
// resolveSessionCompactionPolicy
// ============================================================================

describe("resolveSessionCompactionPolicy", () => {
  it("uses adapter_default source for known adapter with no override", () => {
    const result = resolveSessionCompactionPolicy("claude_local", null);
    expect(result.source).toBe("adapter_default");
  });

  it("uses agent_override source when override is present", () => {
    const result = resolveSessionCompactionPolicy("claude_local", {
      heartbeat: { sessionCompaction: { enabled: false } },
    });
    expect(result.source).toBe("agent_override");
    expect(result.policy.enabled).toBe(false);
  });

  it("uses legacy_fallback source for unknown adapter", () => {
    const result = resolveSessionCompactionPolicy("unknown_adapter", null);
    expect(result.source).toBe("legacy_fallback");
  });

  it("enables policy for legacy sessioned adapters", () => {
    const result = resolveSessionCompactionPolicy("gemini_local", null);
    expect(result.policy.enabled).toBe(true);
  });

  it("disables policy for non-legacy adapters when no override", () => {
    const result = resolveSessionCompactionPolicy("unknown_adapter", null);
    expect(result.policy.enabled).toBe(false);
  });

  it("explicit override merges on top of adapter defaults", () => {
    const result = resolveSessionCompactionPolicy("gemini_local", {
      heartbeat: { sessionCompaction: { maxSessionRuns: 10 } },
    });
    expect(result.policy.maxSessionRuns).toBe(10);
    // Other fields come from adapter default
    expect(result.policy.enabled).toBe(true);
  });

  it("LEGACY_SESSIONED_ADAPTER_TYPES contains gemini_local", () => {
    expect(LEGACY_SESSIONED_ADAPTER_TYPES.has("gemini_local")).toBe(true);
  });
});

// ============================================================================
// hasSessionCompactionThresholds
// ============================================================================

describe("hasSessionCompactionThresholds", () => {
  it("returns true when maxSessionRuns > 0", () => {
    expect(hasSessionCompactionThresholds({ maxSessionRuns: 1, maxRawInputTokens: 0, maxSessionAgeHours: 0 })).toBe(true);
  });

  it("returns true when maxRawInputTokens > 0", () => {
    expect(hasSessionCompactionThresholds({ maxSessionRuns: 0, maxRawInputTokens: 1, maxSessionAgeHours: 0 })).toBe(true);
  });

  it("returns true when maxSessionAgeHours > 0", () => {
    expect(hasSessionCompactionThresholds({ maxSessionRuns: 0, maxRawInputTokens: 0, maxSessionAgeHours: 1 })).toBe(true);
  });

  it("returns false when all thresholds are 0 (adapter-managed)", () => {
    expect(hasSessionCompactionThresholds({ maxSessionRuns: 0, maxRawInputTokens: 0, maxSessionAgeHours: 0 })).toBe(false);
  });
});
