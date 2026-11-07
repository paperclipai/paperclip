import { describe, expect, it } from "vitest";
import {
  ADAPTER_SESSION_MANAGEMENT,
  hasSessionCompactionThresholds,
  readSessionCompactionOverride,
  resolveSessionCompactionPolicy,
} from "./session-compaction.js";

describe("session compaction policy", () => {
  it("rotates OpenCode on effective context instead of cumulative raw input", () => {
    const resolved = resolveSessionCompactionPolicy("opencode_local", {});
    expect(resolved.source).toBe("adapter_default");
    expect(resolved.policy).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 0,
      maxContextTokens: 200_000,
      maxSessionAgeHours: 72,
    });
    expect(hasSessionCompactionThresholds(resolved.policy)).toBe(true);
  });

  it("keeps the legacy cumulative policy for other adapters", () => {
    expect(resolveSessionCompactionPolicy("gemini_local", {}).policy).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxContextTokens: 0,
      maxSessionAgeHours: 72,
    });
    expect(ADAPTER_SESSION_MANAGEMENT.claude_local?.defaultSessionCompaction).toEqual(
      expect.objectContaining({ maxSessionRuns: 0, maxRawInputTokens: 0, maxContextTokens: 0, maxSessionAgeHours: 0 }),
    );
  });

  it("reads maxContextTokens overrides with the other thresholds", () => {
    const override = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxContextTokens: 50_000, maxRawInputTokens: 1_000_000 } },
    });
    expect(override).toEqual({ maxContextTokens: 50_000, maxRawInputTokens: 1_000_000 });
    const resolved = resolveSessionCompactionPolicy("opencode_local", {
      heartbeat: { sessionCompaction: { maxContextTokens: 50_000 } },
    });
    expect(resolved.source).toBe("agent_override");
    expect(resolved.policy.maxContextTokens).toBe(50_000);
    expect(resolved.policy.maxRawInputTokens).toBe(0);
  });

  it("treats a zero context threshold as disabled without disabling the policy", () => {
    const resolved = resolveSessionCompactionPolicy("opencode_local", {
      heartbeat: { sessionCompaction: { maxContextTokens: 0 } },
    });
    expect(resolved.policy.enabled).toBe(true);
    expect(resolved.policy.maxContextTokens).toBe(0);
    expect(hasSessionCompactionThresholds(resolved.policy)).toBe(true);
  });
});
