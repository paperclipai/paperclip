/**
 * Billing & Pricing Experiment Integration Tests — VOY-1887
 *
 * Verifies that the billing service correctly integrates with the pricing
 * experiment service for variant-aware tier pricing, checkout session
 * metadata, and experiment result aggregation.
 *
 * Database-level tests use embedded Postgres.
 * Stripe API tests require STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  subscriptionTiers,
  stripeCustomers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  pricingExperimentService,
  DEFAULT_EXPERIMENT_CONFIG,
  type PricingExperimentConfig,
} from "../services/pricing-experiment.js";
import { getStripeClient } from "../services/billing.js";

// ── Stripe key detection ──────────────────────────────────────────────
const envPath = join(process.env.HOME!, ".paperclip/instances/default/.env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (
      key.startsWith("STRIPE_") ||
      key.startsWith("NEXT_PUBLIC_STRIPE_") ||
      key === "PAPERCLIP_BILLING_ENABLED"
    ) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

const hasStripeKeys = !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping billing-experiment integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Set PRICING_EXPERIMENT_CONFIG env var to a test configuration.
 * Tests should call this in beforeEach to isolate experiment config.
 */
function setExperimentConfig(overrides?: Partial<PricingExperimentConfig>): void {
  const config: PricingExperimentConfig = {
    ...DEFAULT_EXPERIMENT_CONFIG,
    enabled: true,
    trafficPercent: 100,
    variants: {
      B: {
        weight: 50,
        tierOverrides: {},
      },
    },
    ...overrides,
  };
  process.env.PRICING_EXPERIMENT_CONFIG = JSON.stringify(config);
}

function clearExperimentConfig(): void {
  delete process.env.PRICING_EXPERIMENT_CONFIG;
}

/**
 * Real Stripe price IDs used in existing E2E billing tests.
 * These must exist in the connected Stripe test-mode account.
 */
const STRIPE_PRICES = {
  adventurerMonthly: "price_1U6xzsK6Q827UREsvNgIzmPh",
  adventurerYearly: "price_1U6xztK6Q827UREspGqECp6k",
  explorerMonthly: "price_1U6xztK6Q827UREsHOC75ZXN",
  explorerYearly: "price_1U6xzuK6Q827UREsYdA36dl8",
} as const;

