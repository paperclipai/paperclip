import { describe, expect, it } from "vitest";
import { DEFAULT_BILLING_CONFIG } from "../src/config.js";
import { BILLING_PAGE_PATH } from "../src/constants.js";
import { SUBSCRIPTION_STATUSES, type BillingEvent, type SubscriptionRow, type SubscriptionStatus } from "../src/domain.js";
import { addDaysIso, expectedStanding, transition } from "../src/state-machine.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");
const CONFIG = DEFAULT_BILLING_CONFIG; // trialDays 7, graceDays 7

function mkSub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-1",
    companyId: "co-1",
    ownerUserId: "user-1",
    customerId: null,
    status: "awaiting_payment",
    trialEndsAt: null,
    graceSince: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    priceCentsOverride: null,
    providerSubscriptionId: null,
    openCheckoutSessionRef: null,
    openCheckoutUrl: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Representative row per status, with the fields that status implies. */
function subInStatus(status: SubscriptionStatus): SubscriptionRow {
  switch (status) {
    case "trialing":
      return mkSub({ status, trialEndsAt: "2026-07-25T12:00:00.000Z" });
    case "awaiting_payment":
      return mkSub({ status });
    case "active":
      return mkSub({ status, providerSubscriptionId: "psub-1", currentPeriodEnd: "2026-08-17T12:00:00.000Z" });
    case "grace":
      return mkSub({ status, providerSubscriptionId: "psub-1", graceSince: "2026-07-16T12:00:00.000Z" });
    case "blocked":
      return mkSub({ status, providerSubscriptionId: "psub-1", graceSince: "2026-07-01T12:00:00.000Z" });
    case "canceled":
      return mkSub({ status, providerSubscriptionId: "psub-1" });
    case "complimentary":
      return mkSub({ status, priceCentsOverride: 0 });
  }
}

describe("transition — clock boundaries", () => {
  it("trialing stays trialing strictly before trialEndsAt", () => {
    const sub = mkSub({ status: "trialing", trialEndsAt: "2026-07-18T12:00:00.001Z" });
    const r = transition(sub, { type: "clock" }, CONFIG, NOW);
    expect(r.changed).toBe(false);
    expect(r.sub.status).toBe("trialing");
  });

  it("trialing → grace exactly at trialEndsAt, graceSince anchored to trialEndsAt (clock-skew safe)", () => {
    const sub = mkSub({ status: "trialing", trialEndsAt: "2026-07-18T12:00:00.000Z" });
    const r = transition(sub, { type: "clock" }, CONFIG, NOW);
    expect(r.changed).toBe(true);
    expect(r.sub.status).toBe("grace");
    expect(r.sub.graceSince).toBe("2026-07-18T12:00:00.000Z");
    expect(r.effects).toEqual([]);
  });

  it("trialing far past trialEndsAt still lands in grace first (sweep runs twice to reach blocked)", () => {
    const sub = mkSub({ status: "trialing", trialEndsAt: "2026-06-01T00:00:00.000Z" });
    const first = transition(sub, { type: "clock" }, CONFIG, NOW);
    expect(first.sub.status).toBe("grace");
    const second = transition(first.sub, { type: "clock" }, CONFIG, NOW);
    expect(second.sub.status).toBe("blocked");
  });

  it("grace stays grace strictly before graceSince + graceDays", () => {
    const sub = mkSub({ status: "grace", graceSince: addDaysIso(NOW.toISOString(), -CONFIG.graceDays + 1) });
    const r = transition(sub, { type: "clock" }, CONFIG, NOW);
    expect(r.changed).toBe(false);
  });

  it("grace → blocked exactly at graceSince + graceDays", () => {
    const sub = mkSub({ status: "grace", graceSince: addDaysIso(NOW.toISOString(), -CONFIG.graceDays) });
    const r = transition(sub, { type: "clock" }, CONFIG, NOW);
    expect(r.sub.status).toBe("blocked");
  });

  it("active with cancelAtPeriodEnd → canceled once currentPeriodEnd passes; flag resets", () => {
    const before = mkSub({ status: "active", providerSubscriptionId: "psub-1", cancelAtPeriodEnd: true, currentPeriodEnd: "2026-07-19T00:00:00.000Z" });
    expect(transition(before, { type: "clock" }, CONFIG, NOW).changed).toBe(false);
    const due = mkSub({ status: "active", providerSubscriptionId: "psub-1", cancelAtPeriodEnd: true, currentPeriodEnd: "2026-07-18T12:00:00.000Z" });
    const r = transition(due, { type: "clock" }, CONFIG, NOW);
    expect(r.sub.status).toBe("canceled");
    expect(r.sub.cancelAtPeriodEnd).toBe(false);
    expect(r.sub.providerSubscriptionId).toBeNull();
  });

  it("active without cancelAtPeriodEnd never clock-cancels, even long past periodEnd (dunning owns it)", () => {
    const sub = mkSub({ status: "active", providerSubscriptionId: "psub-1", currentPeriodEnd: "2026-06-01T00:00:00.000Z" });
    expect(transition(sub, { type: "clock" }, CONFIG, NOW).changed).toBe(false);
  });

  it("clock is a no-op for awaiting_payment, blocked, canceled, complimentary", () => {
    for (const status of ["awaiting_payment", "blocked", "canceled", "complimentary"] as const) {
      const r = transition(subInStatus(status), { type: "clock" }, CONFIG, NOW);
      expect(r.changed, status).toBe(false);
    }
  });
});

