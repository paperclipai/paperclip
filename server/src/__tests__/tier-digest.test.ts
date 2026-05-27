import { describe, expect, it } from "vitest";

import type { ObservabilityStore, TierMixRow } from "../services/observability-store.js";
import {
  buildTierDigest,
  buildTierDigestSlackBody,
  monthStartUtc,
  renderTierDigestSummary,
  rolling24hStart,
  TIER1_SATURATION_THRESHOLD,
} from "../services/tier-digest.js";

interface FakeStoreState {
  enabled?: boolean;
  mix?: Array<TierMixRow>;
  tier1Cost?: number;
}

function fakeStore(state: FakeStoreState = {}): ObservabilityStore & {
  /** Records of (sinceIso) passed to query helpers. */
  lastMixQuery?: string;
  lastCostQuery?: string;
} {
  const out: ObservabilityStore & { lastMixQuery?: string; lastCostQuery?: string } = {
    enabled: state.enabled ?? true,
    dbPath: ":memory:",
    recordInvocation: () => undefined,
    queryTierMix: (sinceIso: string) => {
      out.lastMixQuery = sinceIso;
      return state.mix ?? [];
    },
    queryTier1CostSince: (sinceIso: string) => {
      out.lastCostQuery = sinceIso;
      return state.tier1Cost ?? 0;
    },
    close: () => undefined,
  };
  return out;
}

