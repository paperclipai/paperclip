import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ApplyDeps } from "./apply.js";
import type { BillingConfig } from "./config.js";
import type { SubscriptionRow } from "./domain.js";
import { addDaysIso, expectedStanding } from "./state-machine.js";
import { applyStandingCommand } from "./standing.js";

/** Pure creation matrix (spec §6.1). */
export function initialSubscription(
  input: { id: string; companyId: string; ownerUserId: string; ownerHadTrial: boolean; priceCentsOverride?: number | null },
  config: BillingConfig,
  now: Date,
): SubscriptionRow {
  const nowIso = now.toISOString();
  const priceCentsOverride = input.priceCentsOverride ?? null;

  let status: SubscriptionRow["status"];
  let trialEndsAt: string | null = null;
  if (priceCentsOverride === 0) {
    status = "complimentary";
  } else {
    const trialAllowed = config.trialDays > 0
      && (config.trialPolicy === "every-company"
        || (config.trialPolicy === "first-company-per-owner" && !input.ownerHadTrial));
    if (trialAllowed) {
      status = "trialing";
      trialEndsAt = addDaysIso(nowIso, config.trialDays);
    } else {
      status = "awaiting_payment";
    }
  }

  return {
    id: input.id,
    companyId: input.companyId,
    ownerUserId: input.ownerUserId,
    customerId: null,
    status,
    trialEndsAt,
    graceSince: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    priceCentsOverride,
    providerSubscriptionId: null,
    openCheckoutSessionRef: null,
    openCheckoutUrl: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Detects the unique-violation raised by a concurrent insertSubscription for
 * the same company, across both store adapters:
 * - MemoryBillingStore throws a plain Error("duplicate subscription for company <id>"),
 * - SqlBillingStore lets the Postgres unique-violation (company_id UNIQUE) surface
 *   as-is, possibly wrapped in a driver error with a `.cause` chain — so walk it
 *   looking for code "23505".
 * Kept narrow: anything else is rethrown by the caller.
 */
function isDuplicateSubscriptionError(error: unknown, companyId: string): boolean {
  if (error instanceof Error && error.message.includes(`duplicate subscription for company ${companyId}`)) {
    return true;
  }
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const maybe = current as { code?: string; cause?: unknown };
    if (maybe.code === "23505") return true;
    current = maybe.cause;
  }
  return false;
}

export interface OwnerResolver {
  resolveOwnerUserId(companyId: string): Promise<string>;
}

/**
 * Owner = active `user` membership with membershipRole "owner"
 * (created by the company-create route), falling back to
 * company.defaultResponsibleUserId, then "local-board" (local_trusted mode).
 */
export function ownerResolverFromContext(ctx: PluginContext): OwnerResolver {
  return {
    async resolveOwnerUserId(companyId: string): Promise<string> {
      try {
        const members = await ctx.access.members.list({ companyId });
        const owner = members.find(
          (member) => member.principalType === "user" && member.membershipRole === "owner" && member.status === "active",
        );
        if (owner) return owner.principalId;
      } catch {
        // access read unavailable — fall through to company metadata
      }
      const company = await ctx.companies.get(companyId);
      return company?.defaultResponsibleUserId ?? "local-board";
    },
  };
}

/**
 * Rowless-company pickup, used by both the company.created event handler and
 * the sweep (event-loss safety). Idempotent per company.
 */
export async function ensureSubscriptionForCompany(
  deps: ApplyDeps & { owners: OwnerResolver },
  companyId: string,
): Promise<SubscriptionRow> {
  const existing = await deps.store.getSubscriptionByCompany(companyId);
  if (existing) return existing;

  const now = deps.now();
  const ownerUserId = await deps.owners.resolveOwnerUserId(companyId);
  const ownerHadTrial = await deps.store.ownerHadTrial(ownerUserId);
  const sub = initialSubscription({ id: randomUUID(), companyId, ownerUserId, ownerHadTrial }, deps.config, now);

  try {
    await deps.store.insertSubscription(sub);
  } catch (error) {
    // Check-then-act race: another caller (event handler vs. sweep, or two
    // concurrent sweeps) won the insert between our lookup and now. Converge
    // on the winner's row instead of throwing.
    if (isDuplicateSubscriptionError(error, companyId)) {
      const winner = await deps.store.getSubscriptionByCompany(companyId);
      if (winner) return winner;
    }
    throw error;
  }

  const createdLedgerId = randomUUID();
  const createdResult = await deps.store.insertLedgerEvent({
    id: createdLedgerId,
    idempotencyKey: `sub-created:${companyId}`,
    type: "subscription.created",
    subscriptionId: sub.id,
    companyId,
    rawPayload: { ownerUserId, status: sub.status },
  });
  if (createdResult === "inserted") {
    await deps.store.markLedgerApplied(createdLedgerId, now.toISOString());
  }

  if (sub.status === "trialing") {
    const trialLedgerId = randomUUID();
    const trialResult = await deps.store.insertLedgerEvent({
      id: trialLedgerId,
      idempotencyKey: `trial-started:${companyId}`,
      type: "trial.started",
      subscriptionId: sub.id,
      companyId,
      rawPayload: { ownerUserId, companyId, trialEndsAt: sub.trialEndsAt },
    });
    if (trialResult === "inserted") {
      await deps.store.markLedgerApplied(trialLedgerId, now.toISOString());
    }
  }

  try {
    await applyStandingCommand(deps.standing, companyId, expectedStanding(sub, deps.config));
  } catch (error) {
    deps.logger.warn("billing: initial standing write failed; the sweep will reconcile", {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return sub;
}