describe("transition — checkout.completed / one_click.activated", () => {
  const checkout: BillingEvent = { type: "checkout.completed", sessionRef: "sess-1", subRef: "psub-9", periodEnd: "2026-08-18T12:00:00.000Z" };

  it("activates every unpaid state and clears checkout/grace bookkeeping", () => {
    for (const status of ["trialing", "awaiting_payment", "grace", "blocked", "canceled"] as const) {
      const sub = { ...subInStatus(status), openCheckoutSessionRef: "sess-1", openCheckoutUrl: "billing-checkout?session=sess-1" };
      const r = transition(sub, checkout, CONFIG, NOW);
      expect(r.sub.status, status).toBe("active");
      expect(r.sub.providerSubscriptionId).toBe("psub-9");
      expect(r.sub.currentPeriodEnd).toBe("2026-08-18T12:00:00.000Z");
      expect(r.sub.openCheckoutSessionRef).toBeNull();
      expect(r.sub.openCheckoutUrl).toBeNull();
      expect(r.sub.cancelAtPeriodEnd).toBe(false);
      expect(r.sub.graceSince).toBeNull();
      expect(r.changed).toBe(true);
    }
  });

  it("subscribe-during-trial keeps trialEndsAt for display", () => {
    const sub = subInStatus("trialing");
    const r = transition(sub, checkout, CONFIG, NOW);
    expect(r.sub.status).toBe("active");
    expect(r.sub.trialEndsAt).toBe(sub.trialEndsAt);
  });

  it("is idempotent and out-of-order safe on active (periodEnd only ever grows)", () => {
    const sub = mkSub({ status: "active", providerSubscriptionId: "psub-9", currentPeriodEnd: "2026-09-01T00:00:00.000Z" });
    const r = transition(sub, checkout, CONFIG, NOW);
    expect(r.sub.currentPeriodEnd).toBe("2026-09-01T00:00:00.000Z");
    expect(r.changed).toBe(false);
  });

  it("never touches complimentary", () => {
    const r = transition(subInStatus("complimentary"), checkout, CONFIG, NOW);
    expect(r.changed).toBe(false);
  });

  it("one_click.activated behaves like checkout.completed and tolerates a null subRef", () => {
    const r = transition(subInStatus("awaiting_payment"), { type: "one_click.activated", subRef: null, periodEnd: "2026-08-18T12:00:00.000Z" }, CONFIG, NOW);
    expect(r.sub.status).toBe("active");
    expect(r.sub.providerSubscriptionId).toBeNull();
  });
});

describe("transition — payment.succeeded", () => {
  const paid: BillingEvent = { type: "payment.succeeded", subRef: "psub-1", periodEnd: "2026-09-17T12:00:00.000Z" };

  it("extends the period on active and adopts subRef when missing", () => {
    const sub = mkSub({ status: "active", providerSubscriptionId: null, currentPeriodEnd: "2026-08-17T12:00:00.000Z" });
    const r = transition(sub, paid, CONFIG, NOW);
    expect(r.sub.currentPeriodEnd).toBe("2026-09-17T12:00:00.000Z");
    expect(r.sub.providerSubscriptionId).toBe("psub-1");
  });

  it("out-of-order renewal never shrinks the period", () => {
    const sub = mkSub({ status: "active", providerSubscriptionId: "psub-1", currentPeriodEnd: "2026-10-17T12:00:00.000Z" });
    const r = transition(sub, paid, CONFIG, NOW);
    expect(r.sub.currentPeriodEnd).toBe("2026-10-17T12:00:00.000Z");
    expect(r.changed).toBe(false);
  });

  it("auto-unblocks grace and blocked, activates trialing/awaiting_payment", () => {
    for (const status of ["grace", "blocked", "trialing", "awaiting_payment"] as const) {
      const r = transition(subInStatus(status), paid, CONFIG, NOW);
      expect(r.sub.status, status).toBe("active");
      expect(r.sub.graceSince).toBeNull();
    }
  });

  it("never touches complimentary", () => {
    expect(transition(subInStatus("complimentary"), paid, CONFIG, NOW).changed).toBe(false);
  });

  it("does not revive canceled — resurrection guard, belt-and-braces on top of routing", () => {
    const r = transition(subInStatus("canceled"), paid, CONFIG, NOW);
    expect(r.sub.status).toBe("canceled");
    expect(r.changed).toBe(false);
  });
});

