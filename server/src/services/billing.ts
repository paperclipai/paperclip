import { and, desc, eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import type { Db } from "@paperclipai/db";
import {
  companies as companiesTable,
  subscriptionTiers as subscriptionTiersTable,
  stripeCustomers as stripeCustomersTable,
  companySubscriptions as companySubscriptionsTable,
  subscriptionUsage as subscriptionUsageTable,
  subscriptionInvoices as subscriptionInvoicesTable,
  stripeWebhookEvents as stripeWebhookEventsTable,
} from "@paperclipai/db";
import { ACTIVE_SUBSCRIPTION_STATUSES, FREE_FEATURES } from "@paperclipai/shared";
import { pricingExperimentService, type PricingExperimentService } from "./pricing-experiment.js";
import { badRequest, notFound, paywall, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

/** Max attempts for Stripe API retries in webhook handler contexts. */
const STRIPE_RETRY_MAX_ATTEMPTS = 3;
/** Base delay in ms for exponential backoff (1st retry: 200ms, 2nd: 400ms). */
const STRIPE_RETRY_BASE_DELAY_MS = 200;

/**
 * Wrap a Stripe API call with exponential-backoff retry.
 * Only retries on transient/rate-limit errors (5xx, 429, network).
 * Idempotent callers (our handlers use upserts) can safely retry.
 */
async function withStripeRetry<T>(fn: () => Promise<T>, ctx?: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= STRIPE_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const stripeErr = err as { type?: string; statusCode?: number; code?: string };
      const statusCode = stripeErr?.statusCode;
      const isTransient =
        statusCode === 429 ||
        (statusCode !== undefined && statusCode >= 500) ||
        stripeErr?.type === "StripeConnectionError" ||
        stripeErr?.type === "StripeTimeoutError" ||
        stripeErr?.code === "service_unavailable";

      if (!isTransient || attempt === STRIPE_RETRY_MAX_ATTEMPTS) {
        throw err;
      }

      const delay = STRIPE_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(
        { attempt, maxAttempts: STRIPE_RETRY_MAX_ATTEMPTS, delayMs: delay, ctx },
        "Stripe API call failed — retrying",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr; // unreachable, but satisfies TS
}

export function getStripeClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
  if (!secretKey) {
    throw new Error(
      "STRIPE_SECRET_KEY environment variable is not set. Billing operations are unavailable.",
    );
  }
  return new Stripe(secretKey, {
    apiVersion: "2025-02-24.acacia",
    typescript: true,
  });
}

export function billingService(db: Db, experiment?: PricingExperimentService) {
  const getTier = async (tierId: string) => {
    const tier = await db
      .select()
      .from(subscriptionTiersTable)
      .where(eq(subscriptionTiersTable.id, tierId))
      .then((r) => r[0] ?? null);
    if (!tier) throw notFound("Subscription tier not found");
    return tier;
  };

  /**
   * Seed initial usage metric rows for a new subscription.
   * Idempotent — uses ON CONFLICT DO NOTHING so duplicate calls are safe.
   * Shared between handleSubscriptionUpdated (fallback) and handleCheckoutSessionCompleted
   * to close the TOCTOU race where either handler may create the subscription row first.
   */
  const seedSubscriptionUsageRows = async (
    tx: { execute: Db["execute"] },
    companyId: string,
    stripeSubscriptionId: string,
    periodStart: Date,
    periodEnd: Date,
    tier: { includedSeats: number; includedAgentRuns: number; includedStorageGb: number },
  ) => {
    const usageMetrics: Array<{ metric: string; included: number }> = [
      { metric: "seats", included: tier.includedSeats },
      { metric: "agent_runs", included: tier.includedAgentRuns },
      { metric: "storage_gb", included: tier.includedStorageGb },
    ];

    for (const m of usageMetrics) {
      await tx.execute(sql`
        INSERT INTO "subscription_usage"
          ("company_id", "subscription_id", "metric", "usage", "included",
           "overage", "overage_cents", "period_start", "period_end")
        VALUES (
          ${companyId},
          (SELECT "id" FROM "company_subscriptions" WHERE "stripe_subscription_id" = ${stripeSubscriptionId}),
          ${m.metric}, 0, ${m.included},
          0, 0,
          ${periodStart.toISOString()},
          ${periodEnd.toISOString()}
        )
        ON CONFLICT ("subscription_id", "metric", "period_start", "period_end") DO NOTHING
      `);
    }
  };

  const getOrCreateStripeCustomer = async (companyId: string): Promise<{ id: string; stripeCustomerId: string }> => {
    const stripe = getStripeClient();

    // Fast path: SELECT without contention.
    const existing = await db
      .select()
      .from(stripeCustomersTable)
      .where(eq(stripeCustomersTable.companyId, companyId))
      .then((r) => r[0] ?? null);

    if (existing) {
      return { id: existing.id, stripeCustomerId: existing.stripeCustomerId };
    }

    const company = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .then((r) => r[0] ?? null);
    if (!company) throw notFound("Company not found");

    const customer = await withStripeRetry(
      () => stripe.customers.create({
      name: company.name,
      description: `Paperclip company: ${company.name} (${companyId})`,
      metadata: {
        paperclipCompanyId: companyId,
      },
    }),
      "getOrCreateStripeCustomer:customers.create",
    );

    // INSERT … ON CONFLICT DO NOTHING — if another request won the race,
    // this returns null instead of throwing 23505. The local Stripe customer
    // we just created becomes an orphan (a rare, harmless side-effect).
    const [record] = await db.execute(sql`
      INSERT INTO "stripe_customers"
        ("company_id", "stripe_customer_id")
      VALUES (${companyId}, ${customer.id})
      ON CONFLICT ("company_id") DO NOTHING
      RETURNING "id", "stripe_customer_id"
    `);

    if (record) {
      logger.info({ companyId, stripeCustomerId: customer.id }, "Created Stripe customer");
      return { id: record.id as string, stripeCustomerId: record.stripe_customer_id as string };
    }

    // Another request inserted the row between our SELECT and INSERT.
    // Fetch the winner's record and return it. The Stripe customer created
    // above is orphaned but harmless.
    const winner = await db
      .select()
      .from(stripeCustomersTable)
      .where(eq(stripeCustomersTable.companyId, companyId))
      .then((r) => r[0] ?? null);

    if (!winner) {
      // Should never happen after the CONFLICT above resolved in favour of
      // another session, but be defensive.
      throw new Error("Concurrent Stripe customer creation lost race and no existing record found");
    }

    return { id: winner.id, stripeCustomerId: winner.stripeCustomerId };
  };

  const listInvoices = async (companyId: string) => {
    return db
      .select()
      .from(subscriptionInvoicesTable)
      .where(eq(subscriptionInvoicesTable.companyId, companyId))
      .orderBy(desc(subscriptionInvoicesTable.createdAt));
  };

  const handleInvoicePaid = async (invoice: Stripe.Invoice) => {
    if (!invoice.subscription) return;
    const subId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription.id;

    await db.transaction(async (tx) => {
      const sub = await tx
        .select()
        .from(companySubscriptionsTable)
        .where(eq(companySubscriptionsTable.stripeSubscriptionId, subId))
        .then((r) => r[0] ?? null);

      if (!sub) {
        logger.warn({ stripeSubscriptionId: subId }, "Received invoice for unknown subscription");
        return;
      }

      // Upsert: INSERT ... ON CONFLICT (stripe_invoice_id) DO UPDATE
      // Handles at-least-once delivery from Stripe (race-free with the UNIQUE index)
      await tx.execute(sql`
        INSERT INTO "subscription_invoices"
          ("company_id", "subscription_id", "stripe_invoice_id", "invoice_number", "status",
           "amount_cents", "amount_paid_cents", "amount_remaining_cents", "currency",
           "invoice_pdf_url", "hosted_invoice_url", "period_start", "period_end",
           "created_at", "updated_at")
        VALUES (
          ${sub.companyId}, ${sub.id}, ${invoice.id}, ${invoice.number ?? null}, ${invoice.status ?? "paid"},
          ${invoice.total}, ${invoice.amount_paid}, ${invoice.amount_remaining}, ${invoice.currency},
          ${invoice.invoice_pdf ?? null}, ${invoice.hosted_invoice_url ?? null},
          ${invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null},
          ${invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null},
          NOW(), NOW()
        )
        ON CONFLICT ("stripe_invoice_id") DO UPDATE SET
          "company_id" = EXCLUDED."company_id",
          "subscription_id" = EXCLUDED."subscription_id",
          "invoice_number" = EXCLUDED."invoice_number",
          "status" = EXCLUDED."status",
          "amount_cents" = EXCLUDED."amount_cents",
          "amount_paid_cents" = EXCLUDED."amount_paid_cents",
          "amount_remaining_cents" = EXCLUDED."amount_remaining_cents",
          "currency" = EXCLUDED."currency",
          "invoice_pdf_url" = EXCLUDED."invoice_pdf_url",
          "hosted_invoice_url" = EXCLUDED."hosted_invoice_url",
          "period_start" = EXCLUDED."period_start",
          "period_end" = EXCLUDED."period_end",
          "updated_at" = NOW()
      `);
    });
  };

  const handleInvoicePaymentFailed = async (invoice: Stripe.Invoice) => {
    if (!invoice.subscription) return;
    const subId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription.id;

    await db.transaction(async (tx) => {
      const result = await tx
        .update(companySubscriptionsTable)
        .set({
          status: "past_due",
          updatedAt: new Date(),
        })
        .where(eq(companySubscriptionsTable.stripeSubscriptionId, subId))
        .returning()
        .then((r) => r[0] ?? null);

      logger.warn({ stripeSubscriptionId: subId, invoiceId: invoice.id }, "Subscription payment failed");

      if (result) {
        publishLiveEvent({
          companyId: result.companyId,
          type: "subscription.status.updated",
          payload: {
            status: "past_due",
            stripeSubscriptionId: subId,
            cancelAtPeriodEnd: result.cancelAtPeriodEnd,
            tierId: result.tierId,
          },
        });
      }
    });
  };

  const handleSubscriptionUpdated = async (stripeSub: Stripe.Subscription) => {
    const companyId = stripeSub.metadata?.paperclipCompanyId;
    if (!companyId) {
      logger.warn({ stripeSubscriptionId: stripeSub.id }, "No paperclipCompanyId in subscription metadata");
      return;
    }

    const tierId = stripeSub.metadata?.paperclipTierId;

    await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(companySubscriptionsTable)
        .where(eq(companySubscriptionsTable.stripeSubscriptionId, stripeSub.id))
        .then((r) => r[0] ?? null);

      if (existing) {
        await tx
          .update(companySubscriptionsTable)
          .set({
            status: stripeSub.status,
            currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
            currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
            cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
            updatedAt: new Date(),
            ...(stripeSub.canceled_at ? { canceledAt: new Date(stripeSub.canceled_at * 1000) } : {}),
          })
          .where(eq(companySubscriptionsTable.stripeSubscriptionId, stripeSub.id));
      } else {
        // Subscription was created outside our normal flow (e.g. via Checkout Session)
        // but the checkout.session.completed handler may not have fired yet.
        // Use INSERT ... ON CONFLICT DO UPDATE to handle race between create and update events.
        if (!tierId) {
          logger.warn(
            { stripeSubscriptionId: stripeSub.id, companyId },
            "Cannot create subscription record — no paperclipTierId in metadata",
          );
          return;
        }

        const cust = await tx
          .select()
          .from(stripeCustomersTable)
          .where(eq(stripeCustomersTable.companyId, companyId))
          .then((r) => r[0] ?? null);
        if (!cust) {
          logger.warn(
            { stripeSubscriptionId: stripeSub.id, companyId },
            "Cannot create subscription record — no Stripe customer record",
          );
          return;
        }

        const stripeSubItemId = stripeSub.items.data[0]?.id ?? null;

        await tx.execute(sql`
          INSERT INTO "company_subscriptions"
            ("company_id", "tier_id", "stripe_customer_id", "status", "billing_period",
             "current_period_start", "current_period_end", "stripe_subscription_id",
             "stripe_subscription_item_id", "cancel_at_period_end", "trial_end",
             "created_at", "updated_at")
          VALUES (
            ${companyId}, ${tierId}, ${cust.id}, ${stripeSub.status},
            ${stripeSub.metadata?.billingPeriod ?? "monthly"},
            ${new Date(stripeSub.current_period_start * 1000).toISOString()},
            ${new Date(stripeSub.current_period_end * 1000).toISOString()},
            ${stripeSub.id}, ${stripeSubItemId},
            ${stripeSub.cancel_at_period_end},
            ${stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null},
            NOW(), NOW()
          )
          ON CONFLICT ("stripe_subscription_id") DO UPDATE SET
            "status" = EXCLUDED."status",
            "current_period_start" = EXCLUDED."current_period_start",
            "current_period_end" = EXCLUDED."current_period_end",
            "cancel_at_period_end" = EXCLUDED."cancel_at_period_end",
            "updated_at" = NOW()
        `);

        // Seed usage metrics — closes the TOCTOU race where handleSubscriptionUpdated
        // creates the subscription row before handleCheckoutSessionCompleted runs.
        // Idempotent via ON CONFLICT DO NOTHING.
        const tier = await getTier(tierId);
        await seedSubscriptionUsageRows(
          tx,
          companyId,
          stripeSub.id,
          new Date(stripeSub.current_period_start * 1000),
          new Date(stripeSub.current_period_end * 1000),
          tier,
        );

        logger.info(
          { stripeSubscriptionId: stripeSub.id, companyId, tierId },
          "Created subscription record from Stripe webhook (fallback)",
        );
      }
    });

    logger.info({ stripeSubscriptionId: stripeSub.id, status: stripeSub.status }, "Subscription status synced from Stripe");

    publishLiveEvent({
      companyId,
      type: "subscription.status.updated",
      payload: {
        status: stripeSub.status,
        stripeSubscriptionId: stripeSub.id,
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
        tierId: tierId ?? null,
      },
    });
  };

  const handleSubscriptionDeleted = async (stripeSub: Stripe.Subscription) => {
    const companyId = stripeSub.metadata?.paperclipCompanyId;

    await db.transaction(async (tx) => {
      await tx
        .update(companySubscriptionsTable)
        .set({
          status: "canceled",
          canceledAt: stripeSub.canceled_at ? new Date(stripeSub.canceled_at * 1000) : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(companySubscriptionsTable.stripeSubscriptionId, stripeSub.id));

      logger.info({ stripeSubscriptionId: stripeSub.id }, "Subscription canceled via Stripe");

      if (companyId) {
        publishLiveEvent({
          companyId,
          type: "subscription.status.updated",
          payload: {
            status: "canceled",
            stripeSubscriptionId: stripeSub.id,
            cancelAtPeriodEnd: false,
            tierId: stripeSub.metadata?.paperclipTierId ?? null,
          },
        });
      }
    });
  };

  /**
   * Extract a Stripe customer ID from a field that may be a string (the ID) or an expanded
   * customer object (string | Stripe.Customer | Stripe.DeletedCustomer).
   * Returns null if the value is null/undefined.
   */
  const getStripeCustomerId = (
    customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
  ): string | null => {
    if (!customer) return null;
    return typeof customer === "string" ? customer : customer.id;
  };

  const handleCheckoutSessionCompleted = async (session: Stripe.Checkout.Session) => {
    if (session.mode !== "subscription") return;
    const subId = session.subscription
      ? (typeof session.subscription === "string" ? session.subscription : session.subscription.id)
      : null;
    if (!subId) {
      logger.warn({ sessionId: session.id }, "Checkout session completed without subscription");
      return;
    }

    const companyId = session.metadata?.paperclipCompanyId;
    const tierId = session.metadata?.paperclipTierId;
    const billingPeriod = (session.metadata?.billingPeriod ?? "monthly") as "monthly" | "yearly";

    if (!companyId || !tierId) {
      logger.warn(
        { sessionId: session.id, metadata: session.metadata },
        "Missing required metadata (paperclipCompanyId or paperclipTierId) in checkout session",
      );
      return;
    }

    const stripe = getStripeClient();
    const stripeSub = await withStripeRetry(
      () => stripe.subscriptions.retrieve(subId),
      "handleCheckoutSessionCompleted:subscriptions.retrieve",
    );

    const sessionCustomerId = getStripeCustomerId(session.customer);
    const stripeCustomerId = sessionCustomerId ?? getStripeCustomerId(stripeSub.customer);

    // Use transaction + upsert for idempotent handling of at-least-once Stripe delivery.
    // The UNIQUE index on stripe_subscription_id prevents duplicate rows; the upsert
    // makes the second-and-later deliveries a safe no-op.
    await db.transaction(async (tx) => {
      const cust = await tx
        .select()
        .from(stripeCustomersTable)
        .where(eq(stripeCustomersTable.stripeCustomerId, stripeCustomerId as string))
        .then((r) => r[0] ?? null);

      if (!cust) {
        logger.warn(
          { stripeCustomerId, companyId },
          "No local Stripe customer record found — cannot create subscription",
        );
        return;
      }

      const tier = await getTier(tierId);
      const stripeSubItemId = stripeSub.items.data[0]?.id ?? null;

      // Upsert: INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE
      // Handles at-least-once delivery from Stripe (race-free with the UNIQUE index)
      await tx.execute(sql`
        INSERT INTO "company_subscriptions"
          ("company_id", "tier_id", "stripe_customer_id", "status", "billing_period",
           "current_period_start", "current_period_end", "stripe_subscription_id",
           "stripe_subscription_item_id", "cancel_at_period_end", "trial_end",
           "created_at", "updated_at")
        VALUES (
          ${companyId}, ${tierId}, ${cust.id}, ${stripeSub.status},
          ${billingPeriod},
          ${new Date(stripeSub.current_period_start * 1000).toISOString()},
          ${new Date(stripeSub.current_period_end * 1000).toISOString()},
          ${subId}, ${stripeSubItemId},
          ${stripeSub.cancel_at_period_end},
          ${stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null},
          NOW(), NOW()
        )
        ON CONFLICT ("stripe_subscription_id") DO UPDATE SET
          "status" = EXCLUDED."status",
          "current_period_start" = EXCLUDED."current_period_start",
          "current_period_end" = EXCLUDED."current_period_end",
          "cancel_at_period_end" = EXCLUDED."cancel_at_period_end",
          "updated_at" = NOW()
      `);

      // Seed usage metrics — idempotent via ON CONFLICT DO NOTHING.
      // Shared helper ensures both handleCheckoutSessionCompleted and
      // handleSubscriptionUpdated (fallback) create usage rows, closing the
      // TOCTOU race between the two webhook handlers.
      await seedSubscriptionUsageRows(
        tx,
        companyId,
        subId,
        new Date(stripeSub.current_period_start * 1000),
        new Date(stripeSub.current_period_end * 1000),
        tier,
      );

      logger.info(
        { companyId, tierId, stripeSubscriptionId: subId },
        "Created subscription from Checkout Session",
      );
    });

    publishLiveEvent({
      companyId,
      type: "subscription.status.updated",
      payload: {
        status: stripeSub.status,
        stripeSubscriptionId: subId,
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
        tierId,
      },
    });
  };

  const getSubscriptionInternal = async (companyId: string) => {
    const subscription = await db
      .select()
      .from(companySubscriptionsTable)
      .where(eq(companySubscriptionsTable.companyId, companyId))
      .then((r) => r[0] ?? null);

    if (!subscription) return null;

    const tier = await db
      .select()
      .from(subscriptionTiersTable)
      .where(eq(subscriptionTiersTable.id, subscription.tierId))
      .then((r) => r[0] ?? null);

    const usage = await db
      .select()
      .from(subscriptionUsageTable)
      .where(
        and(
          eq(subscriptionUsageTable.subscriptionId, subscription.id),
          eq(subscriptionUsageTable.periodStart, subscription.currentPeriodStart),
          eq(subscriptionUsageTable.periodEnd, subscription.currentPeriodEnd),
        ),
      );

    return {
      ...subscription,
      tier,
      usage,
    };
  };

  /**
   * Evaluate whether the company's current subscription grants access to a
   * feature key. Pure check — never throws; callers decide how to react.
   *
   * Rules:
   * 1. Free features (FREE_FEATURES) are always allowed.
   * 2. A paid feature requires an active/trialing subscription.
   * 3. If the subscription is scheduled to cancel (cancelAtPeriodEnd) and the
   *    current period has already ended, the company is degraded: paid
   *    features are denied (Stripe keeps the sub "active" until period end).
   * 4. The tier's `features` array must include the requested key.
   */
  const checkFeatureAccess = async (
    companyId: string,
    featureKey: string,
  ) => {
    const subscription = await db
      .select()
      .from(companySubscriptionsTable)
      .where(eq(companySubscriptionsTable.companyId, companyId))
      .then((r) => r[0] ?? null);

    const isFreeFeature = FREE_FEATURES.includes(featureKey as (typeof FREE_FEATURES)[number]);

    if (!subscription) {
      return {
        allowed: isFreeFeature,
        reason: isFreeFeature ? "free_feature" : "no_subscription",
        subscription: null,
        tier: null,
      } as const;
    }

    const tier = await db
      .select()
      .from(subscriptionTiersTable)
      .where(eq(subscriptionTiersTable.id, subscription.tierId))
      .then((r) => r[0] ?? null);

    if (!tier) {
      return {
        allowed: isFreeFeature,
        reason: isFreeFeature ? "free_feature" : "feature_not_in_tier",
        subscription,
        tier: null,
      } as const;
    }

    if (isFreeFeature) {
      return { allowed: true, reason: "free_feature", subscription, tier } as const;
    }

    if (!ACTIVE_SUBSCRIPTION_STATUSES.includes(subscription.status as (typeof ACTIVE_SUBSCRIPTION_STATUSES)[number])) {
      return { allowed: false, reason: "subscription_inactive", subscription, tier } as const;
    }

    // Degradation: cancellation takes effect at period end. Once the paid
    // period has elapsed, paid features are denied even though Stripe may
    // still report the subscription as "active" until it finally cancels.
    if (subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd) {
      const now = new Date();
      if (subscription.currentPeriodEnd.getTime() <= now.getTime()) {
        return { allowed: false, reason: "canceled_at_period_end", subscription, tier } as const;
      }
    }

    const tierFeatures = Array.isArray(tier.features) ? tier.features : [];
    if (tierFeatures.includes(featureKey)) {
      return { allowed: true, reason: "tier_includes_feature", subscription, tier } as const;
    }

    return { allowed: false, reason: "feature_not_in_tier", subscription, tier } as const;
  };

  /**
   * Require feature access for a company, throwing a 403 Paywall error when
   * the feature is not available under the company's current subscription.
   * This is the primary API for route/service-level gating.
   */
  const requireFeature = async (companyId: string, featureKey: string) => {
    const result = await checkFeatureAccess(companyId, featureKey);
    if (result.allowed) return result;

    const tierName = result.tier?.name ?? null;
    const messageByReason: Record<string, string> = {
      no_subscription: "This feature requires an active subscription.",
      subscription_inactive: "Your subscription is not active. Reactivate it to use this feature.",
      canceled_at_period_end: "Your subscription has ended. Renew to keep using this feature.",
      feature_not_in_tier: `This feature is not included in your current plan${tierName ? ` (${tierName})` : ""}.`,
    };

    throw paywall(messageByReason[result.reason ?? "feature_not_in_tier"], {
      featureKey,
      tierName: tierName ?? undefined,
    });
  };

  return {
    listTiers: async (companyId?: string) => {
      const tiers = await db
        .select()
        .from(subscriptionTiersTable)
        .where(eq(subscriptionTiersTable.isActive, true))
        .orderBy(subscriptionTiersTable.sortOrder);

      // Apply A/B pricing experiment overrides when companyId is provided
      if (companyId && experiment) {
        const variant = await experiment.getOrAssignVariant(companyId);
        return experiment.applyTierOverrides(tiers, variant) as typeof tiers;
      }

      return tiers;
    },

    getTier,

    getOrCreateStripeCustomer,

    getSubscription: getSubscriptionInternal,

    checkFeatureAccess,
    requireFeature,

    /** Resolve the A/B pricing experiment variant for a company (exposed for routes). */
    getExperimentVariant: async (companyId: string): Promise<string | null> => {
      if (!experiment) return null;
      return experiment.getOrAssignVariant(companyId);
    },

    /** Get A/B experiment results summary. */
    getExperimentResults: async () => {
      if (!experiment) return null;
      return experiment.getResults();
    },

    createCheckoutSession: async (
      companyId: string,
      data: { tierId: string; billingPeriod: "monthly" | "yearly"; successUrl?: string; cancelUrl?: string },
    ) => {
      const stripe = getStripeClient();
      const tier = await getTier(data.tierId);

      const stripePriceId = data.billingPeriod === "yearly"
        ? (tier.stripePriceYearlyId ?? tier.stripePriceMonthlyId)
        : (tier.stripePriceMonthlyId ?? tier.stripePriceYearlyId);

      if (!stripePriceId) {
        throw unprocessable("Selected tier does not have a Stripe price configured");
      }

      const { stripeCustomerId } = await getOrCreateStripeCustomer(companyId);

      // Resolve experiment variant for metadata tracking
      let experimentVariant: string | undefined;
      if (experiment) {
        experimentVariant = await experiment.getOrAssignVariant(companyId);
      }

      const publicUrl = process.env.PAPERCLIP_PUBLIC_URL ?? "http://localhost:5173";
      const successUrl = data.successUrl ?? `${publicUrl}/boards/${companyId}`;
      const cancelUrl = data.cancelUrl ?? `${publicUrl}/pricing`;

      const session = await withStripeRetry(
        () => stripe.checkout.sessions.create({
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [{ price: stripePriceId, quantity: 1 }],
        metadata: {
          paperclipCompanyId: companyId,
          paperclipTierId: data.tierId,
          billingPeriod: data.billingPeriod,
          ...(experimentVariant ? { pricingExperimentVariant: experimentVariant } : {}),
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
      }),
        "createCheckoutSession:checkout.sessions.create",
      );

      logger.info({ companyId, sessionId: session.id }, "Created Checkout Session");

      return { url: session.url, sessionId: session.id };
    },

    createOrUpdateSubscription: async (
      companyId: string,
      data: { tierId: string; billingPeriod: "monthly" | "yearly" },
    ) => {
      const stripe = getStripeClient();
      const tier = await db
        .select()
        .from(subscriptionTiersTable)
        .where(eq(subscriptionTiersTable.id, data.tierId))
        .then((r) => r[0] ?? null);
      if (!tier) throw notFound("Subscription tier not found");

      if (!tier.stripePriceMonthlyId && !tier.stripePriceYearlyId) {
        throw unprocessable("Selected tier does not have a Stripe price configured");
      }

      const stripePriceId = data.billingPeriod === "yearly"
        ? (tier.stripePriceYearlyId ?? tier.stripePriceMonthlyId)
        : (tier.stripePriceMonthlyId ?? tier.stripePriceYearlyId);

      const { id: stripeCustomerId, stripeCustomerId: stripeCustomerStr } = await getOrCreateStripeCustomer(companyId);

      // ── Transaction with row-level locking prevents TOCTOU races ──
      // The FOR UPDATE lock serialises concurrent requests for this
      // company's subscription row, ensuring a consistent read-write
      // sequence.  The atomic upsert (ON CONFLICT DO UPDATE) inside the
      // transaction is a belt-and-suspenders guard.
      const result = await db.transaction(async (tx) => {
        let stripeSubscription: Stripe.Subscription;
        let stripeSubItemId: string | null = null;
        let isNewSubscriptionRecord = false;

        // Lock the subscription row (or get null if it doesn't exist).
        const existingSub = await tx
          .select()
          .from(companySubscriptionsTable)
          .where(eq(companySubscriptionsTable.companyId, companyId))
          .for("update")
          .then((r) => r[0] ?? null);

        if (existingSub?.stripeSubscriptionId) {
          // ── Update path ──────────────────────────────────────────────
          const sub = await withStripeRetry(
            () => stripe.subscriptions.retrieve(existingSub.stripeSubscriptionId!),
            "createOrUpdateSubscription:subscriptions.retrieve",
          );
          const subscriptionItemId = sub.items.data[0]?.id;

          stripeSubscription = await withStripeRetry(
            () => stripe.subscriptions.update(existingSub.stripeSubscriptionId!, {
              items: subscriptionItemId
                ? [{ id: subscriptionItemId, price: stripePriceId! }]
                : [{ price: stripePriceId! }],
              proration_behavior: "create_prorations",
              metadata: {
                paperclipCompanyId: companyId,
                paperclipTierId: data.tierId,
              },
            }),
            "createOrUpdateSubscription:subscriptions.update",
          );

          stripeSubItemId = stripeSubscription.items.data[0]?.id ?? null;
        } else {
          // ── Create path ────────────────────────────────────────────────
          isNewSubscriptionRecord = true;

          stripeSubscription = await withStripeRetry(
            () => stripe.subscriptions.create({
              customer: stripeCustomerStr,
              items: [{ price: stripePriceId! }],
              metadata: {
                paperclipCompanyId: companyId,
                paperclipTierId: data.tierId,
              },
              proration_behavior: "create_prorations",
            }, {
              // Idempotency key prevents orphan subscriptions when the
              // Stripe API call succeeds but the HTTP response is lost
              // and withStripeRetry retries.
              idempotencyKey: `createOrUpdateSubscription:create:${companyId}:${data.tierId}`,
            }),
            "createOrUpdateSubscription:subscriptions.create",
          );

          stripeSubItemId = stripeSubscription.items.data[0]?.id ?? null;
        }

        // ── Atomic upsert ────────────────────────────────────────────
        const currentPeriodStart = new Date(stripeSubscription.current_period_start * 1000);
        const currentPeriodEnd = new Date(stripeSubscription.current_period_end * 1000);
        const cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end;
        const trialEnd = stripeSubscription.trial_end
          ? new Date(stripeSubscription.trial_end * 1000)
          : null;

        const record = await tx
          .insert(companySubscriptionsTable)
          .values({
            companyId,
            tierId: data.tierId,
            stripeCustomerId,
            status: stripeSubscription.status,
            billingPeriod: data.billingPeriod,
            currentPeriodStart,
            currentPeriodEnd,
            stripeSubscriptionId: stripeSubscription.id,
            stripeSubscriptionItemId: stripeSubItemId,
            cancelAtPeriodEnd,
            trialEnd,
          })
          .onConflictDoUpdate({
            target: companySubscriptionsTable.companyId,
            set: {
              tierId: data.tierId,
              stripeCustomerId,
              status: stripeSubscription.status,
              billingPeriod: data.billingPeriod,
              currentPeriodStart,
              currentPeriodEnd,
              stripeSubscriptionId: stripeSubscription.id,
              stripeSubscriptionItemId: stripeSubItemId,
              cancelAtPeriodEnd,
              trialEnd,
              updatedAt: new Date(),
            },
          })
          .returning()
          .then((r) => r[0]);

        // ── Detect race loss on create path ──────────────────────────
        // If we went through the create path but the upsert updated a row
        // with a different stripeSubscriptionId, another request inserted
        // first.  Cancel our orphan Stripe sub.
        if (isNewSubscriptionRecord && record.stripeSubscriptionId !== stripeSubscription.id) {
          logger.warn(
            { companyId, tierId: data.tierId, ourStripeSubId: stripeSubscription.id, winnerStripeSubId: record.stripeSubscriptionId },
            "createOrUpdateSubscription race lost — another request created the subscription first; cancelling orphan Stripe sub",
          );
          await stripe.subscriptions.cancel(stripeSubscription.id).catch((err) => {
            logger.warn(
              { err, stripeSubscriptionId: stripeSubscription.id },
              "Failed to cancel orphan Stripe subscription (non-fatal)",
            );
          });
        }

        // ── Usage metrics (only for genuinely new subscriptions) ─────
        if (isNewSubscriptionRecord && record.stripeSubscriptionId === stripeSubscription.id) {
          const usageMetrics: Array<{ metric: string; included: number }> = [
            { metric: "seats", included: tier.includedSeats },
            { metric: "agent_runs", included: tier.includedAgentRuns },
            { metric: "storage_gb", included: tier.includedStorageGb },
          ];

          for (const m of usageMetrics) {
            await tx.insert(subscriptionUsageTable).values({
              companyId,
              subscriptionId: record.id,
              metric: m.metric,
              usage: 0,
              included: m.included,
              overage: 0,
              overageCents: 0,
              periodStart: currentPeriodStart,
              periodEnd: currentPeriodEnd,
            });
          }
        }

        return record;
      });

      logger.info(
        { companyId, tierId: data.tierId, stripeSubscriptionId: result.stripeSubscriptionId },
        "Updated subscription",
      );

      publishLiveEvent({
        companyId,
        type: "subscription.status.updated",
        payload: {
          status: result.status,
          stripeSubscriptionId: result.stripeSubscriptionId,
          cancelAtPeriodEnd: result.cancelAtPeriodEnd,
          tierId: data.tierId,
        },
      });

      return result;
    },

    cancelSubscription: async (companyId: string) => {
      const stripe = getStripeClient();

      const subscription = await db
        .select()
        .from(companySubscriptionsTable)
        .where(eq(companySubscriptionsTable.companyId, companyId))
        .then((r) => r[0] ?? null);

      if (!subscription) throw notFound("No active subscription found");
      if (!subscription.stripeSubscriptionId) throw unprocessable("No Stripe subscription to cancel");

      await withStripeRetry(
        () => stripe.subscriptions.update(subscription.stripeSubscriptionId!, {
        cancel_at_period_end: true,
      }),
        "cancelSubscription:subscriptions.update",
      );

      const updated = await db
        .update(companySubscriptionsTable)
        .set({
          cancelAtPeriodEnd: true,
          updatedAt: new Date(),
        })
        .where(eq(companySubscriptionsTable.id, subscription.id))
        .returning()
        .then((r) => r[0]);

      logger.info({ companyId, stripeSubscriptionId: subscription.stripeSubscriptionId }, "Scheduled subscription cancellation");

      publishLiveEvent({
        companyId,
        type: "subscription.status.updated",
        payload: {
          status: subscription.status,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          cancelAtPeriodEnd: true,
          tierId: subscription.tierId,
        },
      });

      return updated;
    },

    reactivateSubscription: async (companyId: string) => {
      const stripe = getStripeClient();

      const subscription = await db
        .select()
        .from(companySubscriptionsTable)
        .where(eq(companySubscriptionsTable.companyId, companyId))
        .then((r) => r[0] ?? null);

      if (!subscription) throw notFound("No active subscription found");
      if (!subscription.stripeSubscriptionId) throw unprocessable("No Stripe subscription to reactivate");
      if (!subscription.cancelAtPeriodEnd) throw unprocessable("Subscription is not scheduled for cancellation");

      await withStripeRetry(
        () => stripe.subscriptions.update(subscription.stripeSubscriptionId!, {
        cancel_at_period_end: false,
      }),
        "reactivateSubscription:subscriptions.update",
      );

      const updated = await db
        .update(companySubscriptionsTable)
        .set({
          cancelAtPeriodEnd: false,
          updatedAt: new Date(),
        })
        .where(eq(companySubscriptionsTable.id, subscription.id))
        .returning()
        .then((r) => r[0]);

      logger.info({ companyId }, "Reactivated subscription");

      publishLiveEvent({
        companyId,
        type: "subscription.status.updated",
        payload: {
          status: subscription.status,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          cancelAtPeriodEnd: false,
          tierId: subscription.tierId,
        },
      });

      return updated;
    },

    reportUsage: async (
      companyId: string,
      data: { metric: "seats" | "agent_runs" | "storage_gb"; quantity: number },
    ) => {
      const subscription = await db
        .select()
        .from(companySubscriptionsTable)
        .where(eq(companySubscriptionsTable.companyId, companyId))
        .then((r) => r[0] ?? null);

      if (!subscription) throw notFound("No active subscription found");
      if (subscription.status !== "active") throw unprocessable("Subscription is not active");

      const periodStart = subscription.currentPeriodStart;
      const periodEnd = subscription.currentPeriodEnd;

      const tier = await getTier(subscription.tierId);
      const includedMap: Record<string, number> = {
        seats: tier.includedSeats,
        agent_runs: tier.includedAgentRuns,
        storage_gb: tier.includedStorageGb,
      };
      const priceMap: Record<string, number> = {
        seats: tier.extraSeatPriceCents,
        agent_runs: tier.extraAgentRunPriceCents,
        storage_gb: tier.extraStorageGbPriceCents,
      };

      const included = includedMap[data.metric] ?? 0;
      const usage = data.quantity;
      const overage = Math.max(0, usage - included);
      const overageCents = overage * (priceMap[data.metric] ?? 0);

      // Upsert — INSERT ... ON CONFLICT handles the read-then-write race.
      // The unique index on (subscription_id, metric, period_start, period_end)
      // prevents duplicate rows; the DO UPDATE makes concurrent calls safe.
      const usageRecord = await db
        .insert(subscriptionUsageTable)
        .values({
          companyId,
          subscriptionId: subscription.id,
          metric: data.metric,
          usage,
          included,
          overage,
          overageCents,
          periodStart,
          periodEnd,
        })
        .onConflictDoUpdate({
          target: [
            subscriptionUsageTable.subscriptionId,
            subscriptionUsageTable.metric,
            subscriptionUsageTable.periodStart,
            subscriptionUsageTable.periodEnd,
          ],
          set: {
            usage,
            overage,
            overageCents,
            updatedAt: new Date(),
          },
        })
        .returning()
        .then((r) => r[0]);

      if (subscription.stripeSubscriptionItemId) {
        try {
          const stripe = getStripeClient();
          await withStripeRetry(
            () => stripe.subscriptionItems.createUsageRecord(
              subscription.stripeSubscriptionItemId!,
              {
                quantity: data.quantity,
                timestamp: Math.floor(Date.now() / 1000),
                action: "set",
              },
            ),
            "reportUsage:subscriptionItems.createUsageRecord",
          );
        } catch (err) {
          logger.warn(
            { err, companyId, metric: data.metric },
            "Failed to report usage to Stripe (non-fatal)",
          );
        }
      }

      return usageRecord;
    },

    getUsage: async (companyId: string) => {
      const subscription = await db
        .select()
        .from(companySubscriptionsTable)
        .where(eq(companySubscriptionsTable.companyId, companyId))
        .then((r) => r[0] ?? null);

      if (!subscription) return [];

      return db
        .select()
        .from(subscriptionUsageTable)
        .where(
          and(
            eq(subscriptionUsageTable.subscriptionId, subscription.id),
            eq(subscriptionUsageTable.periodStart, subscription.currentPeriodStart),
            eq(subscriptionUsageTable.periodEnd, subscription.currentPeriodEnd),
          ),
        );
    },

    listInvoices,

    syncInvoicesFromStripe: async (companyId: string) => {
      const stripe = getStripeClient();
      const subscription = await db
        .select()
        .from(companySubscriptionsTable)
        .where(eq(companySubscriptionsTable.companyId, companyId))
        .then((r) => r[0] ?? null);

      if (!subscription?.stripeSubscriptionId) {
        throw notFound("No subscription with Stripe integration found");
      }

      const stripeInvoices = await withStripeRetry(
        () => stripe.invoices.list({
        subscription: subscription.stripeSubscriptionId!,
        limit: 100,
      }),
        "syncInvoicesFromStripe:invoices.list",
      );

      for (const inv of stripeInvoices.data) {
        // Upsert: INSERT ... ON CONFLICT (stripe_invoice_id) DO UPDATE
        await db.execute(sql`
          INSERT INTO "subscription_invoices"
            ("company_id", "subscription_id", "stripe_invoice_id", "invoice_number", "status",
             "amount_cents", "amount_paid_cents", "amount_remaining_cents", "currency",
             "invoice_pdf_url", "hosted_invoice_url", "period_start", "period_end",
             "created_at", "updated_at")
          VALUES (
            ${companyId}, ${subscription.id}, ${inv.id}, ${inv.number ?? null}, ${inv.status ?? "unknown"},
            ${inv.total}, ${inv.amount_paid}, ${inv.amount_remaining}, ${inv.currency},
            ${inv.invoice_pdf ?? null}, ${inv.hosted_invoice_url ?? null},
            ${inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null},
            ${inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null},
            NOW(), NOW()
          )
          ON CONFLICT ("stripe_invoice_id") DO UPDATE SET
            "company_id" = EXCLUDED."company_id",
            "subscription_id" = EXCLUDED."subscription_id",
            "invoice_number" = EXCLUDED."invoice_number",
            "status" = EXCLUDED."status",
            "amount_cents" = EXCLUDED."amount_cents",
            "amount_paid_cents" = EXCLUDED."amount_paid_cents",
            "amount_remaining_cents" = EXCLUDED."amount_remaining_cents",
            "currency" = EXCLUDED."currency",
            "invoice_pdf_url" = EXCLUDED."invoice_pdf_url",
            "hosted_invoice_url" = EXCLUDED."hosted_invoice_url",
            "period_start" = EXCLUDED."period_start",
            "period_end" = EXCLUDED."period_end",
            "updated_at" = NOW()
        `);
      }

      return listInvoices(companyId);
    },

    handleWebhook: async (rawBody: string, signature: string) => {
      if (!STRIPE_WEBHOOK_SECRET) {
        throw badRequest(
          "STRIPE_WEBHOOK_SECRET is not configured. Webhook signature verification is unavailable.",
        );
      }
      // Create a minimal Stripe client for signature verification only.
      // constructEvent() does not need the secret API key, only the webhook secret.
      const stripe = new Stripe("«redacted:sk_…»", {
        apiVersion: "2025-02-24.acacia",
      });
      let event: Stripe.Event;

      try {
        // Local signature verification only — no outbound API call; does not need withStripeRetry.
        event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown webhook error";
        throw badRequest(`Webhook signature verification failed: ${message}`);
      }

      logger.info({ type: event.type, id: event.id }, "Processing Stripe webhook event");

      switch (event.type) {
        case "invoice.paid":
        case "invoice.payment_succeeded": {
          const invoice = event.data.object as Stripe.Invoice;
          await handleInvoicePaid(invoice);
          break;
        }
        case "invoice.payment_failed": {
          const failedInvoice = event.data.object as Stripe.Invoice;
          await handleInvoicePaymentFailed(failedInvoice);
          break;
        }
        case "customer.subscription.updated": {
          const sub = event.data.object as Stripe.Subscription;
          await handleSubscriptionUpdated(sub);
          break;
        }
        case "customer.subscription.deleted": {
          const deletedSub = event.data.object as Stripe.Subscription;
          await handleSubscriptionDeleted(deletedSub);
          break;
        }
        case "customer.subscription.created": {
          const createdSub = event.data.object as Stripe.Subscription;
          await handleSubscriptionUpdated(createdSub);
          break;
        }
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          await handleCheckoutSessionCompleted(session);
          break;
        }
        case "customer.subscription.trial_will_end":
          break;
        default:
          logger.info({ type: event.type }, "Unhandled Stripe webhook event type");
      }

      // Event-level dedup: record the event AFTER successful processing.
      // If the handler threw, the event is NOT recorded — Stripe's at-least-once
      // delivery will retry and the handler will run again.  Each handler is
      // idempotent (upsert-based), so replay is safe.
      try {
        await db.insert(stripeWebhookEventsTable).values({
          stripeEventId: event.id,
          eventType: event.type,
        });
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr?.code === "23505") {
          logger.info(
            { type: event.type, id: event.id },
            "Duplicate Stripe webhook event — skipping (already processed)",
          );
          return { received: true, type: event.type };
        }
        throw err;
      }

      return { received: true, type: event.type };
    },

    handleInvoicePaid,
    handleInvoicePaymentFailed,
    handleSubscriptionUpdated,
    handleSubscriptionDeleted,
    handleCheckoutSessionCompleted,

    getBillingOverview: async (companyId: string) => {
      const subscription = await getSubscriptionInternal(companyId);
      const invoices = await listInvoices(companyId);

      const totalSpentResult = await db
        .select({
          total: sql<number>`coalesce(sum(${subscriptionInvoicesTable.amountPaidCents}), 0)::int`,
        })
        .from(subscriptionInvoicesTable)
        .where(
          and(
            eq(subscriptionInvoicesTable.companyId, companyId),
            eq(subscriptionInvoicesTable.status, "paid"),
          ),
        )
        .then((r) => r[0] ?? null);

      return {
        companyId,
        subscription,
        invoices,
        usage: subscription?.usage ?? [],
        totalSpentCents: Number(totalSpentResult?.total ?? 0),
      };
    },
  };
}