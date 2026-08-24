import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  companies,
  companySubscriptions,
  createDb,
  stripeCustomers,
  subscriptionTiers,
  subscriptionInvoices,
  stripeWebhookEvents as stripeWebhookEventsTable,
} from "@paperclipai/db";
import { ACTIVE_SUBSCRIPTION_STATUSES, FREE_FEATURES } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Load Stripe keys from the Paperclip instance .env before importing billing
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

type Billing = ReturnType<typeof import("../services/billing.js")["billingService"]>;

/**
 * Helper to create a Stripe subscription with a test payment method attached.
 * Without a payment method, Stripe returns incomplete/trialing status for
 * $0-trial subscriptions but errors for non-trialing paid subscriptions.
 */
async function createTestSubscription(
  stripe: Stripe,
  customerId: string,
  priceId: string,
  metadata: Record<string, string>,
): Promise<Stripe.Subscription> {
  // Use a trial period so the subscription is created without requiring
  // a payment method. This works in test mode without needing special
  // API access for raw card data.
  return stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    metadata,
    trial_period_days: 14,
    proration_behavior: "create_prorations",
  });
}

describeEmbeddedPostgres("Stripe billing E2E flow (service layer)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let billing: Billing;

  let adventurerTierId: string;
  let explorerTierId: string;
  let freeCompanyId: string;
  let paidCompanyId: string;
  let stripeCustomerRecordId: string;
  let stripeCustomerId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-billing-e2e-");
    db = createDb(tempDb.connectionString);
    billing = (await import("../services/billing.js")).billingService(db);

    const now = new Date();

    // Seed Adventurer tier
    const [adventurerTier] = await db
      .insert(subscriptionTiers)
      .values({
        name: "Adventurer",
        description: "For solo travelers and small teams",
        priceMonthlyCents: 2900,
        priceYearlyCents: 29000,
        stripePriceMonthlyId: "price_1U6xzsK6Q827UREsvNgIzmPh",
        stripePriceYearlyId: "price_1U6xztK6Q827UREspGqECp6k",
        stripeProductId: "prod_V7COtn9lbjldY0",
        includedSeats: 2,
        extraSeatPriceCents: 1000,
        includedAgentRuns: 500,
        extraAgentRunPriceCents: 10,
        includedStorageGb: 5,
        extraStorageGbPriceCents: 500,
        features: ["ai_trip_planning", "basic_itinerary", "email_support", "2_agents"],
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
        stripePriceMonthlyId: "price_1U6xztK6Q827UREsHOC75ZXN",
        stripePriceYearlyId: "price_1U6xzuK6Q827UREsYdA36dl8",
        stripeProductId: "prod_V7COvNVJtCzi43",
        includedSeats: 5,
        extraSeatPriceCents: 800,
        includedAgentRuns: 2000,
        extraAgentRunPriceCents: 8,
        includedStorageGb: 25,
        extraStorageGbPriceCents: 300,
        features: [
          "ai_trip_planning",
          "advanced_itinerary",
          "real_time_collaboration",
          "priority_support",
          "5_agents",
          "custom_templates",
        ],
        isActive: true,
        sortOrder: 2,
      })
      .returning();
    explorerTierId = explorerTier.id;

    // Free company (no subscription)
    freeCompanyId = randomUUID();
    await db.insert(companies).values({
      id: freeCompanyId,
      name: `Free Co ${freeCompanyId.slice(0, 6)}`,
      status: "active",
      issuePrefix: "FREE",
      updatedAt: now,
    });

    // Paid company
    paidCompanyId = randomUUID();
    await db.insert(companies).values({
      id: paidCompanyId,
      name: `Paid Co ${paidCompanyId.slice(0, 6)}`,
      status: "active",
      issuePrefix: "PAID",
      updatedAt: now,
    });

    // Synthetic stripe customer record
    const [cust] = await db
      .insert(stripeCustomers)
      .values({
        companyId: paidCompanyId,
        stripeCustomerId: "cus_test_e2e",
      })
      .returning();
    stripeCustomerRecordId = cust.id;
    stripeCustomerId = cust.stripeCustomerId;

    // Synthetic subscription for non-Stripe-dependent tests.
    // Use current-period-aligned dates so reportUsage/getUsage period
    // matching works correctly.
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));

    await db.insert(companySubscriptions).values({
      companyId: paidCompanyId,
      tierId: adventurerTierId,
      stripeCustomerId: stripeCustomerRecordId,
      status: "active",
      billingPeriod: "monthly",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Tier listing
  // ─────────────────────────────────────────────────────────────────────────────
  it("lists available subscription tiers", async () => {
    const tiers = await billing.listTiers();
    expect(tiers.length).toBeGreaterThanOrEqual(2);
    expect(tiers.some((t: any) => t.name === "Adventurer")).toBe(true);
    expect(tiers.some((t: any) => t.name === "Explorer")).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Feature gating for free company
  // ─────────────────────────────────────────────────────────────────────────────
  it("free company — free features allowed, paid features denied", async () => {
    const isFree = FREE_FEATURES.includes("ai_trip_planning" as any);
    if (isFree) {
      const result = await billing.checkFeatureAccess(freeCompanyId, "ai_trip_planning");
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("free_feature");
    }

    const result = await billing.checkFeatureAccess(freeCompanyId, "advanced_itinerary");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_subscription");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Create Stripe customer + checkout session
  // ─────────────────────────────────────────────────────────────────────────────
  (hasStripeKeys ? it : it.skip)("creates Stripe customer and checkout session", async () => {
    const tempCompanyId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: tempCompanyId,
      name: `Checkout-Test ${tempCompanyId.slice(0, 6)}`,
      status: "active",
      issuePrefix: "CHK",
      updatedAt: now,
    });

    const customerData = await billing.getOrCreateStripeCustomer(tempCompanyId);
    expect(customerData).toBeDefined();
    expect(customerData.stripeCustomerId).toMatch(/^cus_/);

    const { getStripeClient } = await import("../services/billing.js");
    const stripe = getStripeClient();
    const customer = await stripe.customers.retrieve(customerData.stripeCustomerId);
    expect(customer.deleted).not.toBe(true);
    if (!customer.deleted) {
      expect(customer.id).toBe(customerData.stripeCustomerId);
    }

    const sessionResult = await billing.createCheckoutSession(tempCompanyId, {
      tierId: adventurerTierId,
      billingPeriod: "monthly",
    });
    expect(sessionResult.sessionId).toBeDefined();
    expect(sessionResult.url).toBeTruthy();
    expect(sessionResult.url).toContain("checkout.stripe.com");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Direct subscription via Stripe + checkout handler
  // ─────────────────────────────────────────────────────────────────────────────
  (hasStripeKeys ? it : it.skip)(
    "creates subscription via Stripe and processes via checkout handler",
    async () => {
      const { getStripeClient } = await import("../services/billing.js");
      const stripe = getStripeClient();

      const tempCompanyId = randomUUID();
      const now = new Date();
      await db.insert(companies).values({
        id: tempCompanyId,
        name: `Sub-Test ${tempCompanyId.slice(0, 6)}`,
        status: "active",
        issuePrefix: "SUB",
        updatedAt: now,
      });

      const cust = await billing.getOrCreateStripeCustomer(tempCompanyId);

      // Create subscription with payment method attached
      const stripeSub = await createTestSubscription(
        stripe,
        cust.stripeCustomerId,
        "price_1U6xzsK6Q827UREsvNgIzmPh",
        {
          paperclipCompanyId: tempCompanyId,
          paperclipTierId: adventurerTierId,
        },
      );

      expect(stripeSub.id).toBeDefined();
      // createTestSubscription uses trial_period_days: 14 (no pm required),
      // so Stripe returns status "trialing" rather than "active".
      expect(stripeSub.status).toBe("trialing");

      // Simulate checkout.session.completed webhook
      await billing.handleCheckoutSessionCompleted({
        id: `cs_test_${randomUUID()}`,
        mode: "subscription",
        subscription: stripeSub.id,
        customer: cust.stripeCustomerId,
        metadata: {
          paperclipCompanyId: tempCompanyId,
          paperclipTierId: adventurerTierId,
          billingPeriod: "monthly",
        },
      } as any);

      const sub = await billing.getSubscription(tempCompanyId);
      expect(sub).not.toBeNull();
      const subRecord = sub!;
      expect(subRecord.status).toBe(stripeSub.status);
      expect(subRecord.tierId).toBe(adventurerTierId);
      expect(subRecord.stripeSubscriptionId).toBe(stripeSub.id);

      await stripe.subscriptions.cancel(stripeSub.id, { invoice_now: false });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Feature gating for paid company
  // ─────────────────────────────────────────────────────────────────────────────
  it("paid company can access tier features, denies out-of-tier features", async () => {
    const ok = await billing.checkFeatureAccess(paidCompanyId, "basic_itinerary");
    expect(ok.allowed).toBe(true);
    expect(ok.reason).toBe("tier_includes_feature");

    const denied = await billing.checkFeatureAccess(paidCompanyId, "custom_templates");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("feature_not_in_tier");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. requireFeature throws paywall
  // ─────────────────────────────────────────────────────────────────────────────
  it("requireFeature throws paywall for denied features", async () => {
    await expect(
      billing.requireFeature(paidCompanyId, "custom_templates"),
    ).rejects.toMatchObject({
      status: 403,
      code: "PAYWALL",
      details: { featureKey: "custom_templates" },
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Cancel/reactivate
  // ─────────────────────────────────────────────────────────────────────────────
  (hasStripeKeys ? it : it.skip)(
    "cancels subscription at period end and retains features",
    async () => {
      const { getStripeClient } = await import("../services/billing.js");
      const stripe = getStripeClient();

      const tempCompanyId = randomUUID();
      const now = new Date();
      await db.insert(companies).values({
        id: tempCompanyId,
        name: `Cancel-Test ${tempCompanyId.slice(0, 6)}`,
        status: "active",
        issuePrefix: "CNL",
        updatedAt: now,
      });

      const cust = await billing.getOrCreateStripeCustomer(tempCompanyId);
      const stripeSub = await createTestSubscription(
        stripe,
        cust.stripeCustomerId,
        "price_1U6xzsK6Q827UREsvNgIzmPh",
        {
          paperclipCompanyId: tempCompanyId,
          paperclipTierId: adventurerTierId,
        },
      );

      await billing.handleCheckoutSessionCompleted({
        id: `cs_test_${randomUUID()}`,
        mode: "subscription",
        subscription: stripeSub.id,
        customer: cust.stripeCustomerId,
        metadata: {
          paperclipCompanyId: tempCompanyId,
          paperclipTierId: adventurerTierId,
          billingPeriod: "monthly",
        },
      } as any);

      const canceled = await billing.cancelSubscription(tempCompanyId);
      expect(canceled.cancelAtPeriodEnd).toBe(true);

      const result = await billing.checkFeatureAccess(tempCompanyId, "basic_itinerary");
      expect(result.allowed).toBe(true);

      const reactivated = await billing.reactivateSubscription(tempCompanyId);
      expect(reactivated.cancelAtPeriodEnd).toBe(false);

      await stripe.subscriptions.cancel(stripeSub.id, { invoice_now: false });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Webhook event dedup
  // ─────────────────────────────────────────────────────────────────────────────
  it("rejects duplicate webhook events via event-level dedup", async () => {
    const eventId = `evt_test_${randomUUID()}`;

    // First insert succeeds
    await db.insert(stripeWebhookEventsTable).values({
      stripeEventId: eventId,
      eventType: "invoice.paid",
    });

    // Second insert should throw due to unique constraint
    let caught = false;
    try {
      await db.insert(stripeWebhookEventsTable).values({
        stripeEventId: eventId,
        eventType: "invoice.paid",
      });
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Invoice upsert
  // ─────────────────────────────────────────────────────────────────────────────
  (hasStripeKeys ? it : it.skip)(
    "handleInvoicePaid upserts invoice records idempotently",
    async () => {
      const { getStripeClient } = await import("../services/billing.js");
      const stripe = getStripeClient();

      const tempCompanyId = randomUUID();
      const now = new Date();
      await db.insert(companies).values({
        id: tempCompanyId,
        name: `Invoice-Test ${tempCompanyId.slice(0, 6)}`,
        status: "active",
        issuePrefix: "INV",
        updatedAt: now,
      });

      const cust = await billing.getOrCreateStripeCustomer(tempCompanyId);
      const stripeSub = await createTestSubscription(
        stripe,
        cust.stripeCustomerId,
        "price_1U6xzsK6Q827UREsvNgIzmPh",
        {
          paperclipCompanyId: tempCompanyId,
          paperclipTierId: adventurerTierId,
        },
      );

      await billing.handleCheckoutSessionCompleted({
        id: `cs_test_${randomUUID()}`,
        mode: "subscription",
        subscription: stripeSub.id,
        customer: cust.stripeCustomerId,
        metadata: {
          paperclipCompanyId: tempCompanyId,
          paperclipTierId: adventurerTierId,
          billingPeriod: "monthly",
        },
      } as any);

      const mockInvoice = {
        id: `in_test_${randomUUID()}`,
        subscription: stripeSub.id,
        number: `INV-${Date.now()}`,
        status: "paid",
        total: 2900,
        amount_paid: 2900,
        amount_remaining: 0,
        currency: "usd",
        invoice_pdf: null,
        hosted_invoice_url: null,
        period_start: Math.floor(Date.now() / 1000) - 86400,
        period_end: Math.floor(Date.now() / 1000) + 2592000,
        lines: { data: [] },
      } as any;

      await billing.handleInvoicePaid(mockInvoice);
      const invoices = await billing.listInvoices(tempCompanyId);
      expect(invoices.some((i: any) => i.stripeInvoiceId === mockInvoice.id)).toBe(true);

      // Idempotent
      await billing.handleInvoicePaid(mockInvoice);
      const afterSecond = await billing.listInvoices(tempCompanyId);
      const matching = afterSecond.filter((i: any) => i.stripeInvoiceId === mockInvoice.id);
      expect(matching.length).toBe(1);

      await stripe.subscriptions.cancel(stripeSub.id, { invoice_now: false });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Billing overview
  // ─────────────────────────────────────────────────────────────────────────────
  it("getBillingOverview returns subscription + invoices + total spent", async () => {
    const overview = await billing.getBillingOverview(paidCompanyId);
    expect(overview).toBeDefined();
    expect(overview.companyId).toBe(paidCompanyId);
    expect(overview.subscription).not.toBeNull();
    expect(typeof overview.totalSpentCents).toBe("number");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Usage reporting
  // ─────────────────────────────────────────────────────────────────────────────
  it("reports and retrieves usage metrics", async () => {
    const usageResult = await billing.reportUsage(paidCompanyId, {
      metric: "agent_runs",
      quantity: 50,
    });
    expect(usageResult).toBeDefined();
    expect(usageResult.metric).toBe("agent_runs");
    expect(usageResult.usage).toBe(50);

    const usage = await billing.getUsage(paidCompanyId);
    expect(usage.length).toBeGreaterThanOrEqual(1);
    const agentRuns = usage.find((u: any) => u.metric === "agent_runs");
    expect(agentRuns).toBeDefined();
    expect(agentRuns!.usage).toBe(50);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Subscription tier change
  // ─────────────────────────────────────────────────────────────────────────────
  (hasStripeKeys ? it : it.skip)("updates subscription tier via Stripe", async () => {
    const { getStripeClient } = await import("../services/billing.js");
    const stripe = getStripeClient();

    const tempCompanyId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: tempCompanyId,
      name: `Upgrade-Test ${tempCompanyId.slice(0, 6)}`,
      status: "active",
      issuePrefix: "UPG",
      updatedAt: now,
    });

    const cust = await billing.getOrCreateStripeCustomer(tempCompanyId);
    const stripeSub = await createTestSubscription(
      stripe,
      cust.stripeCustomerId,
      "price_1U6xzsK6Q827UREsvNgIzmPh",
      {
        paperclipCompanyId: tempCompanyId,
        paperclipTierId: adventurerTierId,
      },
    );

    await billing.handleCheckoutSessionCompleted({
      id: `cs_test_${randomUUID()}`,
      mode: "subscription",
      subscription: stripeSub.id,
      customer: cust.stripeCustomerId,
      metadata: {
        paperclipCompanyId: tempCompanyId,
        paperclipTierId: adventurerTierId,
        billingPeriod: "monthly",
      },
    } as any);

    const updated = await billing.createOrUpdateSubscription(tempCompanyId, {
      tierId: explorerTierId,
      billingPeriod: "monthly",
    });
    expect(updated.tierId).toBe(explorerTierId);

    await stripe.subscriptions.cancel(stripeSub.id, { invoice_now: false });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. Sync invoices from Stripe
  // ─────────────────────────────────────────────────────────────────────────────
  (hasStripeKeys ? it : it.skip)("syncs invoices from Stripe", async () => {
    // Create a temporary subscription with a real Stripe subscription ID
    const { getStripeClient } = await import("../services/billing.js");
    const stripe = getStripeClient();

    const tempCompanyId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: tempCompanyId,
      name: `Sync-Test ${tempCompanyId.slice(0, 6)}`,
      status: "active",
      issuePrefix: "SYNC",
      updatedAt: now,
    });

    const cust = await billing.getOrCreateStripeCustomer(tempCompanyId);
    const stripeSub = await createTestSubscription(
      stripe,
      cust.stripeCustomerId,
      "price_1U6xzsK6Q827UREsvNgIzmPh",
      {
        paperclipCompanyId: tempCompanyId,
        paperclipTierId: adventurerTierId,
      },
    );

    await billing.handleCheckoutSessionCompleted({
      id: `cs_test_${randomUUID()}`,
      mode: "subscription",
      subscription: stripeSub.id,
      customer: cust.stripeCustomerId,
      metadata: {
        paperclipCompanyId: tempCompanyId,
        paperclipTierId: adventurerTierId,
        billingPeriod: "monthly",
      },
    } as any);

    const invoices = await billing.syncInvoicesFromStripe(tempCompanyId);
    expect(Array.isArray(invoices)).toBe(true);

    await stripe.subscriptions.cancel(stripeSub.id, { invoice_now: false });
  });
});