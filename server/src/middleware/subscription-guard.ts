import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySubscriptions } from "@paperclipai/db";
import { HttpError } from "../errors.js";

export type SubscriptionStatus = {
  status: string;
  trialEndsAt: Date | null;
  canWrite: boolean;
};

/**
 * Look up the subscription status for a company. Returns null if no
 * subscription record exists (self-hosted free tier).
 * Also lazily transitions "trialing" → "trial_expired" when the trial window has passed.
 */
export async function getSubscriptionStatus(
  db: Db,
  companyId: string,
): Promise<SubscriptionStatus | null> {
  const sub = await db
    .select({
      status: companySubscriptions.status,
      trialEndsAt: companySubscriptions.trialEndsAt,
    })
    .from(companySubscriptions)
    .where(eq(companySubscriptions.companyId, companyId))
    .then((rows) => rows[0]);

  if (!sub) return null; // No subscription = self-hosted free tier

  // Lazy trial expiry transition
  if (
    sub.status === "trialing" &&
    sub.trialEndsAt &&
    new Date(sub.trialEndsAt) <= new Date()
  ) {
    await db
      .update(companySubscriptions)
      .set({ status: "trial_expired", updatedAt: new Date() })
      .where(eq(companySubscriptions.companyId, companyId));

    return { status: "trial_expired", trialEndsAt: sub.trialEndsAt, canWrite: false };
  }

  const canWrite = ["active", "trialing", "free", "past_due"].includes(sub.status);

  return {
    status: sub.status,
    trialEndsAt: sub.trialEndsAt,
    canWrite,
  };
}

/**
 * Throws a 402 HttpError if the company's subscription does not allow
 * write operations. Read access is always allowed.
 * Call this before any mutating endpoint (create, update, delete).
 */
export async function assertWriteAccess(db: Db, companyId: string): Promise<void> {
  const sub = await getSubscriptionStatus(db, companyId);
  if (!sub) return; // Self-hosted free tier — no restrictions
  if (sub.canWrite) return;

  const code =
    sub.status === "trial_expired"
      ? "TRIAL_EXPIRED"
      : sub.status === "canceled"
        ? "SUBSCRIPTION_CANCELED"
        : "SUBSCRIPTION_INACTIVE";

  const message =
    sub.status === "trial_expired"
      ? "Your 14-day free trial has ended. Subscribe to continue."
      : sub.status === "canceled"
        ? "Your subscription has been canceled. Resubscribe to continue."
        : "Subscription is not active. Please update your billing.";

  throw new HttpError(402, message, { code, canRead: true, canWrite: false });
}
