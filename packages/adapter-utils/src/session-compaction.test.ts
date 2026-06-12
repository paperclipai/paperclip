import { describe, expect, it } from "vitest";
import {
  getAdapterSessionManagement,
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
} from "./session-compaction.js";

describe("ADAPTER_MANAGED_SESSION_POLICY age backstop", () => {
  it("claude_local defaultSessionCompaction has maxSessionAgeHours of 24", () => {
    const mgmt = getAdapterSessionManagement("claude_local");
    expect(mgmt?.defaultSessionCompaction.maxSessionAgeHours).toBe(24);
  });

  it("hasSessionCompactionThresholds returns true for adapter-managed policy", () => {
    const mgmt = getAdapterSessionManagement("claude_local");
    expect(hasSessionCompactionThresholds(mgmt!.defaultSessionCompaction)).toBe(true);
  });

  it("resolveSessionCompactionPolicy for claude_local yields a positive age threshold", () => {
    const resolved = resolveSessionCompactionPolicy("claude_local", null);
    expect(resolved.policy.maxSessionAgeHours).toBe(24);
    expect(hasSessionCompactionThresholds(resolved.policy)).toBe(true);
  });

  it("codex_local and hermes_local share the same backstop", () => {
    for (const adapter of ["codex_local", "hermes_local"]) {
      const mgmt = getAdapterSessionManagement(adapter);
      expect(mgmt?.defaultSessionCompaction.maxSessionAgeHours).toBe(24);
      expect(hasSessionCompactionThresholds(mgmt!.defaultSessionCompaction)).toBe(true);
    }
  });
});