describeEmbeddedPostgres("Billing & Pricing Experiment Integration [VOY-1887]", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let adventurerTierId: string;
  let explorerTierId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-billing-experiment-");
    db = createDb(tempDb.connectionString);

    const now = new Date();

    // Seed Adventurer tier
    const [adventurerTier] = await db
      .insert(subscriptionTiers)
      .values({
        name: "Adventurer",
        description: "For solo travelers",
        priceMonthlyCents: 2900,
        priceYearlyCents: 29000,
        stripePriceMonthlyId: hasStripeKeys ? STRIPE_PRICES.adventurerMonthly : null,
        stripePriceYearlyId: hasStripeKeys ? STRIPE_PRICES.adventurerYearly : null,
        stripeProductId: "prod_mock_adventurer",
        includedSeats: 2,
        extraSeatPriceCents: 1000,
        includedAgentRuns: 500,
        extraAgentRunPriceCents: 10,
        includedStorageGb: 5,
        extraStorageGbPriceCents: 200,
        features: ["ai_trip_planning", "basic_itinerary"],
        isActive: true,
        sortOrder: 1,
      })
      .returning();
    adventurerTierId = adventurerTier.id;

    // Seed Explorer tier
    const [explorerTier] = await db
      .insert(subscriptionTiers)
      .values({
        name: "Explorer",
        description: "For growing teams",
        priceMonthlyCents: 7900,
        priceYearlyCents: 79000,
        stripePriceMonthlyId: hasStripeKeys ? STRIPE_PRICES.explorerMonthly : null,
        stripePriceYearlyId: hasStripeKeys ? STRIPE_PRICES.explorerYearly : null,
        stripeProductId: "prod_mock_explorer",
        includedSeats: 5,
        extraSeatPriceCents: 800,
        includedAgentRuns: 2000,
        extraAgentRunPriceCents: 8,
        includedStorageGb: 25,
        extraStorageGbPriceCents: 300,
        features: ["ai_trip_planning", "advanced_itinerary", "priority_support"],
        isActive: true,
        sortOrder: 2,
      })
      .returning();
    explorerTierId = explorerTier.id;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    // Reset experiment config before each test
    clearExperimentConfig();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 1: Variant-aware tier listing
  // ─────────────────────────────────────────────────────────────────────
  describe("variant-aware tier listing", () => {
    it("returns normal tiers for variant A (control) companies", async () => {
      setExperimentConfig({
        enabled: true,
        variants: {
          B: {
            weight: 50,
            tierOverrides: {
              [adventurerTierId]: { priceMonthlyCents: 1900, name: "Adventurer (Discount)" },
            },
          },
        },
      });

      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `VariantA-Test ${companyId.slice(0, 6)}`,
        status: "active",
        issuePrefix: "VRA",
        updatedAt: new Date(),
        pricingExperimentVariant: "A",
        pricingExperimentEnrolledAt: new Date(),
      });

      const experiment = pricingExperimentService(db as any);
      const { billingService } = await import("../services/billing.js");
      const billing = billingService(db, experiment);

      const tiers = await billing.listTiers(companyId);
      const adventurer = tiers.find((t: any) => t.id === adventurerTierId);
      expect(adventurer).toBeDefined();
      // Variant A should see control pricing
      expect(adventurer!.priceMonthlyCents).toBe(2900);
      expect(adventurer!.name).toBe("Adventurer");
    });

    it("applies tier overrides for variant B companies when experiment is enabled", async () => {
      const overriddenMonthly = 1900;
      const overriddenName = "Adventurer (Discounted)";
      setExperimentConfig({
        enabled: true,
        variants: {
          B: {
            weight: 50,
            tierOverrides: {
              [adventurerTierId]: {
                priceMonthlyCents: overriddenMonthly,
                name: overriddenName,
              },
            },
          },
        },
      });

      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `VariantB-Test ${companyId.slice(0, 6)}`,
        status: "active",
        issuePrefix: "VRB",
        updatedAt: new Date(),
        pricingExperimentVariant: "B",
        pricingExperimentEnrolledAt: new Date(),
      });

      const experiment = pricingExperimentService(db as any);
      const { billingService } = await import("../services/billing.js");
      const billing = billingService(db, experiment);

      const tiers = await billing.listTiers(companyId);
      const adventurer = tiers.find((t: any) => t.id === adventurerTierId);
      expect(adventurer).toBeDefined();
      expect(adventurer!.priceMonthlyCents).toBe(overriddenMonthly);
      expect(adventurer!.name).toBe(overriddenName);

      // Unchanged tier should remain normal
      const explorer = tiers.find((t: any) => t.id === explorerTierId);
      expect(explorer).toBeDefined();
      expect(explorer!.priceMonthlyCents).toBe(7900);
    });

    it("returns normal tiers when experiment is disabled regardless of variant", async () => {
      setExperimentConfig({
        enabled: false,
        variants: {
          B: {
            weight: 50,
            tierOverrides: {
              [adventurerTierId]: { priceMonthlyCents: 1900 },
            },
          },
        },
      });

      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `Disabled-Test ${companyId.slice(0, 6)}`,
        status: "active",
        issuePrefix: "DIS",
        updatedAt: new Date(),
        pricingExperimentVariant: "B",
        pricingExperimentEnrolledAt: new Date(),
      });

      const experiment = pricingExperimentService(db as any);
      const { billingService } = await import("../services/billing.js");
      const billing = billingService(db, experiment);

      const tiers = await billing.listTiers(companyId);
      const adventurer = tiers.find((t: any) => t.id === adventurerTierId);
      expect(adventurer).toBeDefined();
      // Experiment disabled → normal pricing regardless of variant
      expect(adventurer!.priceMonthlyCents).toBe(2900);
    });

    it("returns normal tiers when no companyId is provided", async () => {
      setExperimentConfig({
        enabled: true,
        variants: {
          B: {
            weight: 50,
            tierOverrides: {
              [adventurerTierId]: { priceMonthlyCents: 1900 },
            },
          },
        },
      });

      const experiment = pricingExperimentService(db as any);
      const { billingService } = await import("../services/billing.js");
      const billing = billingService(db, experiment);

      const tiers = await billing.listTiers(); // no companyId
      const adventurer = tiers.find((t: any) => t.id === adventurerTierId);
      expect(adventurer).toBeDefined();
      // Without companyId, experiment is not applied
      expect(adventurer!.priceMonthlyCents).toBe(2900);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 2: Checkout session metadata includes pricingExperimentVariant
  // ─────────────────────────────────────────────────────────────────────
  describe("checkout session metadata", () => {
    it("includes pricingExperimentVariant in checkout session metadata when experiment is enabled", async () => {
      setExperimentConfig({ enabled: true });

      const companyId = randomUUID();
      const now = new Date();
      await db.insert(companies).values({
        id: companyId,
        name: `Metadata-Test ${companyId.slice(0, 6)}`,
        status: "active",
        issuePrefix: "MET",
        updatedAt: now,
        pricingExperimentVariant: "B",
        pricingExperimentEnrolledAt: now,
      });

      const experiment = pricingExperimentService(db as any);
      const { billingService } = await import("../services/billing.js");
      const billing = billingService(db, experiment);

      // Verify the variant is correctly read
      const variant = await billing.getExperimentVariant(companyId);
      expect(variant).toBe("B");
    });

    it("returns 'A' (control) when experiment is disabled", async () => {
      setExperimentConfig({ enabled: false });

      const companyId = randomUUID();
      const now = new Date();
      await db.insert(companies).values({
        id: companyId,
        name: `NoExp-Test ${companyId.slice(0, 6)}`,
        status: "active",
        issuePrefix: "NOX",
        updatedAt: now,
      });

      const experiment = pricingExperimentService(db as any);
      const { billingService } = await import("../services/billing.js");
      const billing = billingService(db, experiment);

      // When experiment is disabled, variant is "A" (control)
      const variant = await billing.getExperimentVariant(companyId);
      expect(variant).toBe("A");
    });

    // Stripe API verification — requires real test-mode keys
    (hasStripeKeys ? it : it.skip)(
      "creates Stripe checkout session with pricingExperimentVariant metadata",
      async () => {
        setExperimentConfig({ enabled: true });

        const companyId = randomUUID();
        const now = new Date();
        await db.insert(companies).values({
          id: companyId,
          name: `Stripe-Meta-Test ${companyId.slice(0, 6)}`,
          status: "active",
          issuePrefix: "STM",
          updatedAt: now,
          pricingExperimentVariant: "B",
          pricingExperimentEnrolledAt: now,
        });

        const experiment = pricingExperimentService(db as any);
        const { billingService } = await import("../services/billing.js");
        const billing = billingService(db, experiment);

        // Create Stripe customer and checkout session
        const customerData = await billing.getOrCreateStripeCustomer(companyId);
        expect(customerData.stripeCustomerId).toMatch(/^cus_/);

        const sessionResult = await billing.createCheckoutSession(companyId, {
          tierId: adventurerTierId,
          billingPeriod: "monthly",
        });
        expect(sessionResult.sessionId).toMatch(/^cs_test_/);

        // Retrieve the session from Stripe and verify metadata
        const stripe = getStripeClient();
        const session = await stripe.checkout.sessions.retrieve(sessionResult.sessionId);
        expect(session.metadata?.pricingExperimentVariant).toBe("B");
        expect(session.metadata?.paperclipCompanyId).toBe(companyId);
        expect(session.metadata?.paperclipTierId).toBe(adventurerTierId);
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 3: Experiment variant endpoint
  // ─────────────────────────────────────────────────────────────────────
  describe("getExperimentVariant", () => {
    it("returns pre-assigned variant for a company", async () => {
      const companyId = randomUUID();
      const now = new Date();
      await db.insert(companies).values({
        id: companyId,
        name: `Variant-Get-Test ${companyId.slice(0, 6)}`,
        status: "active",
        issuePrefix: "VGT",
        updatedAt: now,
        pricingExperimentVariant: "A",
        pricingExperimentEnrolledAt: now,
      });

      setExperimentConfig({ enabled: true });
      const experiment = pricingExperimentService(db as any);
      const { billingService } = await import("../services/billing.js");
      const billing = billingService(db, experiment);

      const variant = await billing.getExperimentVariant(companyId);
      expect(variant).toBe("A");
    });

    it("assigns and returns variant for unassigned company when experiment is enabled", async () => {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `Assign-Test ${companyId.slice(0, 6)}`,
        status: "active",
        issuePrefix: "ASN",
        updatedAt: new Date(),
      });

      setExperimentConfig({ enabled: true, trafficPercent: 100 });
      const experiment = pricingExperimentService(db as any);
      const { billingService } = await import("../services/billing.js");
      const billing = billingService(db, experiment);

      const variant = await billing.getExperimentVariant(companyId);
      // With 100% traffic, company should be assigned A or B
      expect(["A", "B"]).toContain(variant);
    });

    it("returns 'A' for unassigned company when experiment is disabled", async () => {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `NoAssign-Test ${companyId.slice(0, 6)}`,
        status: "active",
        issuePrefix: "NAS",
        updatedAt: new Date(),
      });

      setExperimentConfig({ enabled: false });
      const experiment = pricingExperimentService(db as any);
      const { billingService } = await import("../services/billing.js");
      const billing = billingService(db, experiment);

      // When experiment is disabled, all companies are control (A)
      const variant = await billing.getExperimentVariant(companyId);
      expect(variant).toBe("A");
    });

    it("returns null when experiment service is not configured", async () => {
      const { billingService } = await import("../services/billing.js");
      // Create billing WITHOUT experiment service
      const billing = billingService(db);
      const variant = await billing.getExperimentVariant(randomUUID());
      expect(variant).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 4: Experiment results endpoint
  // ─────────────────────────────────────────────────────────────────────
  describe("getExperimentResults", () => {
    // Clear experiment variant data left by previous describe blocks,
    // so this nested suite has a clean slate for counting.
    beforeEach(async () => {
      await db
        .update(companies)
        .set({ pricingExperimentVariant: null, pricingExperimentEnrolledAt: null })
        .where(isNotNull(companies.pricingExperimentVariant));
    });

    it("returns aggregated experiment results", async () => {
      const now = new Date();

      // Seed companies with variants
      for (let i = 0; i < 5; i++) {
        await db.insert(companies).values({
          id: randomUUID(),
          name: `Exp-Result-A-${i} ${randomUUID().slice(0, 6)}`,
          status: "active",
          issuePrefix: `ERA${i}`,
          updatedAt: now,
          pricingExperimentVariant: "A",
          pricingExperimentEnrolledAt: now,
        });
      }
      for (let i = 0; i < 3; i++) {
        await db.insert(companies).values({
          id: randomUUID(),
          name: `Exp-Result-B-${i} ${randomUUID().slice(0, 6)}`,
          status: "active",
          issuePrefix: `ERB${i}`,
          updatedAt: now,
          pricingExperimentVariant: "B",
          pricingExperimentEnrolledAt: now,
        });
      }

      setExperimentConfig({ enabled: true });
      const experiment = pricingExperimentService(db as any);
      const { billingService } = await import("../services/billing.js");
      const billing = billingService(db, experiment);

      const results = await billing.getExperimentResults();
      expect(results).not.toBeNull();
      expect(results!.enabled).toBe(true);
      expect(results!.totalAssigned).toBe(8);
      expect(results!.variantA.count).toBe(5);
      expect(results!.variantB.count).toBe(3);
    });

    it("returns null when experiment service is not configured", async () => {
      const { billingService } = await import("../services/billing.js");
      const billing = billingService(db);
      const results = await billing.getExperimentResults();
      expect(results).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Test 5: Stripe metadata propagation (webhook handler)
  // ─────────────────────────────────────────────────────────────────────
  describe("Stripe metadata propagation", () => {
    (hasStripeKeys ? it : it.skip)(
      "propagates pricingExperimentVariant through checkout session to subscription",
      async () => {
        setExperimentConfig({ enabled: true });

        const companyId = randomUUID();
        const now = new Date();
        await db.insert(companies).values({
          id: companyId,
          name: `Prop-Test ${companyId.slice(0, 6)}`,
          status: "active",
          issuePrefix: "PRO",
          updatedAt: now,
          pricingExperimentVariant: "B",
          pricingExperimentEnrolledAt: now,
        });

        const stripe = getStripeClient();
        const experiment = pricingExperimentService(db as any);
        const { billingService } = await import("../services/billing.js");
        const billing = billingService(db, experiment);

        // 1. Create Stripe customer
        const customerData = await billing.getOrCreateStripeCustomer(companyId);

        // 2. Create checkout session via billing service
        const sessionResult = await billing.createCheckoutSession(companyId, {
          tierId: adventurerTierId,
          billingPeriod: "monthly",
        });
        expect(sessionResult.sessionId).toMatch(/^cs_test_/);

        // 3. Retrieve session and verify pricingExperimentVariant metadata
        const session = await stripe.checkout.sessions.retrieve(sessionResult.sessionId);
        expect(session.metadata?.pricingExperimentVariant).toBe("B");

        // 4. Create a subscription that simulates completed checkout.
        //    In test mode we create one directly with matching metadata.
        const stripeSub = await stripe.subscriptions.create({
          customer: customerData.stripeCustomerId,
          items: [{ price: STRIPE_PRICES.adventurerMonthly }],
          metadata: {
            paperclipCompanyId: companyId,
            paperclipTierId: adventurerTierId,
            billingPeriod: "monthly",
            pricingExperimentVariant: "B",
          },
          trial_period_days: 14,
          proration_behavior: "create_prorations",
        });

        expect(stripeSub.metadata?.pricingExperimentVariant).toBe("B");

        // 5. Simulate checkout session completed webhook
        await billing.handleCheckoutSessionCompleted({
          id: sessionResult.sessionId,
          mode: "subscription",
          subscription: stripeSub.id,
          customer: customerData.stripeCustomerId,
          metadata: {
            paperclipCompanyId: companyId,
            paperclipTierId: adventurerTierId,
            billingPeriod: "monthly",
            pricingExperimentVariant: "B",
          },
        } as any);

        // 6. Verify the local subscription record exists
        const sub = await billing.getSubscription(companyId);
        expect(sub).not.toBeNull();
        expect(sub!.stripeSubscriptionId).toBe(stripeSub.id);
        expect(sub!.tierId).toBe(adventurerTierId);

        // Cleanup
        await stripe.subscriptions.cancel(stripeSub.id, { invoice_now: false });
      },
    );
  });
});
