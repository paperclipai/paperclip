import type { BillingConfig } from "./config.js";
import { BILLING_PAGE_PATH } from "./constants.js";
import type { BillingEvent, StandingCommand, SubscriptionRow } from "./domain.js";

export interface TransitionEffect {
  kind: "provider.cancel_now";
  providerSubscriptionId: string;
}

export interface TransitionResult {
  sub: SubscriptionRow;
  changed: boolean;
  effects: TransitionEffect[];
}

const MS_PER_DAY = 86_400_000;

export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * MS_PER_DAY).toISOString();
}

function fmtDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "soon";
}

/** Out-of-order guard: a period end may only ever grow. */
function laterIso(current: string | null, incoming: string): string {
  if (current === null) return incoming;
  return Date.parse(incoming) > Date.parse(current) ? incoming : current;
}

function rowsEqual(a: SubscriptionRow, b: SubscriptionRow): boolean {
  return (
    a.status === b.status
    && a.customerId === b.customerId
    && a.trialEndsAt === b.trialEndsAt
    && a.graceSince === b.graceSince
    && a.currentPeriodEnd === b.currentPeriodEnd
    && a.cancelAtPeriodEnd === b.cancelAtPeriodEnd
    && a.priceCentsOverride === b.priceCentsOverride
    && a.providerSubscriptionId === b.providerSubscriptionId
    && a.openCheckoutSessionRef === b.openCheckoutSessionRef
    && a.openCheckoutUrl === b.openCheckoutUrl
  );
}

/**
 * The single pure transition function for the subscription lifecycle
 * (spec §6.2). All time-based transitions are pure functions of `now`;
 * nothing here reads a clock, the DB, or the network.
 */
export function transition(
  sub: SubscriptionRow,
  event: BillingEvent,
  config: BillingConfig,
  now: Date,
): TransitionResult {
  const next: SubscriptionRow = { ...sub };
  const effects: TransitionEffect[] = [];

  switch (event.type) {
    case "clock": {
      if (next.status === "trialing" && next.trialEndsAt !== null
        && Date.parse(next.trialEndsAt) <= now.getTime()) {
        next.status = "grace";
        next.graceSince = next.trialEndsAt;
      } else if (next.status === "grace" && next.graceSince !== null
        && Date.parse(next.graceSince) + config.graceDays * MS_PER_DAY <= now.getTime()) {
        next.status = "blocked";
      } else if (next.status === "active" && next.cancelAtPeriodEnd
        && next.currentPeriodEnd !== null
        && Date.parse(next.currentPeriodEnd) <= now.getTime()) {
        next.status = "canceled";
        next.cancelAtPeriodEnd = false;
        // Resurrection hazard: a stale payment.succeeded for the old subRef must not
        // be able to match this row at the routing layer once it's canceled.
        next.providerSubscriptionId = null;
      }
      break;
    }

    case "checkout.completed":
    case "one_click.activated": {
      if (next.status === "complimentary") break;
      next.status = "active";
      if (event.subRef !== null && event.subRef !== undefined) {
        next.providerSubscriptionId = event.subRef;
      }
      next.currentPeriodEnd = laterIso(next.currentPeriodEnd, event.periodEnd);
      next.openCheckoutSessionRef = null;
      next.openCheckoutUrl = null;
      next.cancelAtPeriodEnd = false;
      next.graceSince = null;
      break;
    }

    case "payment.succeeded": {
      if (next.status === "complimentary") break;
      // Defensive guard, belt-and-braces: payment.succeeded must never transition
      // status away from canceled. Routing (Task-8 exact-match on
      // providerSubscriptionId, which every canceled path nulls out) is the primary
      // defense, but this closes the hole even if that invariant were ever violated.
      if (next.status === "canceled") break;
      // trialing/awaiting_payment: unreachable via Task-8 exact-match routing
      // (providerSubscriptionId is null in those states); kept for defensive
      // completeness.
      next.status = "active";
      next.providerSubscriptionId = next.providerSubscriptionId ?? event.subRef;
      next.currentPeriodEnd = laterIso(next.currentPeriodEnd, event.periodEnd);
      next.graceSince = null;
      break;
    }

    case "payment.failed": {
      if (next.status === "active") {
        next.status = "grace";
        next.graceSince = now.toISOString();
      }
      break;
    }

    case "subscription.canceled": {
      if (next.status === "complimentary" || next.status === "canceled") break;
      // trialing/awaiting_payment: unreachable via Task-8 exact-match routing
      // (providerSubscriptionId is null in those states); kept for defensive
      // completeness.
      next.status = "canceled";
      next.cancelAtPeriodEnd = false;
      next.graceSince = null;
      // Resurrection hazard: null the provider ref so a stale payment.succeeded for
      // the old subRef can no longer match this row at the routing layer.
      next.providerSubscriptionId = null;
      break;
    }

    case "owner.cancel_at_period_end": {
      if (next.status === "active") next.cancelAtPeriodEnd = true;
      break;
    }

    case "owner.resume": {
      if (next.status === "active") next.cancelAtPeriodEnd = false;
      break;
    }

    case "admin.set_price_override": {
      next.priceCentsOverride = event.priceCents;
      if (event.priceCents === 0) {
        if (next.providerSubscriptionId !== null) {
          effects.push({ kind: "provider.cancel_now", providerSubscriptionId: next.providerSubscriptionId });
          next.providerSubscriptionId = null;
        }
        next.status = "complimentary";
        next.cancelAtPeriodEnd = false;
        next.graceSince = null;
        next.openCheckoutSessionRef = null;
        next.openCheckoutUrl = null;
      } else if (sub.status === "complimentary") {
        next.status = "awaiting_payment";
      }
      break;
    }

    case "admin.extend_trial": {
      const trialOrigin = next.providerSubscriptionId === null;
      const eligible = next.status === "trialing"
        || next.status === "awaiting_payment"
        || ((next.status === "grace" || next.status === "blocked") && trialOrigin);
      if (eligible) {
        next.status = "trialing";
        next.trialEndsAt = event.trialEndsAt;
        next.graceSince = null;
      }
      break;
    }

    case "company.deleted": {
      if (next.status === "canceled") break;
      if (next.providerSubscriptionId !== null) {
        effects.push({ kind: "provider.cancel_now", providerSubscriptionId: next.providerSubscriptionId });
      }
      // Complimentary is normally "always active" (see expectedStanding), but the
      // company is gone, so that no longer applies — it gets canceled here too.
      next.status = "canceled";
      next.cancelAtPeriodEnd = false;
      // Resurrection hazard: null the provider ref so a stale payment.succeeded for
      // the old subRef can no longer match this row at the routing layer.
      next.providerSubscriptionId = null;
      break;
    }
  }

  const changed = !rowsEqual(sub, next) || effects.length > 0;
  if (changed) next.updatedAt = now.toISOString();
  return { sub: next, changed, effects };
}

