/**
 * Tests for session compaction policy resolution, context guard strategies,
 * and per-run token ceiling checks.
 *
 * Covers scope #1 and #4 from KIN-617:
 * - Context guard strategy defaults (summarize, truncate, rotate)
 * - Threshold resolution for known adapter types
 * - Agent override precedence
 * - Run-level token ceiling checks
 */

import { describe, expect, it } from "vitest";
import {
  resolveSessionCompactionPolicy,
  readSessionCompactionOverride,
  hasSessionCompactionThresholds,
  checkRunTokenCeiling,
} from "@paperclipai/adapter-utils";

describe("resolveSessionCompactionPolicy", () => {
  it("returns adapter defaults for claude_local (native context management)", () => {
    const resolved = resolveSessionCompactionPolicy("claude_local", {});
    expect(resolved.source).toBe("adapter_default");
    expect(resolved.adapterSessionManagement?.nativeContextManagement).toBe("confirmed");
    // Claude manages context natively => zero thresholds.
    expect(resolved.policy.maxSessionRuns).toBe(0);
    expect(resolved.policy.maxRawInputTokens).toBe(0);
    expect(resolved.policy.maxSessionAgeHours).toBe(0);
    expect(resolved.policy.maxTokensPerRun).toBe(0);
    expect(resolved.policy.guardStrategy).toBe("summarize");
  });

  it("returns tighter defaults for opencode_local (unknown native context)", () => {
    const resolved = resolveSessionCompactionPolicy("opencode_local", {});
    expect(resolved.source).toBe("adapter_default");
    expect(resolved.adapterSessionManagement?.nativeContextManagement).toBe("unknown");
    // Should have active thresholds for unknown native management.
    expect(resolved.policy.maxSessionRuns).toBeGreaterThan(0);
    expect(resolved.policy.maxRawInputTokens).toBeGreaterThan(0);
    expect(resolved.policy.maxTokensPerRun).toBeGreaterThan(0);
    // Default guard strategy for unknown adapters.
    expect(resolved.policy.guardStrategy).toBe("summarize");
  });

  it("returns tighter defaults for cursor (unknown native context)", () => {
    const resolved = resolveSessionCompactionPolicy("cursor", {});
    expect(resolved.adapterSessionManagement?.nativeContextManagement).toBe("unknown");
    expect(resolved.policy.maxTokensPerRun).toBeGreaterThan(0);
    expect(resolved.policy.guardStrategy).toBe("summarize");
  });

  it("returns tighter defaults for gemini_local (unknown native context)", () => {
    const resolved = resolveSessionCompactionPolicy("gemini_local", {});
    expect(resolved.adapterSessionManagement?.nativeContextManagement).toBe("unknown");
    expect(resolved.policy.maxTokensPerRun).toBeGreaterThan(0);
  });

  it("returns tighter defaults for pi_local (unknown native context)", () => {
    const resolved = resolveSessionCompactionPolicy("pi_local", {});
    expect(resolved.adapterSessionManagement?.nativeContextManagement).toBe("unknown");
    expect(resolved.policy.maxTokensPerRun).toBeGreaterThan(0);
  });

  it("returns adapter defaults for hermes_local (confirmed native context)", () => {
    const resolved = resolveSessionCompactionPolicy("hermes_local", {});
    expect(resolved.source).toBe("adapter_default");
    expect(resolved.adapterSessionManagement?.nativeContextManagement).toBe("confirmed");
    expect(resolved.policy.maxSessionRuns).toBe(0);
    expect(resolved.policy.maxRawInputTokens).toBe(0);
  });

  it("preserves explicit agent overrides", () => {
    const runtimeConfig = {
      heartbeat: {
        sessionCompaction: {
          maxSessionRuns: 50,
          maxTokensPerRun: 120_000,
          guardStrategy: "truncate",
        },
      },
    };
    const resolved = resolveSessionCompactionPolicy("opencode_local", runtimeConfig);
    expect(resolved.source).toBe("agent_override");
    expect(resolved.explicitOverride.maxSessionRuns).toBe(50);
    expect(resolved.explicitOverride.maxTokensPerRun).toBe(120_000);
    expect(resolved.explicitOverride.guardStrategy).toBe("truncate");
    // Override values win.
    expect(resolved.policy.maxSessionRuns).toBe(50);
    expect(resolved.policy.maxTokensPerRun).toBe(120_000);
    expect(resolved.policy.guardStrategy).toBe("truncate");
  });

  it("preserves adapter defaults when override is empty object", () => {
    const resolved = resolveSessionCompactionPolicy("opencode_local", {});
    expect(resolved.source).toBe("adapter_default");
  });

  it("falls back to legacy_fallback for unknown adapter types", () => {
    const resolved = resolveSessionCompactionPolicy("unknown_adapter", {});
    expect(resolved.source).toBe("legacy_fallback");
    expect(resolved.adapterSessionManagement).toBeNull();
  });

  it("returns null adapterSessionManagement for null adapter", () => {
    const resolved = resolveSessionCompactionPolicy(null, {});
    expect(resolved.adapterSessionManagement).toBeNull();
    expect(resolved.source).toBe("legacy_fallback");
  });
});

