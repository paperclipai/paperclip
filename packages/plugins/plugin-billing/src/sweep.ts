import { randomUUID } from "node:crypto";
import { applyBillingEvent, billingEventFromLedger, type ApplyDeps } from "./apply.js";
import type { OwnerResolver } from "./creation.js";
import { ensureSubscriptionForCompany } from "./creation.js";
import type { LedgerRow, SubscriptionRow } from "./domain.js";
import { applyStandingCommand } from "./standing.js";
import { expectedStanding, transition } from "./state-machine.js";
import type { BillingStore } from "./store.js";

export interface SweepDeps extends ApplyDeps {
  owners: OwnerResolver;
  /**
   * `complete: false` means the adapter could not prove it enumerated every
   * company (e.g. it hit a pagination safety cap). Phase 4 (deletion
   * detection) MUST be skipped in that case — treating "not in this partial
   * list" as "deleted" would force-cancel live customers who simply landed
   * past the page the adapter managed to read.
   */
  companies: { list(): Promise<{ companies: Array<{ id: string; status: string }>; complete: boolean }> };
  stub?: { deliverDue(now: Date): Promise<number> };
}

export interface SweepReport {
  stubDelivered: number;
  replayedLedger: number;
  createdRows: number;
  deletedCompanyCancels: number;
  clockTransitions: number;
  expiredCheckouts: number;
  standingsReconciled: number;
}

/** Hard ceiling on clock hops per subscription per sweep — the status graph
 * has far fewer than this many reachable states, so this only guards against
 * a future bug introducing a transition cycle. */
const MAX_CLOCK_HOPS_PER_SWEEP = 10;

async function resolveForLedgerRow(store: BillingStore, row: LedgerRow): Promise<SubscriptionRow | null> {
  if (row.companyId) {
    const byCompany = await store.getSubscriptionByCompany(row.companyId);
    if (byCompany) return byCompany;
  }
  const raw = row.rawPayload;
  if (typeof raw.sessionRef === "string") {
    const bySession = await store.getSubscriptionBySessionRef(raw.sessionRef);
    if (bySession) return bySession;
  }
  if (typeof raw.subRef === "string") {
    const byRef = await store.getSubscriptionByProviderRef(raw.subRef);
    if (byRef) return byRef;
  }
  if (typeof raw.companyId === "string") {
    return store.getSubscriptionByCompany(raw.companyId);
  }
  return null;
}

/**
 * Daily reconciliation (spec §6.1, §8). Every phase is idempotent and
 * per-item failure-isolated: one broken row never stops the sweep.
 */