describe("rolling24hStart / monthStartUtc", () => {
  it("rolling24hStart subtracts exactly 24h", () => {
    const now = new Date("2026-05-24T13:15:00Z");
    expect(rolling24hStart(now)).toBe("2026-05-23T13:15:00.000Z");
  });

  it("monthStartUtc snaps to the first day of the current UTC month", () => {
    expect(monthStartUtc(new Date("2026-05-24T13:15:00Z"))).toBe(
      "2026-05-01T00:00:00.000Z",
    );
    expect(monthStartUtc(new Date("2026-01-01T00:00:00.001Z"))).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});

describe("buildTierDigest", () => {
  const now = new Date("2026-05-24T13:15:00Z");

  it("returns a zero digest when the store is disabled", () => {
    const digest = buildTierDigest({ store: fakeStore({ enabled: false }), now });
    expect(digest.totalInvocations).toBe(0);
    expect(digest.byTier).toEqual([]);
    expect(digest.tier1CostMtdUsd).toBe(0);
    expect(digest.tier1SaturationAlert).toBe(false);
    expect(digest.tier1Share24h).toBe(0);
    expect(digest.windowStart).toBe("2026-05-23T13:15:00.000Z");
    expect(digest.windowEnd).toBe("2026-05-24T13:15:00.000Z");
  });

  it("queries the store with the rolling-24h start and month-start", () => {
    const store = fakeStore({
      mix: [
        { tier: 0, count: 90 },
        { tier: 1, count: 10 },
      ],
      tier1Cost: 4.56,
    });
    const digest = buildTierDigest({ store, now });
    expect(store.lastMixQuery).toBe("2026-05-23T13:15:00.000Z");
    expect(store.lastCostQuery).toBe("2026-05-01T00:00:00.000Z");
    expect(digest.totalInvocations).toBe(100);
    expect(digest.byTier).toEqual([
      {
        tier: 0,
        count: 90,
        share: 0.9,
        label: "Tier 0 (subscription)",
      },
      { tier: 1, count: 10, share: 0.1, label: "Tier 1 (API)" },
    ]);
    expect(digest.tier1CostMtdUsd).toBe(4.56);
    expect(digest.tier1Share24h).toBeCloseTo(0.1, 6);
    expect(digest.tier1SaturationAlert).toBe(false);
  });

  it("does not alert at the threshold boundary (20.0%)", () => {
    const digest = buildTierDigest({
      store: fakeStore({
        mix: [
          { tier: 0, count: 80 },
          { tier: 1, count: 20 },
        ],
      }),
      now,
    });
    expect(digest.tier1Share24h).toBe(0.2);
    expect(digest.tier1SaturationAlert).toBe(false);
  });

  it("alerts when Tier 1 share strictly exceeds 20%", () => {
    const digest = buildTierDigest({
      store: fakeStore({
        mix: [
          { tier: 0, count: 75 },
          { tier: 1, count: 25 },
        ],
      }),
      now,
    });
    expect(digest.tier1Share24h).toBe(0.25);
    expect(digest.tier1SaturationAlert).toBe(true);
  });

  it("honours a custom alert threshold", () => {
    const digest = buildTierDigest({
      store: fakeStore({
        mix: [
          { tier: 0, count: 95 },
          { tier: 1, count: 5 },
        ],
      }),
      now,
      alertThreshold: 0.04,
    });
    expect(digest.tier1SaturationAlert).toBe(true);
  });

  it("sorts tiers ascending and labels unknown tiers", () => {
    const digest = buildTierDigest({
      store: fakeStore({
        mix: [
          { tier: 2, count: 3 },
          { tier: 0, count: 1 },
          { tier: 7, count: 1 },
        ],
      }),
      now,
    });
    expect(digest.byTier.map((r) => r.tier)).toEqual([0, 2, 7]);
    expect(digest.byTier[2]!.label).toBe("Tier 7");
  });

  it("uses the documented threshold constant by default", () => {
    expect(TIER1_SATURATION_THRESHOLD).toBe(0.2);
  });
});

describe("renderTierDigestSummary", () => {
  const now = new Date("2026-05-24T13:15:00Z");

  it("emits a no-data line when there are no invocations", () => {
    const digest = buildTierDigest({ store: fakeStore({ mix: [] }), now });
    const text = renderTierDigestSummary(digest);
    expect(text).toContain("No agent invocations recorded in the last 24h.");
    expect(text).toContain("Tier 1 cost MTD: $0.00");
    expect(text).not.toContain("saturation alert");
  });

  it("renders per-tier counts and percentages", () => {
    const digest = buildTierDigest({
      store: fakeStore({
        mix: [
          { tier: 0, count: 96 },
          { tier: 1, count: 4 },
        ],
        tier1Cost: 12.41,
      }),
      now,
    });
    const text = renderTierDigestSummary(digest);
    expect(text).toContain("Tier 0 (subscription): 96 (96.0%)");
    expect(text).toContain("Tier 1 (API): 4 (4.0%)");
    expect(text).toContain("Tier 1 cost MTD: $12.41");
  });

  it("prepends the saturation alert line when over threshold", () => {
    const digest = buildTierDigest({
      store: fakeStore({
        mix: [
          { tier: 0, count: 70 },
          { tier: 1, count: 30 },
        ],
        tier1Cost: 80.0,
      }),
      now,
    });
    const text = renderTierDigestSummary(digest);
    expect(text.startsWith(":rotating_light: Tier 1 saturation alert")).toBe(true);
    expect(text).toContain("24h share = 30.0%");
    expect(text).toContain("Tier 1 cost MTD: $80.00");
  });
});

describe("buildTierDigestSlackBody", () => {
  const now = new Date("2026-05-24T13:15:00Z");

  it("marks the attachment green when no alert", () => {
    const digest = buildTierDigest({
      store: fakeStore({
        mix: [
          { tier: 0, count: 99 },
          { tier: 1, count: 1 },
        ],
      }),
      now,
    });
    const body = buildTierDigestSlackBody(digest);
    expect(body.attachments[0]!.color).toBe("good");
    expect(body.paperclip.eventType).toBe("tier.digest");
    expect(body.paperclip.tier1SaturationAlert).toBe(false);
  });

  it("marks the attachment red on alert and round-trips structured payload", () => {
    const digest = buildTierDigest({
      store: fakeStore({
        mix: [
          { tier: 0, count: 70 },
          { tier: 1, count: 30 },
        ],
        tier1Cost: 50,
      }),
      now,
    });
    const body = buildTierDigestSlackBody(digest);
    expect(body.attachments[0]!.color).toBe("danger");
    expect(body.paperclip.tier1SaturationAlert).toBe(true);
    expect(body.paperclip.tier1CostMtdUsd).toBe(50);
    expect(body.paperclip.byTier).toEqual(digest.byTier);
  });

  it("never serializes a row that wasn't in the mix", () => {
    const digest = buildTierDigest({
      store: fakeStore({ mix: [{ tier: 0, count: 5 }] }),
      now,
    });
    const body = buildTierDigestSlackBody(digest);
    const fieldsJson = JSON.stringify(body.attachments[0]!.fields);
    expect(fieldsJson).not.toContain("Tier 1 (API)");
  });
});