/**
 * The one place that maps subscription status to a PR-3 standing command.
 * Idempotent by design: the sweep re-applies it every run so standing always
 * converges to subscription state (spec §8).
 */
export function expectedStanding(sub: SubscriptionRow, config: BillingConfig): StandingCommand {
  switch (sub.status) {
    case "active":
    case "complimentary":
      return { kind: "clear" };
    case "trialing":
      return {
        kind: "set",
        status: "active",
        reason: "trialing",
        message: `Free trial — ends ${fmtDay(sub.trialEndsAt)}.`,
        actionUrl: BILLING_PAGE_PATH,
      };
    case "awaiting_payment":
      return {
        kind: "set",
        status: "blocked",
        reason: "awaiting_subscription",
        message: "This company needs a subscription before agents can run.",
        actionUrl: BILLING_PAGE_PATH,
      };
    case "grace": {
      const deadline = sub.graceSince ? fmtDay(addDaysIso(sub.graceSince, config.graceDays)) : "soon";
      if (sub.providerSubscriptionId === null) {
        return {
          kind: "set",
          status: "grace",
          reason: "trial_ended",
          message: `Trial ended — subscribe by ${deadline} to keep agents running.`,
          actionUrl: BILLING_PAGE_PATH,
        };
      }
      return {
        kind: "set",
        status: "grace",
        reason: "payment_past_due",
        message: `Payment failed — the provider will retry. Fix payment by ${deadline} to keep agents running.`,
        actionUrl: BILLING_PAGE_PATH,
      };
    }
    case "blocked":
      return {
        kind: "set",
        status: "blocked",
        reason: sub.providerSubscriptionId === null ? "trial_ended" : "payment_failed",
        message: "Agent runs are paused until this company has an active subscription.",
        actionUrl: BILLING_PAGE_PATH,
      };
    case "canceled":
      return {
        kind: "set",
        status: "blocked",
        reason: "subscription_ended",
        message: "The subscription ended. Resubscribe to start new agent runs.",
        actionUrl: BILLING_PAGE_PATH,
      };
  }
}
