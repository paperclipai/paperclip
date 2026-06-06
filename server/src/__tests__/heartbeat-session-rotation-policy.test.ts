import { describe, expect, it } from "vitest";
import {
  decideSessionCompactionTrigger,
  type SessionCompactionTriggerInput,
} from "../services/heartbeat.ts";
import type { SessionCompactionPolicy } from "@paperclipai/adapter-utils";

const DISABLED_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 0,
  maxRawInputTokens: 0,
  maxSessionAgeHours: 0,
  maxCachedInputTokens: 0,
  rotateOnZeroOpenIssues: false,
  rotateOnNewIssueWake: false,
};

const ADR_0044_DEFAULT_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 0,
  maxRawInputTokens: 0,
  maxSessionAgeHours: 6,
  maxCachedInputTokens: 500_000,
  rotateOnZeroOpenIssues: true,
  rotateOnNewIssueWake: true,
};

function buildInput(overrides: Partial<SessionCompactionTriggerInput> = {}): SessionCompactionTriggerInput {
  return {
    policy: DISABLED_POLICY,
    runsCount: 1,
    latestRawUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    sessionAgeHours: 0,
    openIssuesCount: 1,
    wakeReason: null,
    ...overrides,
  };
}

describe("decideSessionCompactionTrigger", () => {
  it("returns null when no thresholds are crossed", () => {
    expect(decideSessionCompactionTrigger(buildInput({ policy: ADR_0044_DEFAULT_POLICY }))).toBeNull();
  });

  it("T1 triggers when cached_input >= maxCachedInputTokens", () => {
    const result = decideSessionCompactionTrigger(
      buildInput({
        policy: ADR_0044_DEFAULT_POLICY,
        latestRawUsage: { inputTokens: 0, cachedInputTokens: 600_000, outputTokens: 0 },
      }),
    );
    expect(result?.triggeredBy).toBe("t1");
    expect(result?.reason).toMatch(/cache_read reached 600,000 tokens/);
  });

  it("T2 triggers when sessionAgeHours >= maxSessionAgeHours", () => {
    const result = decideSessionCompactionTrigger(
      buildInput({
        policy: ADR_0044_DEFAULT_POLICY,
        sessionAgeHours: 7,
      }),
    );
    expect(result?.triggeredBy).toBe("t2");
    expect(result?.reason).toBe("session age reached 7 hours");
  });

  it("T3 triggers when openIssuesCount is 0 and rotateOnZeroOpenIssues is true", () => {
    const result = decideSessionCompactionTrigger(
      buildInput({
        policy: ADR_0044_DEFAULT_POLICY,
        openIssuesCount: 0,
      }),
    );
    expect(result?.triggeredBy).toBe("t3");
    expect(result?.reason).toBe("no open issues for agent");
  });

  it("T3 does NOT trigger when openIssuesCount is null (caller skipped the count)", () => {
    const result = decideSessionCompactionTrigger(
      buildInput({
        policy: ADR_0044_DEFAULT_POLICY,
        openIssuesCount: null,
      }),
    );
    expect(result).toBeNull();
  });

  it("T4 triggers when wakeReason is issue_assigned and rotateOnNewIssueWake is true", () => {
    const result = decideSessionCompactionTrigger(
      buildInput({
        policy: ADR_0044_DEFAULT_POLICY,
        wakeReason: "issue_assigned",
      }),
    );
    expect(result?.triggeredBy).toBe("t4");
    expect(result?.reason).toBe("wake triggered by new issue assignment");
  });

  it("T4 does NOT trigger for other wake reasons", () => {
    const result = decideSessionCompactionTrigger(
      buildInput({
        policy: ADR_0044_DEFAULT_POLICY,
        wakeReason: "heartbeat_timer",
      }),
    );
    expect(result).toBeNull();
  });

  it("legacy_runs triggers when runsCount > maxSessionRuns", () => {
    const policy: SessionCompactionPolicy = { ...DISABLED_POLICY, maxSessionRuns: 5 };
    const result = decideSessionCompactionTrigger(buildInput({ policy, runsCount: 6 }));
    expect(result?.triggeredBy).toBe("legacy_runs");
    expect(result?.reason).toBe("session exceeded 5 runs");
  });

  it("legacy_raw_input triggers when raw inputTokens >= maxRawInputTokens", () => {
    const policy: SessionCompactionPolicy = { ...DISABLED_POLICY, maxRawInputTokens: 1_000_000 };
    const result = decideSessionCompactionTrigger(
      buildInput({
        policy,
        latestRawUsage: { inputTokens: 1_500_000, cachedInputTokens: 0, outputTokens: 0 },
      }),
    );
    expect(result?.triggeredBy).toBe("legacy_raw_input");
    expect(result?.reason).toMatch(/raw input reached 1,500,000 tokens/);
  });

  it("priority: legacy_runs wins over T1 when both conditions hold", () => {
    const policy: SessionCompactionPolicy = {
      ...ADR_0044_DEFAULT_POLICY,
      maxSessionRuns: 5,
    };
    const result = decideSessionCompactionTrigger(
      buildInput({
        policy,
        runsCount: 6,
        latestRawUsage: { inputTokens: 0, cachedInputTokens: 800_000, outputTokens: 0 },
      }),
    );
    expect(result?.triggeredBy).toBe("legacy_runs");
  });

  it("priority: T1 wins over T2 when both conditions hold", () => {
    const result = decideSessionCompactionTrigger(
      buildInput({
        policy: ADR_0044_DEFAULT_POLICY,
        latestRawUsage: { inputTokens: 0, cachedInputTokens: 800_000, outputTokens: 0 },
        sessionAgeHours: 10,
      }),
    );
    expect(result?.triggeredBy).toBe("t1");
  });

  it("priority: T2 wins over T3 when both conditions hold", () => {
    const result = decideSessionCompactionTrigger(
      buildInput({
        policy: ADR_0044_DEFAULT_POLICY,
        sessionAgeHours: 10,
        openIssuesCount: 0,
      }),
    );
    expect(result?.triggeredBy).toBe("t2");
  });

  it("priority: T3 wins over T4 when both conditions hold", () => {
    const result = decideSessionCompactionTrigger(
      buildInput({
        policy: ADR_0044_DEFAULT_POLICY,
        openIssuesCount: 0,
        wakeReason: "issue_assigned",
      }),
    );
    expect(result?.triggeredBy).toBe("t3");
  });

  it("ignores T3 when rotateOnZeroOpenIssues is false even if count is 0", () => {
    const policy: SessionCompactionPolicy = { ...ADR_0044_DEFAULT_POLICY, rotateOnZeroOpenIssues: false };
    const result = decideSessionCompactionTrigger(buildInput({ policy, openIssuesCount: 0 }));
    expect(result).toBeNull();
  });

  it("ignores T4 when rotateOnNewIssueWake is false even if wakeReason is issue_assigned", () => {
    const policy: SessionCompactionPolicy = { ...ADR_0044_DEFAULT_POLICY, rotateOnNewIssueWake: false };
    const result = decideSessionCompactionTrigger(buildInput({ policy, wakeReason: "issue_assigned" }));
    expect(result).toBeNull();
  });

  it("ignores T1 when maxCachedInputTokens is 0 (disabled)", () => {
    const policy: SessionCompactionPolicy = { ...ADR_0044_DEFAULT_POLICY, maxCachedInputTokens: 0 };
    const result = decideSessionCompactionTrigger(
      buildInput({
        policy,
        latestRawUsage: { inputTokens: 0, cachedInputTokens: 10_000_000, outputTokens: 0 },
      }),
    );
    expect(result).toBeNull();
  });

  it("ignores T2 when maxSessionAgeHours is 0 (disabled)", () => {
    const policy: SessionCompactionPolicy = { ...ADR_0044_DEFAULT_POLICY, maxSessionAgeHours: 0 };
    const result = decideSessionCompactionTrigger(buildInput({ policy, sessionAgeHours: 100 }));
    expect(result).toBeNull();
  });
});
