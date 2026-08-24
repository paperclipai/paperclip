import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { pricingExperimentService, type PricingExperimentConfig, DEFAULT_EXPERIMENT_CONFIG } from "../services/pricing-experiment.js";

// ── Mocks ──────────────────────────────────────────────────────────────

function mockDb() {
  const store = new Map<string, { variant: string | null; enrolledAt: Date | null }>();

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: vi.fn((fn: (r: never[]) => unknown) => {
            // Returns empty results by default
            return Promise.resolve(fn([] as never[]));
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          then: vi.fn((fn: (r: never[]) => unknown) => Promise.resolve(fn([] as never[]))),
        })),
      })),
    })),
    /** Provide a way for tests to pre-seed a company's variant */
    _seedVariant(companyId: string, variant: string, enrolledAt: Date = new Date()) {
      store.set(companyId, { variant, enrolledAt });
    },
    /** Provide a way to get the stored variant */
    _getVariant(companyId: string) {
      return store.get(companyId) ?? null;
    },
    // Internal ref for test assertions
    _store: store,
  } as ReturnType<typeof mockDb>;
}

// ── Deterministic assignment tests ─────────────────────────────────────

describe("pricingExperimentService", () => {
  describe("deterministic assignment", () => {
    it("returns the same variant for the same company ID on repeated calls", () => {
      const db = mockDb();
      const svc = pricingExperimentService(db as never);
      const config: PricingExperimentConfig = {
        ...DEFAULT_EXPERIMENT_CONFIG,
        enabled: true,
        trafficPercent: 100,
      };
      const companyId = randomUUID();
      const first = svc.assignVariant(companyId, config);
      // Call 100 times — should always be the same
      for (let i = 0; i < 100; i++) {
        expect(svc.assignVariant(companyId, config)).toBe(first);
      }
    });

    it("returns different variants for different company IDs (statistical)", () => {
      const db = mockDb();
      const svc = pricingExperimentService(db as never);
      const config: PricingExperimentConfig = {
        ...DEFAULT_EXPERIMENT_CONFIG,
        enabled: true,
        trafficPercent: 100,
      };
      const results = { A: 0, B: 0 };
      const count = 1000;
      for (let i = 0; i < count; i++) {
        const variant = svc.assignVariant(randomUUID(), config);
        results[variant]++;
      }
      // Expect roughly 50/50 split (within 15% tolerance)
      expect(results.A).toBeGreaterThan(count * 0.35);
      expect(results.A).toBeLessThan(count * 0.65);
      expect(results.B).toBeGreaterThan(count * 0.35);
      expect(results.B).toBeLessThan(count * 0.65);
    });

    it("returns 'A' for all companies when experiment is disabled", () => {
      const db = mockDb();
      const svc = pricingExperimentService(db as never);
      const config: PricingExperimentConfig = {
        ...DEFAULT_EXPERIMENT_CONFIG,
        enabled: false,
      };
      for (let i = 0; i < 10; i++) {
        expect(svc.assignVariant(randomUUID(), config)).toBe("A");
      }
    });

    it("respects trafficPercent (only X% of companies get assigned to experiment)", () => {
      const db = mockDb();
      const svc = pricingExperimentService(db as never);
      const config: PricingExperimentConfig = {
        ...DEFAULT_EXPERIMENT_CONFIG,
        enabled: true,
        trafficPercent: 20,
      };
      // With 20% traffic, most companies should be control (A)
      // Only ~20% enter the experiment split
      const results = { A: 0, B: 0 };
      const count = 2000;
      for (let i = 0; i < count; i++) {
        const variant = svc.assignVariant(randomUUID(), config);
        results[variant]++;
      }
      // B should be ~10% (20% traffic * 50% B weight)
      expect(results.B).toBeGreaterThan(count * 0.05);
      expect(results.B).toBeLessThan(count * 0.18);
      // A should be ~90%
      expect(results.A).toBeGreaterThan(count * 0.82);
    });

    it("respects variant B weight override", () => {
      const db = mockDb();
      const svc = pricingExperimentService(db as never);
      // 100% traffic, 100% B weight — all experimental traffic goes to B
      const config: PricingExperimentConfig = {
        ...DEFAULT_EXPERIMENT_CONFIG,
        enabled: true,
        trafficPercent: 100,
        variants: {
          B: { weight: 100, tierOverrides: {} },
        },
      };
      // With 100% B weight and 100% traffic, everyone should be B
      for (let i = 0; i < 100; i++) {
        expect(svc.assignVariant(randomUUID(), config)).toBe("B");
      }
    });
  });

  // ── Config parsing tests ─────────────────────────────────────────────

  describe("config parsing", () => {
    it("parses valid JSON config", () => {
      const db = mockDb();
      const svc = pricingExperimentService(db as never);
      const raw = JSON.stringify({
        enabled: true,
        trafficPercent: 75,
        variants: {
          B: {
            weight: 60,
            tierOverrides: {
              "tier-1": { priceMonthlyCents: 1900 },
            },
          },
        },
        salt: "test-salt",
      });
      const config = svc.parseConfig(raw);
      expect(config.enabled).toBe(true);
      expect(config.trafficPercent).toBe(75);
      expect(config.variants.B?.weight).toBe(60);
      expect(config.variants.B?.tierOverrides?.["tier-1"]?.priceMonthlyCents).toBe(1900);
    });

    it("returns defaults for empty/null config", () => {
      const db = mockDb();
      const svc = pricingExperimentService(db as never);
      expect(svc.parseConfig(null)).toEqual(DEFAULT_EXPERIMENT_CONFIG);
      expect(svc.parseConfig("")).toEqual(DEFAULT_EXPERIMENT_CONFIG);
      expect(svc.parseConfig(undefined)).toEqual(DEFAULT_EXPERIMENT_CONFIG);
    });

    it("returns defaults for invalid JSON", () => {
      const db = mockDb();
      const svc = pricingExperimentService(db as never);
      const config = svc.parseConfig("not-json");
      expect(config).toEqual(DEFAULT_EXPERIMENT_CONFIG);
    });

    it("validates config fields with Zod", () => {
      const db = mockDb();
      const svc = pricingExperimentService(db as never);
      // trafficPercent out of range
      const config = svc.parseConfig(JSON.stringify({ trafficPercent: 150 }));
      // Should fall back to defaults
      expect(config.trafficPercent).toBe(50);
    });
  });

  // ── Tier override tests ──────────────────────────────────────────────

  describe("tier overrides", () => {
    const baseTiers = [
      { id: "tier-1", name: "Adventurer", priceMonthlyCents: 2900, priceYearlyCents: 29000, stripePriceMonthlyId: "price_m1", stripePriceYearlyId: "price_y1", stripeProductId: "prod_1", includedSeats: 2, extraSeatPriceCents: 1000, includedAgentRuns: 500, extraAgentRunPriceCents: 500, includedStorageGb: 5, extraStorageGbPriceCents: 200, features: ["feature_a"], isActive: true, sortOrder: 0, description: null },
      { id: "tier-2", name: "Explorer", priceMonthlyCents: 7900, priceYearlyCents: 79000, stripePriceMonthlyId: "price_m2", stripePriceYearlyId: "price_y2", stripeProductId: "prod_2", includedSeats: 5, extraSeatPriceCents: 1000, includedAgentRuns: 2000, extraAgentRunPriceCents: 500, includedStorageGb: 25, extraStorageGbPriceCents: 200, features: ["feature_a", "feature_b"], isActive: true, sortOrder: 1, description: null },
    ];

    it("returns unmodified tiers for variant A (control)", () => {
      const db = mockDb();
      const svc = pricingExperimentService(db as never);
      const config = {
        ...DEFAULT_EXPERIMENT_CONFIG,
        enabled: true,
        variants: { B: { weight: 50, tierOverrides: { "tier-1": { priceMonthlyCents: 1900 } } } },
      };
      const result = svc.applyTierOverrides(baseTiers, "A", config);
      expect(result[0].priceMonthlyCents).toBe(2900);
      expect(result[1].priceMonthlyCents).toBe(7900);
    });

    it("applies overrides for variant B tiers", () => {
      const db = mockDb();
      const svc = pricingExperimentService(db as never);
      const config = {
        ...DEFAULT_EXPERIMENT_CONFIG,
        enabled: true,
        variants: { B: { weight: 50, tierOverrides: { "tier-1": { priceMonthlyCents: 1900, name: "Adventurer (Discounted)" } } } },
      };
      const result = svc.applyTierOverrides(baseTiers, "B", config);
      expect(result[0].priceMonthlyCents).toBe(1900);
      expect(result[0].name).toBe("Adventurer (Discounted)");
      // Unchanged tier
      expect(result[1].priceMonthlyCents).toBe(7900);
    });

    it("does not apply overrides when experiment is disabled", () => {
      const db = mockDb();
      const svc = pricingExperimentService(db as never);
      const config = {
        ...DEFAULT_EXPERIMENT_CONFIG,
        enabled: false,
        variants: { B: { weight: 50, tierOverrides: { "tier-1": { priceMonthlyCents: 1900 } } } },
      };
      const result = svc.applyTierOverrides(baseTiers, "B", config);
      expect(result[0].priceMonthlyCents).toBe(2900);
    });
  });

  // ── Stale service symbol ─────────────────────────────────────────────

  it("exports a service symbol for downstream binding", () => {
    const db = mockDb();
    const svc = pricingExperimentService(db as never);
    expect(svc).toBeDefined();
    expect(typeof svc.assignVariant).toBe("function");
    expect(typeof svc.getOrAssignVariant).toBe("function");
    expect(typeof svc.applyTierOverrides).toBe("function");
    expect(typeof svc.getResults).toBe("function");
    expect(typeof svc.parseConfig).toBe("function");
    expect(typeof svc.loadConfig).toBe("function");
  });

  // ── loadConfig uses env ──────────────────────────────────────────────

  it("loadConfig reads from PRICING_EXPERIMENT_CONFIG env var", () => {
    const db = mockDb();
    const svc = pricingExperimentService(db as never);
    const original = process.env.PRICING_EXPERIMENT_CONFIG;
    try {
      process.env.PRICING_EXPERIMENT_CONFIG = JSON.stringify({
        enabled: true,
        trafficPercent: 100,
      });
      const config = svc.loadConfig();
      expect(config.enabled).toBe(true);
      expect(config.trafficPercent).toBe(100);
    } finally {
      process.env.PRICING_EXPERIMENT_CONFIG = original;
    }
  });
});
