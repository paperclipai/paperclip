import { describe, expect, it } from "vitest";
import {
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
} from "./session-compaction.js";

describe("session compaction policy", () => {
  it("enables Claude idle rotation at one hour and one hundred thousand context tokens", () => {
    expect(resolveSessionCompactionPolicy("claude_local", {}).policy).toMatchObject({
      idleTtlMinutes: 60,
      idleMinContextTokens: 100_000,
    });
  });

  it("keeps idle rotation disabled for adapters without native context reporting defaults", () => {
    expect(resolveSessionCompactionPolicy("codex_local", {}).policy).toMatchObject({
      idleTtlMinutes: 0,
      idleMinContextTokens: 0,
    });
  });

  it("parses idle policy overrides and includes them in threshold detection", () => {
    const policy = resolveSessionCompactionPolicy("codex_local", {
      heartbeat: { sessionCompaction: { idleTtlMinutes: "15", idleMinContextTokens: 42_000 } },
    }).policy;

    expect(policy).toMatchObject({ idleTtlMinutes: 15, idleMinContextTokens: 42_000 });
    expect(hasSessionCompactionThresholds(policy)).toBe(true);
  });

  it("disables idle rotation when either configured idle threshold is zero", () => {
    expect(hasSessionCompactionThresholds({
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
      idleTtlMinutes: 60,
      idleMinContextTokens: 0,
    })).toBe(false);
  });
});
