/**
 * Polar Billing Service for IronWorks subscription management.
 *
 * Polar is a Merchant of Record — handles all tax, VAT, and invoicing.
 *
 * Required environment variables:
 *   POLAR_ACCESS_TOKEN=polar_...             # From Polar Dashboard -> Settings -> API
 *   POLAR_ORGANIZATION_ID=org_...            # From Polar Dashboard -> Organization
 *   POLAR_STARTER_PRODUCT_ID=prod_...        # Create in Polar Dashboard -> Products
 *   POLAR_GROWTH_PRODUCT_ID=prod_...         # Create in Polar Dashboard -> Products
 *   POLAR_BUSINESS_PRODUCT_ID=prod_...       # Create in Polar Dashboard -> Products
 *   POLAR_WEBHOOK_SECRET=whsec_...           # From Polar Dashboard -> Webhooks
 */

import { eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "crypto";
import type { Db } from "@ironworksai/db";
import { companySubscriptions, projects, companies, libraryFiles } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Plan tier definitions
// ---------------------------------------------------------------------------

export type PlanTier = "trial" | "starter" | "growth" | "business";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled" | "incomplete";

export interface PlanDefinition {
  productId: string | undefined;
  projects: number; // -1 = unlimited
  storageGB: number;
  companies: number;
  playbookRuns: number; // -1 = unlimited
  kbPages: number; // -1 = unlimited
  priceMonthly: number; // cents
  label: string;
}

export const PLAN_DEFINITIONS: Record<PlanTier, PlanDefinition> = {
  trial: {
    productId: undefined,
    projects: 1,
    storageGB: 0.5,
    companies: 1,
    playbookRuns: 5,
    kbPages: 5,
    priceMonthly: 0,
    label: "14-Day Trial",
  },
  starter: {
    productId: process.env.POLAR_STARTER_PRODUCT_ID,
    projects: 5,
    storageGB: 5,
    companies: 1,
    playbookRuns: 50,
    kbPages: 50,
    priceMonthly: 7900,
    label: "Starter",
  },
  growth: {
    productId: process.env.POLAR_GROWTH_PRODUCT_ID,
    projects: 25,
    storageGB: 15,
    companies: 2,
    playbookRuns: -1,
    kbPages: -1,
    priceMonthly: 19900,
    label: "Growth",
  },
  business: {
    productId: process.env.POLAR_BUSINESS_PRODUCT_ID,
    projects: -1,
    storageGB: 50,
    companies: 5,
    playbookRuns: -1,
    kbPages: -1,
    priceMonthly: 59900,
    label: "Business",
  },
};

// ---------------------------------------------------------------------------
// Polar API helpers (REST-based, no SDK needed)
// ---------------------------------------------------------------------------

const POLAR_API_BASE = "https://api.polar.sh/v1";

function getPolarToken(): string {
  const token = process.env.POLAR_ACCESS_TOKEN;
  if (!token) {
    throw new Error("POLAR_ACCESS_TOKEN is not configured");
  }
  return token;
}

async function polarFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getPolarToken();
  const url = `${POLAR_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Polar API error ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Polar webhook event types
// ---------------------------------------------------------------------------

export interface PolarWebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Subscription record helpers
// ---------------------------------------------------------------------------

export interface SubscriptionRecord {
  id: string;
  companyId: string;
  polarCustomerId: string | null;
  polarSubscriptionId: string | null;
  planTier: PlanTier;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function rowToRecord(row: typeof companySubscriptions.$inferSelect): SubscriptionRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    polarCustomerId: row.polarCustomerId,
    polarSubscriptionId: row.polarSubscriptionId,
    planTier: row.planTier as PlanTier,
    status: row.status as SubscriptionStatus,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    trialEndsAt: row.trialEndsAt,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Map Polar product ID back to plan tier
// ---------------------------------------------------------------------------

function productIdToTier(productId: string): PlanTier {
  for (const [tier, def] of Object.entries(PLAN_DEFINITIONS)) {
    if (def.productId && def.productId === productId) {
      return tier as PlanTier;
    }
  }
  return "starter"; // fallback
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function billingService(db: Db) {
  async function getSubscription(companyId: string): Promise<SubscriptionRecord | null> {
    const rows = await db
      .select()
      .from(companySubscriptions)
      .where(eq(companySubscriptions.companyId, companyId));
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async function getOrCreateSubscription(companyId: string): Promise<SubscriptionRecord> {
    const existing = await getSubscription(companyId);
    if (existing) return existing;

    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const rows = await db
      .insert(companySubscriptions)
      .values({ companyId, trialEndsAt })
      .onConflictDoNothing()
      .returning();

    if (rows[0]) return rowToRecord(rows[0]);
    // Race: another request inserted first
    const recheck = await getSubscription(companyId);
    if (!recheck) throw new Error("Failed to create subscription record");
    return recheck;
  }

  async function createCheckoutSession(
    companyId: string,
    planTier: PlanTier,
    successUrl: string,
    _cancelUrl: string,
  ): Promise<string> {
    const plan = PLAN_DEFINITIONS[planTier];
    if (!plan.productId) {
      throw new Error(`No Polar product configured for plan: ${planTier}`);
    }

    const sub = await getOrCreateSubscription(companyId);

    // Fetch company email for the checkout
    const companyRows = await db.select().from(companies).where(eq(companies.id, companyId));
    const companyName = companyRows[0]?.name ?? "IronWorks Company";

    const checkout = await polarFetch<{ url: string; id: string }>(
      "/checkouts/custom",
      {
        method: "POST",
        body: JSON.stringify({
          product_id: plan.productId,
          success_url: successUrl,
          metadata: { ironworksCompanyId: companyId, planTier },
          ...(sub.polarCustomerId
            ? { customer_id: sub.polarCustomerId }
            : { customer_name: companyName }),
        }),
      },
    );

    if (!checkout.url) {
      throw new Error("Polar did not return a checkout URL");
    }
    return checkout.url;
  }

  async function createCustomerPortalSession(
    companyId: string,
    _returnUrl: string,
  ): Promise<string> {
    const sub = await getSubscription(companyId);
    if (!sub?.polarCustomerId) {
      throw new Error("No Polar customer found for this company");
    }

    // Polar provides a hosted customer portal via their API
    const portal = await polarFetch<{ url: string }>(
      `/customers/${sub.polarCustomerId}/portal`,
      { method: "POST" },
    );
    return portal.url;
  }

  async function handleWebhook(event: PolarWebhookEvent): Promise<void> {
    switch (event.type) {
      case "checkout.created": {
        // A checkout was created — we can track it but no subscription yet
        logger.debug({ checkoutId: event.data.id }, "Polar checkout created");
        break;
      }

      case "subscription.active": {
        // Subscription has become active (initial activation or renewal)
        const data = event.data as Record<string, unknown>;
        const metadata = (data.metadata ?? {}) as Record<string, string>;
        const companyId = metadata.ironworksCompanyId;
        if (!companyId) {
          logger.warn("subscription.active missing ironworksCompanyId metadata");
          return;
        }

        const polarSubscriptionId = data.id as string;
        const polarCustomerId = (data.customer_id ?? data.customer) as string | null;
        const productId = data.product_id as string | undefined;
        const planTier = productId ? productIdToTier(productId) : (metadata.planTier as PlanTier ?? "starter");

        await getOrCreateSubscription(companyId);
        await db
          .update(companySubscriptions)
          .set({
            polarCustomerId: polarCustomerId ?? undefined,
            polarSubscriptionId,
            planTier,
            status: "active",
            currentPeriodStart: data.current_period_start ? new Date(data.current_period_start as string) : null,
            currentPeriodEnd: data.current_period_end ? new Date(data.current_period_end as string) : null,
            updatedAt: new Date(),
          })
          .where(eq(companySubscriptions.companyId, companyId));
        logger.info({ companyId, planTier }, "Subscription activated via Polar");
        break;
      }

      case "subscription.updated": {
        const data = event.data as Record<string, unknown>;
        const metadata = (data.metadata ?? {}) as Record<string, string>;
        const companyId = metadata.ironworksCompanyId;
        if (!companyId) {
          logger.warn("subscription.updated missing ironworksCompanyId metadata");
          return;
        }
        const productId = data.product_id as string | undefined;
        const planTier = productId ? productIdToTier(productId) : (metadata.planTier as PlanTier ?? "starter");
        const status = mapPolarStatus(data.status as string);

        await db
          .update(companySubscriptions)
          .set({
            planTier,
            status,
            currentPeriodStart: data.current_period_start ? new Date(data.current_period_start as string) : null,
            currentPeriodEnd: data.current_period_end ? new Date(data.current_period_end as string) : null,
            cancelAtPeriodEnd: (data.cancel_at_period_end as boolean) ?? false,
            updatedAt: new Date(),
          })
          .where(eq(companySubscriptions.companyId, companyId));
        logger.info({ companyId, planTier, status }, "Subscription updated via Polar");
        break;
      }

      case "subscription.canceled":
      case "subscription.revoked": {
        const data = event.data as Record<string, unknown>;
        const metadata = (data.metadata ?? {}) as Record<string, string>;
        const companyId = metadata.ironworksCompanyId;
        if (!companyId) {
          logger.warn(`${event.type} missing ironworksCompanyId metadata`);
          return;
        }
        await db
          .update(companySubscriptions)
          .set({
            status: "cancelled",
            cancelAtPeriodEnd: false,
            updatedAt: new Date(),
          })
          .where(eq(companySubscriptions.companyId, companyId));
        logger.info({ companyId }, `Subscription ${event.type} via Polar`);
        break;
      }

      default:
        logger.debug({ eventType: event.type }, "Unhandled Polar webhook event");
    }
  }

  // -------------------------------------------------------------------------
  // Usage checks for tier enforcement
  // -------------------------------------------------------------------------

  async function getProjectCount(companyId: string): Promise<number> {
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.companyId, companyId));
    return rows.length;
  }

  async function getStorageUsageBytes(companyId: string): Promise<number> {
    const rows = await db
      .select()
      .from(libraryFiles)
      .where(eq(libraryFiles.companyId, companyId));
    return rows.reduce<number>((sum, f) => sum + (f.sizeBytes ?? 0), 0);
  }

  async function getCompanyCount(userId: string): Promise<number> {
    // For now return 1 — multi-company counting requires membership table query
    // which depends on the auth mode. Placeholder for enterprise tier check.
    void userId;
    return 1;
  }

  return {
    getSubscription,
    getOrCreateSubscription,
    createCheckoutSession,
    createCustomerPortalSession,
    handleWebhook,
    getProjectCount,
    getStorageUsageBytes,
    getCompanyCount,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapPolarStatus(polarStatus: string): SubscriptionStatus {
  switch (polarStatus) {
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
    case "revoked":
      return "cancelled";
    case "trialing":
      return "trialing";
    case "incomplete":
      return "incomplete";
    default:
      return "trialing";
  }
}

/**
 * Verify a Polar webhook signature. Returns the parsed event or throws.
 *
 * Polar signs webhooks with HMAC-SHA256. The signature is in the
 * `webhook-signature` header. Format: "v1,<timestamp>.<signature>"
 */
export function verifyPolarWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
): PolarWebhookEvent {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("POLAR_WEBHOOK_SECRET is not configured");
  }

  // Polar webhook-signature format: "v1,<base64-signature>"
  // The signed payload is "<webhook-id>.<webhook-timestamp>.<body>"
  // But the standard Polar webhook uses the Standard Webhooks format.
  // We verify using the raw body and the provided signature.
  const parts = signatureHeader.split(",");
  if (parts.length < 2) {
    throw new Error("Invalid Polar webhook signature format");
  }

  // Standard Webhooks verification
  const signatures = parts.slice(1); // skip "v1" prefix marker if present
  const sigTimestamp = signatureHeader; // full header for logging

  // Compute expected signature
  const hmac = createHmac("sha256", secret);
  hmac.update(rawBody);
  const expectedSig = hmac.digest("base64");

  // Check if any provided signature matches
  const valid = signatures.some((sig) => {
    try {
      const sigBuf = Buffer.from(sig.trim(), "base64");
      const expectedBuf = Buffer.from(expectedSig, "base64");
      return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  });

  if (!valid) {
    throw new Error("Invalid Polar webhook signature");
  }

  return JSON.parse(rawBody.toString("utf-8")) as PolarWebhookEvent;
}
