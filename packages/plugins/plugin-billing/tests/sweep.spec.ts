import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BILLING_CONFIG } from "../src/config.js";
import { MemoryStubStateStore, StubProvider } from "../src/provider/stub.js";
import { handleProviderWebhook } from "../src/webhook.js";
import { runBillingSweep, type SweepDeps } from "../src/sweep.js";
import { MemoryBillingStore } from "../src/store-memory.js";
import type { SubscriptionRow } from "../src/domain.js";

const SECRET = "d".repeat(64);
const NOW = new Date("2026-07-18T12:00:00.000Z");
const DAY = 86_400_000;

function harness(companies: Array<{ id: string; status: string }>, options: { complete?: boolean } = {}) {
  const complete = options.complete ?? true;
  const store = new MemoryBillingStore(() => NOW);
  const standingCalls: Array<Record<string, unknown>> = [];
  let now = NOW;

  // transport loops stub events straight back into the webhook pipeline
  const provider: StubProvider = new StubProvider({
    store: new MemoryStubStateStore(),
    secret: SECRET,
    transport: {
      deliver: (headers, rawBody) => handleProviderWebhook(deps, { headers, rawBody }),
    },
    now: () => now,
  });

  const deps: SweepDeps = {
    store,
    config: DEFAULT_BILLING_CONFIG,
    standing: {
      set: async (companyId, input) => { standingCalls.push({ kind: "set", companyId, status: input.status, reason: input.reason }); },
      clear: async (companyId) => { standingCalls.push({ kind: "clear", companyId }); },
    },
    provider,
    logger: { warn: vi.fn() },
    now: () => now,
    owners: { resolveOwnerUserId: async (companyId) => `owner-of-${companyId}` },
    companies: { list: async () => ({ companies, complete }) },
    stub: provider,
  };
  return { deps, store, standingCalls, provider, setNow: (d: Date) => { now = d; } };
}