describe("transition — resurrection hazard (canceled must stay canceled)", () => {
  it("clock cancel-at-period-end nulls providerSubscriptionId, so a stale payment.succeeded for the old subRef leaves the sub canceled", () => {
    const active = mkSub({
      status: "active",
      providerSubscriptionId: "psub-old",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: "2026-07-18T12:00:00.000Z",
    });
    const afterClock = transition(active, { type: "clock" }, CONFIG, NOW);
    expect(afterClock.sub.status).toBe("canceled");
    expect(afterClock.sub.providerSubscriptionId).toBeNull();

    const stalePayment: BillingEvent = { type: "payment.succeeded", subRef: "psub-old", periodEnd: "2026-09-18T12:00:00.000Z" };
    const r = transition(afterClock.sub, stalePayment, CONFIG, NOW);
    expect(r.sub.status).toBe("canceled");
    expect(r.changed).toBe(false);
  });

  it("subscription.canceled event nulls providerSubscriptionId", () => {
    const sub = subInStatus("active");
    const r = transition(sub, { type: "subscription.canceled", subRef: "psub-1" }, CONFIG, NOW);
    expect(r.sub.status).toBe("canceled");
    expect(r.sub.providerSubscriptionId).toBeNull();
  });

  it("company.deleted nulls providerSubscriptionId", () => {
    const sub = subInStatus("active");
    const r = transition(sub, { type: "company.deleted" }, CONFIG, NOW);
    expect(r.sub.status).toBe("canceled");
    expect(r.sub.providerSubscriptionId).toBeNull();
  });

  it("payment.succeeded is a defensive no-op on canceled even if providerSubscriptionId were somehow still populated", () => {
    const sub = { ...subInStatus("canceled"), providerSubscriptionId: "psub-1" };
    const r = transition(sub, { type: "payment.succeeded", subRef: "psub-1", periodEnd: "2026-09-18T12:00:00.000Z" }, CONFIG, NOW);
    expect(r.sub.status).toBe("canceled");
  });
});

describe("transition — payment.failed", () => {
  const failed: BillingEvent = { type: "payment.failed", subRef: "psub-1" };

  it("active → grace with graceSince = now", () => {
    const r = transition(subInStatus("active"), failed, CONFIG, NOW);
    expect(r.sub.status).toBe("grace");
    expect(r.sub.graceSince).toBe(NOW.toISOString());
  });

  it("repeat failures during grace do not extend the grace window", () => {
    const sub = subInStatus("grace");
    const r = transition(sub, failed, CONFIG, NOW);
    expect(r.changed).toBe(false);
    expect(r.sub.graceSince).toBe(sub.graceSince);
  });

  it("is a no-op for every non-active, non-grace status", () => {
    for (const status of ["trialing", "awaiting_payment", "blocked", "canceled", "complimentary"] as const) {
      expect(transition(subInStatus(status), failed, CONFIG, NOW).changed, status).toBe(false);
    }
  });
});

describe("transition — subscription.canceled", () => {
  const canceled: BillingEvent = { type: "subscription.canceled", subRef: "psub-1" };

  it("cancels active/grace/blocked/trialing/awaiting_payment", () => {
    for (const status of ["active", "grace", "blocked", "trialing", "awaiting_payment"] as const) {
      const r = transition(subInStatus(status), canceled, CONFIG, NOW);
      expect(r.sub.status, status).toBe("canceled");
      expect(r.sub.cancelAtPeriodEnd).toBe(false);
      expect(r.sub.providerSubscriptionId, status).toBeNull();
    }
  });

  it("is a no-op for canceled and complimentary", () => {
    for (const status of ["canceled", "complimentary"] as const) {
      expect(transition(subInStatus(status), canceled, CONFIG, NOW).changed, status).toBe(false);
    }
  });
});

