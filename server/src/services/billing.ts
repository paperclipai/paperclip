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
import { companySubscriptions, projects, companies, libraryFiles, playbookRuns } from "@ironworksai/db";
import { gte, and } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Plan tier definitions
// ---------------------------------------------------------------------------

export type PlanTier = "starter" | "growth" | "business";
export type SubscriptionStatus = "active" | "past_due" | "cancelled" | "incomplete";

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
// Webhook idempotency guard (SEC-LOGIC-001)
// In-memory Map with 24-hour TTL. Prevents duplicate Polar events from
// re-activating cancelled subscriptions or racing on tier changes.
// A production deployment should persist this to the database instead.
// ---------------------------------------------------------------------------

interface IdempotencyEntry {
  processedAt: number; // Date.now() ms
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const processedWebhookEvents = new Map<string, IdempotencyEntry>();

function pruneExpiredIdempotencyEntries(): void {
  const now = Date.now();
  for (const [key, entry] of processedWebhookEvents) {
    if (now - entry.processedAt > IDEMPOTENCY_TTL_MS) {
      processedWebhookEvents.delete(key);
    }
  }
}

function isEventAlreadyProcessed(eventId: string): boolean {
  const entry = processedWebhookEvents.get(eventId);
  if (!entry) return false;
  // Treat expired entries as unprocessed (prune will clean them up)
  if (Date.now() - entry.processedAt > IDEMPOTENCY_TTL_MS) {
    processedWebhookEvents.delete(eventId);
    return false;
  }
  return true;
}

function markEventProcessed(eventId: string): void {
  pruneExpiredIdempotencyEntries();
  processedWebhookEvents.set(eventId, { processedAt: Date.now() });
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

    const rows = await db
      .insert(companySubscriptions)
      .values({ companyId })
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
    // SEC-LOGIC-001: Idempotency guard — skip events we have already processed.
    const eventId = event.data.id as string | undefined;
    if (eventId) {
      if (isEventAlreadyProcessed(eventId)) {
        logger.debug({ eventId, eventType: event.type }, "Skipping duplicate Polar webhook event");
        return;
      }
    }

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

      case "subscription.canceled": {
        // SEC-LOGIC-002: Honor currentPeriodEnd — keep status active with
        // cancelAtPeriodEnd flag so the customer retains access until the
        // billing period they already paid for expires. The hard revocation
        // happens on subscription.revoked (Polar fires this at period end).
        const data = event.data as Record<string, unknown>;
        const metadata = (data.metadata ?? {}) as Record<string, string>;
        const companyId = metadata.ironworksCompanyId;
        if (!companyId) {
          logger.warn("subscription.canceled missing ironworksCompanyId metadata");
          return;
        }
        await db
          .update(companySubscriptions)
          .set({
            status: "active",
            cancelAtPeriodEnd: true,
            currentPeriodEnd: data.current_period_end
              ? new Date(data.current_period_end as string)
              : null,
            updatedAt: new Date(),
          })
          .where(eq(companySubscriptions.companyId, companyId));
        logger.info({ companyId }, "Subscription marked cancel-at-period-end via Polar");
        break;
      }

      case "subscription.revoked": {
        // Hard revocation: period has ended or subscription was force-terminated.
        // Strip access immediately.
        const data = event.data as Record<string, unknown>;
        const metadata = (data.metadata ?? {}) as Record<string, string>;
        const companyId = metadata.ironworksCompanyId;
        if (!companyId) {
          logger.warn("subscription.revoked missing ironworksCompanyId metadata");
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
        logger.info({ companyId }, "Subscription revoked via Polar — access removed");
        break;
      }

      default:
        logger.debug({ eventType: event.type }, "Unhandled Polar webhook event");
    }

    // SEC-LOGIC-001: Mark the event as successfully processed so re-deliveries
    // from Polar are safely ignored within the 24-hour TTL window.
    if (eventId) {
      markEventProcessed(eventId);
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

  async function getPlaybookRunCount(companyId: string): Promise<number> {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const rows = await db
      .select()
      .from(playbookRuns)
      .where(and(
        eq(playbookRuns.companyId, companyId),
        gte(playbookRuns.createdAt, startOfMonth),
      ));
    return rows.length;
  }

  async function getCompanyCount(_userId: string): Promise<number> {
    // SEC-INTEG-006: Count actual companies. In local_trusted mode all
    // companies are visible; in authenticated mode this should query
    // the user-company membership table. For now, count all companies
    // as a safe upper bound — prevents unlimited company creation.
    const rows = await db.select().from(companies);
    return rows.length;
  }

  return {
    getSubscription,
    getOrCreateSubscription,
    createCheckoutSession,
    createCustomerPortalSession,
    handleWebhook,
    getProjectCount,
    getPlaybookRunCount,
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
    case "incomplete":
      return "incomplete";
    default:
      return "incomplete";
  }
}

// Maximum age of a webhook event before we reject it (replay-attack prevention).
const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Verify a Polar webhook signature (Standard Webhooks / Svix format).
 *
 * Standard Webhooks signs: "${webhook-id}.${webhook-timestamp}.${rawBody}"
 * The secret is base64-encoded with a "whsec_" prefix in the env var.
 *
 * Headers required:
 *   webhook-id        (or svix-id)
 *   webhook-timestamp (or svix-timestamp) — Unix seconds as a string
 *   webhook-signature (or svix-signature) — "v1,<base64sig>" (space-separated for multiple)
 *
 * Returns the parsed event or throws on any verification failure.
 */
export function verifyPolarWebhookSignature(
  rawBody: Buffer,
  headers: {
    webhookId: string;
    webhookTimestamp: string;
    webhookSignature: string;
  },
): PolarWebhookEvent {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("POLAR_WEBHOOK_SECRET is not configured");
  }

  const { webhookId, webhookTimestamp, webhookSignature } = headers;

  // --- 1. Timestamp staleness check (SEC-INTEG-001: replay attack prevention) ---
  const tsSeconds = parseInt(webhookTimestamp, 10);
  if (!Number.isFinite(tsSeconds)) {
    throw new Error("Invalid webhook-timestamp header");
  }
  const tsMs = tsSeconds * 1000;
  const nowMs = Date.now();
  if (Math.abs(nowMs - tsMs) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
    throw new Error(
      `Webhook timestamp is too old or too far in the future (age: ${Math.round((nowMs - tsMs) / 1000)}s)`,
    );
  }

  // --- 2. Decode the signing key ---
  // Polar / Standard Webhooks stores the secret as "whsec_<base64>".
  // Strip the prefix and base64-decode to obtain the raw key bytes.
  const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let keyBytes: Buffer;
  try {
    keyBytes = Buffer.from(rawSecret, "base64");
  } catch {
    throw new Error("Failed to decode POLAR_WEBHOOK_SECRET — expected base64 after 'whsec_' prefix");
  }

  // --- 3. Build the signed payload ---
  // Standard Webhooks: "${webhook-id}.${webhook-timestamp}.${rawBody}"
  const bodyString = rawBody.toString("utf-8");
  const signedPayload = `${webhookId}.${webhookTimestamp}.${bodyString}`;

  // --- 4. Compute expected HMAC-SHA256 ---
  const hmac = createHmac("sha256", keyBytes);
  hmac.update(signedPayload);
  const expectedSig = hmac.digest("base64");
  const expectedBuf = Buffer.from(expectedSig, "base64");

  // --- 5. Compare against all provided signatures ---
  // The header may contain multiple space-separated "v1,<sig>" tokens.
  const signatureTokens = webhookSignature.split(" ");
  const valid = signatureTokens.some((token) => {
    // Each token is "v1,<base64sig>" — strip the version prefix.
    const commaIdx = token.indexOf(",");
    const sigB64 = commaIdx >= 0 ? token.slice(commaIdx + 1) : token;
    try {
      const sigBuf = Buffer.from(sigB64.trim(), "base64");
      return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  });

  if (!valid) {
    throw new Error("Invalid Polar webhook signature");
  }

  return JSON.parse(bodyString) as PolarWebhookEvent;
}