function mkSub(overrides: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    id: randomUUID(), companyId: "co-1", ownerUserId: "user-1", customerId: null,
    status: "awaiting_payment", trialEndsAt: null, graceSince: null, currentPeriodEnd: null,
    cancelAtPeriodEnd: false, priceCentsOverride: null, providerSubscriptionId: null,
    openCheckoutSessionRef: null, openCheckoutUrl: null,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("runBillingSweep", () => {
  it("creates rows for rowless non-archived companies only", async () => {
    const { deps, store } = harness([
      { id: "co-1", status: "active" },
      { id: "co-2", status: "archived" },
    ]);
    const report = await runBillingSweep(deps);
    expect(report.createdRows).toBe(1);
    expect(await store.getSubscriptionByCompany("co-1")).not.toBeNull();
    expect(await store.getSubscriptionByCompany("co-2")).toBeNull();
  });

  it("applies clock transitions with a per-day idempotent ledger row", async () => {
    const { deps, store } = harness([{ id: "co-1", status: "active" }]);
    await store.insertSubscription(mkSub({ status: "trialing", trialEndsAt: new Date(NOW.getTime() - DAY).toISOString() }));
    const first = await runBillingSweep(deps);
    expect(first.clockTransitions).toBe(1);
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("grace");
    const second = await runBillingSweep(deps); // same day, same target state
    expect(second.clockTransitions).toBe(0);
  });

  it("walks trial → grace → blocked across two sweep days and reconciles standing each time", async () => {
    const { deps, store, standingCalls, setNow } = harness([{ id: "co-1", status: "active" }]);
    await store.insertSubscription(mkSub({ status: "trialing", trialEndsAt: new Date(NOW.getTime() - DAY).toISOString() }));
    await runBillingSweep(deps);
    expect(standingCalls.at(-1)).toMatchObject({ kind: "set", status: "grace", reason: "trial_ended" });
    setNow(new Date(NOW.getTime() + DEFAULT_BILLING_CONFIG.graceDays * DAY));
    await runBillingSweep(deps);
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("blocked");
    expect(standingCalls.at(-1)).toMatchObject({ kind: "set", status: "blocked", reason: "trial_ended" });
  });

  it("walks trial → grace → blocked in a SINGLE sweep once both boundaries have already passed", async () => {
    // Binding requirement: transition() is single-step; the sweep must loop each
    // subscription's clock event to a fixed point within one run. Trial expired
    // 10 days ago with the default 7-day grace window means both the
    // trialing→grace and grace→blocked boundaries are already in the past by the
    // time this single sweep runs.
    const { deps, store, standingCalls } = harness([{ id: "co-1", status: "active" }]);
    await store.insertSubscription(mkSub({ status: "trialing", trialEndsAt: new Date(NOW.getTime() - 10 * DAY).toISOString() }));
    const report = await runBillingSweep(deps);
    expect(report.clockTransitions).toBe(2);
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("blocked");
    expect(standingCalls.at(-1)).toMatchObject({ kind: "set", status: "blocked", reason: "trial_ended" });
  });

  it("cancels subscriptions of deleted companies locally and at the provider", async () => {
    const { deps, store } = harness([{ id: "co-live", status: "active" }]);
    const cancelNow = vi.spyOn(deps.provider, "cancelNow").mockResolvedValue();
    await store.insertSubscription(mkSub({ companyId: "co-live", status: "active", providerSubscriptionId: "psub-live" }));
    await store.insertSubscription(mkSub({ companyId: "co-gone", status: "active", providerSubscriptionId: "psub-gone" }));
    const report = await runBillingSweep(deps);
    expect(report.deletedCompanyCancels).toBe(1);
    expect((await store.getSubscriptionByCompany("co-gone"))!.status).toBe("canceled");
    expect(cancelNow).toHaveBeenCalledExactlyOnceWith("psub-gone");
    expect((await store.getSubscriptionByCompany("co-live"))!.status).toBe("active");
  });

  it("skips deletion detection (and logs a warning) when the company list is not provably complete", async () => {
    // Regression for the phase-4 wrong-cancellation bug: an incomplete list
    // (e.g. a truncated page from the host) must never be treated as the
    // full set of live companies, or every company missing from that page
    // looks "deleted" and gets force-canceled.
    const { deps, store } = harness([{ id: "co-live", status: "active" }], { complete: false });
    const cancelNow = vi.spyOn(deps.provider, "cancelNow").mockResolvedValue();
    await store.insertSubscription(mkSub({ companyId: "co-live", status: "active", providerSubscriptionId: "psub-live" }));
    await store.insertSubscription(mkSub({ companyId: "co-not-on-this-page", status: "active", providerSubscriptionId: "psub-elsewhere" }));
    const report = await runBillingSweep(deps);
    expect(report.deletedCompanyCancels).toBe(0);
    expect(cancelNow).not.toHaveBeenCalled();
    expect((await store.getSubscriptionByCompany("co-not-on-this-page"))!.status).toBe("active");
    expect((await store.getSubscriptionByCompany("co-live"))!.status).toBe("active");
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "billing sweep: deletion detection skipped (company list incomplete)",
      expect.objectContaining({ companiesSeen: 1 }),
    );
  });

  it("replays unapplied ledger events once they become resolvable (out-of-order recovery)", async () => {
    const { deps, store } = harness([{ id: "co-1", status: "active" }]);
    await store.insertSubscription(mkSub({ status: "awaiting_payment" }));
    await store.insertLedgerEvent({
      id: "led-1", idempotencyKey: "webhook:x", type: "payment.succeeded",
      subscriptionId: null, companyId: null,
      rawPayload: { subRef: "psub-1", periodEnd: "2026-08-17T12:00:00.000Z", companyId: "co-1" },
    });
    const report = await runBillingSweep(deps);
    expect(report.replayedLedger).toBe(1);
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    expect(sub.status).toBe("active");
    expect(sub.providerSubscriptionId).toBe("psub-1");
    expect(await store.listUnappliedLedgerEvents(10)).toEqual([]);
  });

  it("recovers a stalled ledger row whose subscription was already resolved before the crash", async () => {
    // Binding requirement: the unapplied-ledger replay is the ONLY recovery path
    // for a crash after the webhook handler's ledger insert but before
    // transition/persist/standing/markApplied ran. This models that exact case:
    // the row already carries subscriptionId/companyId (resolution happened),
    // but the subscription row itself was never mutated and the ledger row was
    // never marked applied. Provider redelivery would dedupe to a no-op here
    // (same idempotency key), so only the sweep can converge this.
    const { deps, store } = harness([{ id: "co-1", status: "active" }]);
    const sub = mkSub({ status: "awaiting_payment" });
    await store.insertSubscription(sub);
    await store.insertLedgerEvent({
      id: "led-2", idempotencyKey: "webhook:stalled-crash", type: "checkout.completed",
      subscriptionId: sub.id, companyId: "co-1",
      rawPayload: { sessionRef: "sess-x", subRef: "psub-2", periodEnd: "2026-08-17T12:00:00.000Z" },
    });
    const report = await runBillingSweep(deps);
    expect(report.replayedLedger).toBe(1);
    const updated = (await store.getSubscriptionByCompany("co-1"))!;
    expect(updated.status).toBe("active");
    expect(updated.providerSubscriptionId).toBe("psub-2");
    expect(await store.listUnappliedLedgerEvents(10)).toEqual([]);
  });

  it("clears expired stuck checkouts with a bookkeeping ledger row", async () => {
    const { deps, store } = harness([{ id: "co-1", status: "active" }]);
    await store.insertSubscription(mkSub({ openCheckoutSessionRef: "stub_sess_gone", openCheckoutUrl: "billing-checkout?session=stub_sess_gone" }));
    const report = await runBillingSweep(deps); // stub has no such session → "expired"
    expect(report.expiredCheckouts).toBe(1);
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    expect(sub.openCheckoutSessionRef).toBeNull();
    expect(sub.openCheckoutUrl).toBeNull();
    const events = await store.listLedgerEventsForCompany("co-1", 10);
    expect(events.some((event) => event.type === "checkout.expired")).toBe(true);
  });

  it("delivers due stub renewals through the full webhook path, extending the period", async () => {
    const { deps, store, provider, setNow } = harness([{ id: "co-1", status: "active" }]);
    // subscribe co-1 through the stub so a renewal is scheduled
    const { customerId } = await provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    await store.insertSubscription(mkSub({ status: "awaiting_payment", openCheckoutSessionRef: null }));
    const { sessionRef } = await provider.createCheckout({
      customerId, companyId: "co-1", priceCents: 4900, currency: "EUR",
      successUrl: "s?session={SESSION_REF}", cancelUrl: "c",
    });
    await store.updateSubscription({ ...(await store.getSubscriptionByCompany("co-1"))!, openCheckoutSessionRef: sessionRef });
    await provider.completeCheckout(sessionRef, { savePaymentMethod: false });
    const activated = (await store.getSubscriptionByCompany("co-1"))!;
    expect(activated.status).toBe("active");

    setNow(new Date(Date.parse(activated.currentPeriodEnd!) + 1));
    const report = await runBillingSweep(deps);
    expect(report.stubDelivered).toBe(1);
    const renewed = (await store.getSubscriptionByCompany("co-1"))!;
    expect(Date.parse(renewed.currentPeriodEnd!)).toBe(Date.parse(activated.currentPeriodEnd!) + 30 * DAY);
  });
});