describe("transition — owner cancel/resume", () => {
  it("cancel_at_period_end only flips the flag on active", () => {
    const r = transition(subInStatus("active"), { type: "owner.cancel_at_period_end" }, CONFIG, NOW);
    expect(r.sub.status).toBe("active");
    expect(r.sub.cancelAtPeriodEnd).toBe(true);
    for (const status of ["trialing", "awaiting_payment", "grace", "blocked", "canceled", "complimentary"] as const) {
      expect(transition(subInStatus(status), { type: "owner.cancel_at_period_end" }, CONFIG, NOW).changed, status).toBe(false);
    }
  });

  it("resume clears the flag on active only", () => {
    const sub = { ...subInStatus("active"), cancelAtPeriodEnd: true };
    const r = transition(sub, { type: "owner.resume" }, CONFIG, NOW);
    expect(r.sub.cancelAtPeriodEnd).toBe(false);
    for (const status of ["trialing", "awaiting_payment", "grace", "blocked", "canceled", "complimentary"] as const) {
      expect(transition(subInStatus(status), { type: "owner.resume" }, CONFIG, NOW).changed, status).toBe(false);
    }
  });
});

describe("transition — admin.set_price_override", () => {
  it("0 comps the company from any status and cancels any live provider subscription", () => {
    for (const status of SUBSCRIPTION_STATUSES.filter((s) => s !== "complimentary")) {
      const sub = subInStatus(status);
      const r = transition(sub, { type: "admin.set_price_override", priceCents: 0 }, CONFIG, NOW);
      expect(r.sub.status, status).toBe("complimentary");
      expect(r.sub.priceCentsOverride).toBe(0);
      expect(r.sub.providerSubscriptionId).toBeNull();
      expect(r.sub.openCheckoutSessionRef).toBeNull();
      if (sub.providerSubscriptionId) {
        expect(r.effects).toEqual([{ kind: "provider.cancel_now", providerSubscriptionId: sub.providerSubscriptionId }]);
      } else {
        expect(r.effects).toEqual([]);
      }
    }
  });

  it("a positive override only changes the price for non-complimentary statuses", () => {
    const sub = subInStatus("active");
    const r = transition(sub, { type: "admin.set_price_override", priceCents: 9900 }, CONFIG, NOW);
    expect(r.sub.status).toBe("active");
    expect(r.sub.priceCentsOverride).toBe(9900);
  });

  it("leaving complimentary (override → null or > 0) lands in awaiting_payment", () => {
    for (const priceCents of [null, 9900]) {
      const r = transition(subInStatus("complimentary"), { type: "admin.set_price_override", priceCents }, CONFIG, NOW);
      expect(r.sub.status).toBe("awaiting_payment");
      expect(r.sub.priceCentsOverride).toBe(priceCents);
    }
  });
});

describe("transition — admin.extend_trial", () => {
  const extend: BillingEvent = { type: "admin.extend_trial", trialEndsAt: "2026-08-01T00:00:00.000Z" };

  it("extends trialing and revives trial-origin grace/blocked and awaiting_payment into trialing", () => {
    for (const status of ["trialing", "awaiting_payment"] as const) {
      const r = transition(subInStatus(status), extend, CONFIG, NOW);
      expect(r.sub.status, status).toBe("trialing");
      expect(r.sub.trialEndsAt).toBe("2026-08-01T00:00:00.000Z");
    }
    for (const status of ["grace", "blocked"] as const) {
      const trialOrigin = { ...subInStatus(status), providerSubscriptionId: null };
      const r = transition(trialOrigin, extend, CONFIG, NOW);
      expect(r.sub.status, status).toBe("trialing");
      expect(r.sub.graceSince).toBeNull();
    }
  });

  it("does not touch paid grace/blocked, active, canceled, complimentary", () => {
    for (const status of ["grace", "blocked"] as const) {
      expect(transition(subInStatus(status), extend, CONFIG, NOW).changed, `paid ${status}`).toBe(false);
    }
    for (const status of ["active", "canceled", "complimentary"] as const) {
      expect(transition(subInStatus(status), extend, CONFIG, NOW).changed, status).toBe(false);
    }
  });
});

describe("transition — company.deleted", () => {
  it("cancels locally and emits a provider cancel effect when a provider subscription exists", () => {
    for (const status of ["active", "grace", "blocked"] as const) {
      const sub = subInStatus(status);
      const r = transition(sub, { type: "company.deleted" }, CONFIG, NOW);
      expect(r.sub.status).toBe("canceled");
      expect(r.effects).toEqual([{ kind: "provider.cancel_now", providerSubscriptionId: "psub-1" }]);
      expect(r.sub.providerSubscriptionId, status).toBeNull();
    }
  });

  it("cancels without effect when no provider subscription exists", () => {
    for (const status of ["trialing", "awaiting_payment", "complimentary"] as const) {
      const r = transition(subInStatus(status), { type: "company.deleted" }, CONFIG, NOW);
      expect(r.sub.status, status).toBe("canceled");
      expect(r.effects).toEqual([]);
    }
  });

  it("is a no-op when already canceled", () => {
    expect(transition(subInStatus("canceled"), { type: "company.deleted" }, CONFIG, NOW).changed).toBe(false);
  });
});

