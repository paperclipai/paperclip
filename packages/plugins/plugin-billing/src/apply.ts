import type { PluginLogger } from "@paperclipai/plugin-sdk";
import type { BillingConfig } from "./config.js";
import type { BillingEvent, LedgerRow, SubscriptionRow } from "./domain.js";
import type { BillingProvider } from "./provider/types.js";
import { applyStandingCommand, type StandingWriter } from "./standing.js";
import { expectedStanding, transition } from "./state-machine.js";
import type { BillingStore } from "./store.js";

export interface ApplyDeps {
  store: BillingStore;
  config: BillingConfig;
  standing: StandingWriter;
  provider: BillingProvider;
  logger: Pick<PluginLogger, "warn">;
  now: () => Date;
}

/**
 * The one code path that mutates a subscription:
 * transition (pure) → persist → mark ledger applied → provider effects →
 * standing write. Standing is deliberately last and non-fatal: on failure the
 * sweep reconciles standing from subscription state (spec §8).
 */
export async function applyBillingEvent(
  deps: ApplyDeps,
  sub: SubscriptionRow,
  event: BillingEvent,
  ledgerId: string,
): Promise<SubscriptionRow> {
  const now = deps.now();
  const result = transition(sub, event, deps.config, now);

  if (result.changed) {
    await deps.store.updateSubscription(result.sub);
  }
  await deps.store.markLedgerApplied(ledgerId, now.toISOString());

  for (const effect of result.effects) {
    try {
      await deps.provider.cancelNow(effect.providerSubscriptionId);
    } catch (error) {
      deps.logger.warn("billing: provider cancelNow failed (will not retry automatically)", {
        companyId: result.sub.companyId,
        providerSubscriptionId: effect.providerSubscriptionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    await applyStandingCommand(deps.standing, result.sub.companyId, expectedStanding(result.sub, deps.config));
  } catch (error) {
    deps.logger.warn("billing: standing write failed; the sweep will reconcile", {
      companyId: result.sub.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result.sub;
}

/** Reconstruct the state-machine event from a ledger row; null for bookkeeping rows. */
export function billingEventFromLedger(row: LedgerRow): BillingEvent | null {
  const raw = row.rawPayload;
  switch (row.type) {
    case "checkout.completed":
      return { type: "checkout.completed", sessionRef: String(raw.sessionRef), subRef: String(raw.subRef), periodEnd: String(raw.periodEnd) };
    case "payment.succeeded":
      return { type: "payment.succeeded", subRef: String(raw.subRef), periodEnd: String(raw.periodEnd) };
    case "payment.failed":
      return { type: "payment.failed", subRef: String(raw.subRef) };
    case "subscription.canceled":
      return { type: "subscription.canceled", subRef: String(raw.subRef) };
    case "one_click.activated":
      return { type: "one_click.activated", subRef: raw.subRef == null ? null : String(raw.subRef), periodEnd: String(raw.periodEnd) };
    case "owner.cancel_at_period_end":
      return { type: "owner.cancel_at_period_end" };
    case "owner.resume":
      return { type: "owner.resume" };
    case "admin.set_price_override":
      return { type: "admin.set_price_override", priceCents: raw.priceCents == null ? null : Number(raw.priceCents) };
    case "admin.extend_trial":
      return { type: "admin.extend_trial", trialEndsAt: String(raw.trialEndsAt) };
    case "company.deleted":
      return { type: "company.deleted" };
    case "clock":
      return { type: "clock" };
    default:
      return null; // bookkeeping rows: subscription.created, trial.started, checkout.created
  }
}
