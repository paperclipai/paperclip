import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySubscriptions,
  createDb,
  stripeCustomers,
  subscriptionTiers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping feature gating tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Billing = ReturnType<typeof import("../services/billing.js")["billingService"]>;

describeEmbeddedPostgres("billing feature gating (checkFeatureAccess / requireFeature)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let billing: Billing;

  // Company IDs
  const freeId = randomUUID();
  const paidId = randomUUID();
  const inactiveId = randomUUID();
  const cancelEndedId = randomUUID();
  const cancelActiveId = randomUUID();
  const wrongTierId = randomUUID();

  // Tier IDs
  const proTierId = randomUUID();
  const starterTierId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-billing-feature-gate-");
    db = createDb(tempDb.connectionString);
    billing = (await import("../services/billing.js")).billingService(db);

    const now = new Date();
    const periodStart = new Date(now.getTime() - 7 * 86400_000);
    const periodEndFuture = new Date(now.getTime() + 23 * 86400_000);
    const periodEndPast = new Date(now.getTime() - 1 * 86400_000);

    // Seed companies
    const cids = [freeId, paidId, inactiveId, cancelEndedId, cancelActiveId, wrongTierId];
    const prefixes = ["FGTA", "FGTB", "FGTC", "FGTD", "FGTE", "FGTF"];
    for (let i = 0; i < cids.length; i++) {
      await db.insert(companies).values({
        id: cids[i],
        name: `FeatureGate Co ${cids[i].slice(0, 6)}`,
        status: "active",
        issuePrefix: prefixes[i],
        updatedAt: now,
      });
    }

    // Seed tiers
    await db.insert(subscriptionTiers).values([
      {
        id: proTierId,
        name: "Pro",
        priceMonthlyCents: 2900,
        includedSeats: 5,
        includedAgentRuns: 100,
        includedStorageGb: 10,
        features: ["advanced_agents", "audit_logs"],
        isActive: true,
        sortOrder: 1,
      },
      {
        id: starterTierId,
        name: "Starter",
        priceMonthlyCents: 900,
        includedSeats: 2,
        includedAgentRuns: 20,
        includedStorageGb: 2,
        features: ["audit_logs"],
        isActive: true,
        sortOrder: 0,
      },
    ]);

    // Seed Stripe customers (for companies that have subscriptions)
    const subCompanies = [paidId, inactiveId, cancelEndedId, cancelActiveId, wrongTierId];
    const customerIds: Record<string, string> = {};
    for (const companyId of subCompanies) {
      const [cust] = await db
        .insert(stripeCustomers)
        .values({
          companyId,
          stripeCustomerId: `cus_${companyId.slice(0, 8)}`,
        })
        .returning();
      customerIds[companyId] = cust.id;
    }

    // Seed subscriptions
    await db.insert(companySubscriptions).values([
      {
        companyId: paidId,
        tierId: proTierId,
        stripeCustomerId: customerIds[paidId],
        status: "active",
        billingPeriod: "monthly",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEndFuture,
        cancelAtPeriodEnd: false,
      },
      {
        companyId: inactiveId,
        tierId: proTierId,
        stripeCustomerId: customerIds[inactiveId],
        status: "past_due",
        billingPeriod: "monthly",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEndFuture,
        cancelAtPeriodEnd: false,
      },
      {
        companyId: cancelEndedId,
        tierId: proTierId,
        stripeCustomerId: customerIds[cancelEndedId],
        status: "active",
        billingPeriod: "monthly",
        currentPeriodStart: new Date(now.getTime() - 60 * 86400_000),
        currentPeriodEnd: periodEndPast,
        cancelAtPeriodEnd: true,
      },
      {
        companyId: cancelActiveId,
        tierId: proTierId,
        stripeCustomerId: customerIds[cancelActiveId],
        status: "active",
        billingPeriod: "monthly",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEndFuture,
        cancelAtPeriodEnd: true,
      },
      {
        companyId: wrongTierId,
        tierId: starterTierId,
        stripeCustomerId: customerIds[wrongTierId],
        status: "active",
        billingPeriod: "monthly",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEndFuture,
        cancelAtPeriodEnd: false,
      },
    ]);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ─── checkFeatureAccess tests ───────────────────────────────────────────

  it("allows free features without any subscription", async () => {
    const result = await billing.checkFeatureAccess(freeId, "custom_plugins");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("free_feature");
  });

  it("denies paid features when there is no subscription (no_subscription)", async () => {
    const result = await billing.checkFeatureAccess(freeId, "advanced_agents");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_subscription");
    expect(result.subscription).toBeNull();
    expect(result.tier).toBeNull();
  });

  it("allows a paid feature when the active tier includes it", async () => {
    const result = await billing.checkFeatureAccess(paidId, "advanced_agents");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("tier_includes_feature");
    expect(result.tier?.name).toBe("Pro");
  });

  it("denies a paid feature not in the company's tier (feature_not_in_tier)", async () => {
    const result = await billing.checkFeatureAccess(wrongTierId, "advanced_agents");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("feature_not_in_tier");

    // But a feature the Starter tier DOES include should pass
    const ok = await billing.checkFeatureAccess(wrongTierId, "audit_logs");
    expect(ok.allowed).toBe(true);
  });

  it("denies paid features when subscription status is not active (subscription_inactive)", async () => {
    const result = await billing.checkFeatureAccess(inactiveId, "advanced_agents");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("subscription_inactive");
  });

  it("denies paid features when cancelAtPeriodEnd and the period has lapsed (canceled_at_period_end)", async () => {
    const result = await billing.checkFeatureAccess(cancelEndedId, "advanced_agents");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("canceled_at_period_end");
  });

  it("retains access when cancelAtPeriodEnd is set but the period is still running", async () => {
    const result = await billing.checkFeatureAccess(cancelActiveId, "advanced_agents");
    expect(result.allowed).toBe(true);
  });

  // ─── requireFeature tests ───────────────────────────────────────────────

  it("requireFeature throws 403 Paywall with code PAYWALL when denied", async () => {
    await expect(billing.requireFeature(freeId, "advanced_agents")).rejects.toMatchObject({
      status: 403,
      code: "PAYWALL",
      details: { featureKey: "advanced_agents" },
    });
  });

  it("requireFeature includes tier name in paywall details for feature_not_in_tier", async () => {
    await expect(billing.requireFeature(wrongTierId, "advanced_agents")).rejects.toMatchObject({
      status: 403,
      code: "PAYWALL",
      details: { featureKey: "advanced_agents", tierName: "Starter" },
    });
  });

  it("requireFeature resolves when access is granted", async () => {
    await expect(billing.requireFeature(paidId, "advanced_agents")).resolves.toMatchObject({
      allowed: true,
    });
  });
});