/**
 * Unit tests for decideSessionRotation — the pure rotation-decision extracted
 * from evaluateSessionCompaction (heartbeat.ts). Tests cover:
 *   A4:  hard stop when previous run rawInputTokens >= threshold
 *   A1a: proactive rotation when ≥70% full AND cache cold (gap > 5-min TTL)
 *   A1b: any cold session — rotate to avoid full transcript replay regardless of fill
 */

import { describe, expect, it } from "vitest";
import {
  decideSessionRotation,
  PROACTIVE_SESSION_FILL_RATIO,
  SESSION_CACHE_TTL_MS,
} from "../services/heartbeat.js";
import type { SessionCompactionPolicy } from "@paperclipai/adapter-utils";

const THRESHOLD = 400_000;

const BASE_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 0,
  maxRawInputTokens: THRESHOLD,
  maxSessionAgeHours: 0,
};

const NOW = 1_000_000_000_000; // fixed epoch, avoids Date.now() in tests
const HOT_MS = NOW - (SESSION_CACHE_TTL_MS - 30_000); // 30 s before TTL → still cached
const COLD_MS = NOW - (SESSION_CACHE_TTL_MS + 30_000); // 30 s after TTL → cache expired

describe("decideSessionRotation — A4 hard stop", () => {
  it("rotates when previous run rawInputTokens exactly hits threshold", () => {
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 1,
      latestInputTokens: THRESHOLD,
      latestRunCreatedAtMs: HOT_MS,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).not.toBeNull();
    expect(reason).toContain("reached");
  });

  it("rotates well above threshold (runaway scenario: 1.86M)", () => {
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 1,
      latestInputTokens: 1_860_000,
      latestRunCreatedAtMs: HOT_MS,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).not.toBeNull();
  });

  it("does NOT rotate one token below threshold", () => {
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 1,
      latestInputTokens: THRESHOLD - 1,
      latestRunCreatedAtMs: HOT_MS,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    // May be null (hot) or A1a (depends on fill ratio); THRESHOLD-1 < 0.7 * 400k for THRESHOLD=400k
    // THRESHOLD - 1 = 399_999 >= 280_000 (70%) but cache is hot → expect null
    expect(reason).toBeNull();
  });
});

describe("decideSessionRotation — A1a proactive (cache-cold pre-emptive)", () => {
  const PCT70 = Math.floor(THRESHOLD * PROACTIVE_SESSION_FILL_RATIO); // 280_000

  it("rotates at exactly 70% fill with cold cache", () => {
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 1,
      latestInputTokens: PCT70,
      latestRunCreatedAtMs: COLD_MS,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).not.toBeNull();
    expect(reason).toContain("proactively");
    expect(reason).toContain("70%");
  });

  it("does NOT rotate at 70% fill when cache is still hot", () => {
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 1,
      latestInputTokens: PCT70,
      latestRunCreatedAtMs: HOT_MS,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).toBeNull();
  });

  it("A1b fires (not A1a) when under 70% with cold cache — message is cold-replay, not proactively", () => {
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 1,
      latestInputTokens: PCT70 - 1,
      latestRunCreatedAtMs: COLD_MS,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    // A1a does NOT fire (below fill ratio), but A1b fires for any cold session.
    expect(reason).not.toBeNull();
    expect(reason).not.toContain("proactively"); // A1a message
    expect(reason).toContain("cold"); // A1b message
  });

  it("A4 wins over A1a (≥100% fill always rotates regardless of cache heat)", () => {
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 1,
      latestInputTokens: THRESHOLD,
      latestRunCreatedAtMs: HOT_MS, // cache still hot — A1a would be suppressed
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).not.toBeNull();
    expect(reason).toContain("reached"); // A4 fires, not A1a
  });
});

describe("decideSessionRotation — policy guards", () => {
  it("A1b fires even when maxRawInputTokens is 0 — cold replay cost is real regardless of threshold", () => {
    const reason = decideSessionRotation({
      policy: { ...BASE_POLICY, maxRawInputTokens: 0 },
      runCount: 1,
      latestInputTokens: 1_000_000,
      latestRunCreatedAtMs: COLD_MS,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    // A4/A1a don't fire (maxRawInputTokens=0 skips the token block), but A1b does.
    expect(reason).not.toBeNull();
    expect(reason).toContain("cold");
  });

  it("rotates on run count when maxSessionRuns exceeded", () => {
    const reason = decideSessionRotation({
      policy: { ...BASE_POLICY, maxSessionRuns: 3, maxRawInputTokens: 0 },
      runCount: 4,
      latestInputTokens: null,
      latestRunCreatedAtMs: null,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).not.toBeNull();
    expect(reason).toContain("3 runs");
  });

  it("returns null when latestInputTokens is null (no run data)", () => {
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 0,
      latestInputTokens: null,
      latestRunCreatedAtMs: null,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).toBeNull();
  });
});

describe("decideSessionRotation — A1b cold session (any fill, universal cold rotation)", () => {
  it("rotates a small cold session (10% fill)", () => {
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 1,
      latestInputTokens: Math.floor(THRESHOLD * 0.1), // 10%
      latestRunCreatedAtMs: COLD_MS,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).not.toBeNull();
    expect(reason).toContain("cold");
    expect(reason).not.toContain("proactively");
  });

  it("does NOT rotate a small hot session (10% fill, within TTL)", () => {
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 1,
      latestInputTokens: Math.floor(THRESHOLD * 0.1),
      latestRunCreatedAtMs: HOT_MS,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).toBeNull();
  });

  it("A1a message wins over A1b when session ≥70% fill + cold", () => {
    const pct70 = Math.floor(THRESHOLD * PROACTIVE_SESSION_FILL_RATIO);
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 1,
      latestInputTokens: pct70,
      latestRunCreatedAtMs: COLD_MS,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).not.toBeNull();
    expect(reason).toContain("proactively"); // A1a fires first
  });

  it("does NOT rotate when latestRunCreatedAtMs is null (no prior runs)", () => {
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 0,
      latestInputTokens: null,
      latestRunCreatedAtMs: null,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).toBeNull();
  });

  it("includes gap duration in the rotation reason", () => {
    const gapMs = 30 * 60_000; // 30 minutes
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 1,
      latestInputTokens: Math.floor(THRESHOLD * 0.1),
      latestRunCreatedAtMs: NOW - gapMs,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).not.toBeNull();
    expect(reason).toContain("30min");
  });
});