describe("transition — purity and updatedAt", () => {
  it("never mutates its input and stamps updatedAt only on change", () => {
    const sub = subInStatus("active");
    const frozen = JSON.stringify(sub);
    const changed = transition(sub, { type: "owner.cancel_at_period_end" }, CONFIG, NOW);
    const unchanged = transition(sub, { type: "clock" }, CONFIG, NOW);
    expect(JSON.stringify(sub)).toBe(frozen);
    expect(changed.sub.updatedAt).toBe(NOW.toISOString());
    expect(unchanged.sub.updatedAt).toBe(sub.updatedAt);
  });
});

describe("expectedStanding — full status mapping", () => {
  it("active and complimentary clear standing", () => {
    expect(expectedStanding(subInStatus("active"), CONFIG)).toEqual({ kind: "clear" });
    expect(expectedStanding(subInStatus("complimentary"), CONFIG)).toEqual({ kind: "clear" });
  });

  it("trialing writes an informational active standing with the trial deadline", () => {
    expect(expectedStanding(subInStatus("trialing"), CONFIG)).toEqual({
      kind: "set",
      status: "active",
      reason: "trialing",
      message: "Free trial — ends 2026-07-25.",
      actionUrl: BILLING_PAGE_PATH,
    });
  });

  it("awaiting_payment blocks with awaiting_subscription", () => {
    expect(expectedStanding(subInStatus("awaiting_payment"), CONFIG)).toEqual({
      kind: "set",
      status: "blocked",
      reason: "awaiting_subscription",
      message: "This company needs a subscription before agents can run.",
      actionUrl: BILLING_PAGE_PATH,
    });
  });

  it("grace distinguishes trial_ended (no provider sub) from payment_past_due and includes the deadline", () => {
    const paidGrace = subInStatus("grace"); // graceSince 2026-07-16, graceDays 7 → deadline 2026-07-23
    expect(expectedStanding(paidGrace, CONFIG)).toEqual({
      kind: "set",
      status: "grace",
      reason: "payment_past_due",
      message: "Payment failed — the provider will retry. Fix payment by 2026-07-23 to keep agents running.",
      actionUrl: BILLING_PAGE_PATH,
    });
    const trialGrace = { ...paidGrace, providerSubscriptionId: null };
    expect(expectedStanding(trialGrace, CONFIG)).toEqual({
      kind: "set",
      status: "grace",
      reason: "trial_ended",
      message: "Trial ended — subscribe by 2026-07-23 to keep agents running.",
      actionUrl: BILLING_PAGE_PATH,
    });
  });

  it("blocked distinguishes trial_ended from payment_failed", () => {
    expect(expectedStanding(subInStatus("blocked"), CONFIG)).toEqual({
      kind: "set",
      status: "blocked",
      reason: "payment_failed",
      message: "Agent runs are paused until this company has an active subscription.",
      actionUrl: BILLING_PAGE_PATH,
    });
    expect(expectedStanding({ ...subInStatus("blocked"), providerSubscriptionId: null }, CONFIG)).toEqual({
      kind: "set",
      status: "blocked",
      reason: "trial_ended",
      message: "Agent runs are paused until this company has an active subscription.",
      actionUrl: BILLING_PAGE_PATH,
    });
  });

  it("canceled blocks with subscription_ended", () => {
    expect(expectedStanding(subInStatus("canceled"), CONFIG)).toEqual({
      kind: "set",
      status: "blocked",
      reason: "subscription_ended",
      message: "The subscription ended. Resubscribe to start new agent runs.",
      actionUrl: BILLING_PAGE_PATH,
    });
  });

  it("every actionUrl across every status is app-relative (leading slash) — regression for the " +
    "PR-3 standing validator (server/src/services/company-standing.ts), which throws badRequest " +
    "on any non-`/`-prefixed, non-http(s) actionUrl", () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      const command = expectedStanding(subInStatus(status), CONFIG);
      if (command.kind === "set" && command.actionUrl !== undefined) {
        expect(command.actionUrl.startsWith("/")).toBe(true);
      }
    }
  });
});
