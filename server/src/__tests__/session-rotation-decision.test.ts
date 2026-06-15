/**
 * Unit tests for decideSessionRotation — the pure rotation-decision extracted
 * from evaluateSessionCompaction (heartbeat.ts). Tests cover:
 *   A4: hard stop when previous run rawInputTokens >= threshold
 *   A1a: proactive rotation when ≥70% full AND cache cold (gap > 5-min TTL)
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

  it("does NOT rotate under 70% even with cold cache", () => {
    const reason = decideSessionRotation({
      policy: BASE_POLICY,
      runCount: 1,
      latestInputTokens: PCT70 - 1,
      latestRunCreatedAtMs: COLD_MS,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).toBeNull();
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
  it("no token-based rotation when maxRawInputTokens is 0 (adapter-managed)", () => {
    const reason = decideSessionRotation({
      policy: { ...BASE_POLICY, maxRawInputTokens: 0 },
      runCount: 1,
      latestInputTokens: 1_000_000,
      latestRunCreatedAtMs: COLD_MS,
      sessionAgeHours: 0,
      nowMs: NOW,
    });
    expect(reason).toBeNull();
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