export async function runBillingSweep(deps: SweepDeps): Promise<SweepReport> {
  const report: SweepReport = {
    stubDelivered: 0,
    replayedLedger: 0,
    createdRows: 0,
    deletedCompanyCancels: 0,
    clockTransitions: 0,
    expiredCheckouts: 0,
    standingsReconciled: 0,
  };
  const warn = (phase: string, error: unknown, meta: Record<string, unknown> = {}) =>
    deps.logger.warn(`billing sweep: ${phase} failed`, {
      ...meta,
      error: error instanceof Error ? error.message : String(error),
    });

  // 1. stub due deliveries (renewals, dunning retries, redeliveries)
  if (deps.stub) {
    try {
      report.stubDelivered = await deps.stub.deliverDue(deps.now());
    } catch (error) {
      warn("stub deliverDue", error);
    }
  }

  // 2. unapplied ledger replay (post-insert crash + out-of-order recovery).
  // This is the ONLY recovery path for a crash between the webhook handler's
  // ledger insert and its transition/persist/standing/markApplied — a
  // provider redelivery of the same event dedupes to a no-op on the same
  // idempotency key, so nothing else will ever re-drive this row.
  for (const row of await deps.store.listUnappliedLedgerEvents(200)) {
    try {
      const event = billingEventFromLedger(row);
      if (!event) {
        await deps.store.markLedgerApplied(row.id, deps.now().toISOString());
        continue;
      }
      const sub = await resolveForLedgerRow(deps.store, row);
      if (!sub) continue; // still unresolvable — retry next sweep
      await applyBillingEvent(deps, sub, event, row.id);
      report.replayedLedger += 1;
    } catch (error) {
      warn("ledger replay", error, { ledgerId: row.id, type: row.type });
    }
  }

  const companyList = await deps.companies.list();
  const companies = companyList.companies;
  const liveCompanyIds = new Set(companies.map((company) => company.id));

  // 3. rowless pickup (event-loss safety + first-install backfill)
  for (const company of companies) {
    if (company.status === "archived") continue;
    try {
      const existing = await deps.store.getSubscriptionByCompany(company.id);
      if (existing) continue;
      await ensureSubscriptionForCompany(deps, company.id);
      report.createdRows += 1;
    } catch (error) {
      warn("rowless pickup", error, { companyId: company.id });
    }
  }

  // 4. deleted companies — never bill a ghost.
  // Only trustworthy when the company list is PROVABLY complete: a truncated
  // list makes every company past the cutoff look "deleted", which would
  // force-cancel live customers. Skip the whole phase rather than risk that.
  if (!companyList.complete) {
    deps.logger.warn("billing sweep: deletion detection skipped (company list incomplete)", {
      companiesSeen: companies.length,
    });
  } else {
    for (const sub of await deps.store.listSubscriptions()) {
      if (liveCompanyIds.has(sub.companyId) || sub.status === "canceled") continue;
      try {
        const ledgerId = randomUUID();
        const inserted = await deps.store.insertLedgerEvent({
          id: ledgerId,
          idempotencyKey: `company-deleted:${sub.companyId}`,
          type: "company.deleted",
          subscriptionId: sub.id,
          companyId: sub.companyId,
          rawPayload: {},
        });
        if (inserted === "duplicate") continue;
        await applyBillingEvent(deps, sub, { type: "company.deleted" }, ledgerId);
        report.deletedCompanyCancels += 1;
      } catch (error) {
        warn("deleted-company cancel", error, { companyId: sub.companyId });
      }
    }
  }

  // 5. clock transitions + 6. stuck checkouts + 7. standing reconciliation
  for (const sub of await deps.store.listSubscriptions()) {
    if (!liveCompanyIds.has(sub.companyId)) continue;
    let current = sub;

    // transition() is a single-step pure function: one call only ever performs
    // the ONE boundary crossing that applies right now (e.g. trialing→grace).
    // If multiple boundaries have already passed by the time a sweep runs
    // (e.g. a trial that expired long enough ago that the grace deadline has
    // also passed), the sweep must loop the clock event to a fixed point
    // within this same run rather than requiring one sweep per hop. Each hop
    // gets its own idempotent ledger row (distinct from/to pair in the key),
    // so this is safe to repeat every sweep and to re-run after a crash.
    try {
      for (let hops = 0; hops < MAX_CLOCK_HOPS_PER_SWEEP; hops += 1) {
        const dryRun = transition(current, { type: "clock" }, deps.config, deps.now());
        if (!dryRun.changed) break;
        const day = deps.now().toISOString().slice(0, 10);
        const ledgerId = randomUUID();
        const inserted = await deps.store.insertLedgerEvent({
          id: ledgerId,
          idempotencyKey: `clock:${current.id}:${current.status}:${dryRun.sub.status}:${day}`,
          type: "clock",
          subscriptionId: current.id,
          companyId: current.companyId,
          rawPayload: { from: current.status, to: dryRun.sub.status },
        });
        if (inserted === "duplicate") break; // this exact hop already landed today
        current = await applyBillingEvent(deps, current, { type: "clock" }, ledgerId);
        report.clockTransitions += 1;
      }
    } catch (error) {
      warn("clock transition", error, { companyId: current.companyId });
    }

    try {
      if (current.openCheckoutSessionRef && deps.provider.resolveCheckout) {
        const state = await deps.provider.resolveCheckout(current.openCheckoutSessionRef);
        if (state === "expired") {
          const ledgerId = randomUUID();
          await deps.store.insertLedgerEvent({
            id: ledgerId,
            idempotencyKey: `checkout-expired:${current.openCheckoutSessionRef}`,
            type: "checkout.expired",
            subscriptionId: current.id,
            companyId: current.companyId,
            rawPayload: { sessionRef: current.openCheckoutSessionRef },
          });
          await deps.store.markLedgerApplied(ledgerId, deps.now().toISOString());
          current = { ...current, openCheckoutSessionRef: null, openCheckoutUrl: null, updatedAt: deps.now().toISOString() };
          await deps.store.updateSubscription(current);
          report.expiredCheckouts += 1;
        }
        // "complete" needs no action: phases 1–2 recover the completed event.
      }
    } catch (error) {
      warn("stuck checkout", error, { companyId: current.companyId });
    }

    try {
      await applyStandingCommand(deps.standing, current.companyId, expectedStanding(current, deps.config));
      report.standingsReconciled += 1;
    } catch (error) {
      warn("standing reconciliation", error, { companyId: current.companyId });
    }
  }

  return report;
}
