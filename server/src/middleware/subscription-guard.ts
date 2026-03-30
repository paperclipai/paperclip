import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySubscriptions, agents, heartbeatRuns, agentWakeupRequests } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logger } from "./logger.js";

export type SubscriptionStatus = {
  status: string;
  trialEndsAt: Date | null;
  canWrite: boolean;
};

/**
 * Look up the subscription status for a company. Returns null if no
 * subscription record exists (self-hosted free tier).
 * Also lazily transitions "trialing" → "trial_expired" when the trial window has passed,
 * and pauses all agents + cancels active runs when this happens.
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

    // Pause all agents and cancel active runs (async, don't block the request)
    void pauseCompanyAgents(db, companyId).catch((err) => {
      logger.error({ err, companyId }, "Failed to pause agents on trial expiry");
    });

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

/**
 * Pause all running/idle agents in a company and cancel active heartbeat runs.
 * Called when a trial expires or subscription is canceled.
 */
async function pauseCompanyAgents(db: Db, companyId: string): Promise<void> {
  const now = new Date();

  // Pause all non-terminated agents
  const paused = await db
    .update(agents)
    .set({
      status: "paused",
      pauseReason: "system",
      pausedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(agents.companyId, companyId),
        inArray(agents.status, ["idle", "running"]),
      ),
    )
    .returning({ id: agents.id });

  // Cancel all queued and running heartbeat runs
  await db
    .update(heartbeatRuns)
    .set({ status: "cancelled", updatedAt: now })
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ),
    );

  // Detach wakeup requests from heartbeat runs
  await db
    .update(heartbeatRuns)
    .set({ wakeupRequestId: null })
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        isNotNull(heartbeatRuns.wakeupRequestId),
      ),
    );

  // Delete pending wakeup requests
  await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));

  if (paused.length > 0) {
    logger.info(
      { companyId, pausedAgents: paused.length },
      "Paused agents due to subscription expiry",
    );
  }
}