describe("readSessionCompactionOverride", () => {
  it("reads all fields from runtime config", () => {
    const config = {
      heartbeat: {
        sessionCompaction: {
          enabled: false,
          maxSessionRuns: 10,
          maxRawInputTokens: 50000,
          maxSessionAgeHours: 24,
          maxTokensPerRun: 32000,
          guardStrategy: "rotate",
        },
      },
    };
    const override = readSessionCompactionOverride(config);
    expect(override.enabled).toBe(false);
    expect(override.maxSessionRuns).toBe(10);
    expect(override.maxRawInputTokens).toBe(50000);
    expect(override.maxSessionAgeHours).toBe(24);
    expect(override.maxTokensPerRun).toBe(32000);
    expect(override.guardStrategy).toBe("rotate");
  });

  it("reads from legacy sessionRotation key", () => {
    const config = {
      heartbeat: {
        sessionRotation: {
          enabled: false,
          maxSessionRuns: 5,
        },
      },
    };
    const override = readSessionCompactionOverride(config);
    expect(override.enabled).toBe(false);
    expect(override.maxSessionRuns).toBe(5);
  });

  it("returns empty object when no config present", () => {
    const override = readSessionCompactionOverride({});
    expect(Object.keys(override).length).toBe(0);
  });
});

describe("hasSessionCompactionThresholds", () => {
  it("returns true when any threshold is non-zero", () => {
    expect(
      hasSessionCompactionThresholds({
        maxSessionRuns: 50,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 0,
        maxTokensPerRun: 0,
      }),
    ).toBe(true);

    expect(
      hasSessionCompactionThresholds({
        maxSessionRuns: 0,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 0,
        maxTokensPerRun: 100_000,
      }),
    ).toBe(true);
  });

  it("returns false when all thresholds are zero", () => {
    expect(
      hasSessionCompactionThresholds({
        maxSessionRuns: 0,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 0,
        maxTokensPerRun: 0,
      }),
    ).toBe(false);
  });
});

describe("checkRunTokenCeiling", () => {
  it("returns null when maxTokensPerRun is zero", () => {
    const result = checkRunTokenCeiling(
      { maxTokensPerRun: 0, guardStrategy: "summarize" },
      500_000,
    );
    expect(result).toBeNull();
  });

  it("returns null when rawInput is under the ceiling", () => {
    const result = checkRunTokenCeiling(
      { maxTokensPerRun: 200_000, guardStrategy: "summarize" },
      150_000,
    );
    expect(result).toBeNull();
  });

  it("returns guardStrategy when rawInput exceeds ceiling", () => {
    const result = checkRunTokenCeiling(
      { maxTokensPerRun: 128_000, guardStrategy: "summarize" },
      200_000,
    );
    expect(result).toBe("summarize");
  });

  it("returns truncate when that is the configured strategy", () => {
    const result = checkRunTokenCeiling(
      { maxTokensPerRun: 128_000, guardStrategy: "truncate" },
      300_000,
    );
    expect(result).toBe("truncate");
  });
});
