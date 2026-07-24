import { describe, expect, it, vi } from "vitest";
import { STUB_SIGNATURE_HEADER } from "../src/constants.js";
import { DEFAULT_BILLING_CONFIG } from "../src/config.js";
import type { SubscriptionRow } from "../src/domain.js";
import { WebhookVerificationError, signStubPayload } from "../src/hmac.js";
import { MemoryStubStateStore, StubProvider } from "../src/provider/stub.js";
import { applyBillingEvent, billingEventFromLedger, type ApplyDeps } from "../src/apply.js";
import { handleProviderWebhook, ledgerKeyForRawBody } from "../src/webhook.js";
import { MemoryBillingStore } from "../src/store-memory.js";

const SECRET = "b".repeat(64);
const NOW = new Date("2026-07-18T12:00:00.000Z");

function mkSub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-1", companyId: "co-1", ownerUserId: "user-1", customerId: null,
    status: "awaiting_payment", trialEndsAt: null, graceSince: null, currentPeriodEnd: null,
    cancelAtPeriodEnd: false, priceCentsOverride: null, providerSubscriptionId: null,
    openCheckoutSessionRef: null, openCheckoutUrl: null,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ApplyDeps> = {}) {
  const store = new MemoryBillingStore(() => NOW);
  const standingCalls: Array<Record<string, unknown>> = [];
  const provider = new StubProvider({
    store: new MemoryStubStateStore(),
    secret: SECRET,
    transport: { deliver: async () => {} },
    now: () => NOW,
  });
  const warn = vi.fn();
  const deps: ApplyDeps = {
    store,
    config: DEFAULT_BILLING_CONFIG,
    standing: {
      set: async (companyId, input) => { standingCalls.push({ kind: "set", companyId, ...input }); },
      clear: async (companyId) => { standingCalls.push({ kind: "clear", companyId }); },
    },
    provider,
    logger: { warn },
    now: () => NOW,
    ...overrides,
  };
  return { deps, store, standingCalls, warn };
}

function signedEvent(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return { rawBody, headers: { [STUB_SIGNATURE_HEADER]: signStubPayload(SECRET, rawBody) } };
}

describe("handleProviderWebhook", () => {
  it("rejects a bad signature: throws, writes NO ledger row, changes NO state", async () => {
    const { deps, store, standingCalls } = makeDeps();
    await store.insertSubscription(mkSub());
    const rawBody = JSON.stringify({ eventId: "e", type: "payment.failed", subRef: "psub-1" });
    await expect(
      handleProviderWebhook(deps, { headers: { [STUB_SIGNATURE_HEADER]: "00" }, rawBody }),
    ).rejects.toThrow(WebhookVerificationError);
    expect(await store.listUnappliedLedgerEvents(10)).toEqual([]);
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("awaiting_payment");
    expect(standingCalls).toEqual([]);
  });

  it("applies checkout.completed resolved via open session ref: ledger applied, status active, standing cleared", async () => {
    const { deps, store, standingCalls } = makeDeps();
    await store.insertSubscription(mkSub({ status: "blocked", openCheckoutSessionRef: "sess-1", openCheckoutUrl: "u" }));
    const { rawBody, headers } = signedEvent({
      eventId: "e1", type: "checkout.completed", sessionRef: "sess-1", subRef: "psub-1",
      periodEnd: "2026-08-17T12:00:00.000Z", companyId: "co-1",
    });
    await handleProviderWebhook(deps, { headers, rawBody });
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    expect(sub.status).toBe("active");
    expect(sub.providerSubscriptionId).toBe("psub-1");
    expect(sub.openCheckoutSessionRef).toBeNull();
    expect(await store.listUnappliedLedgerEvents(10)).toEqual([]);
    expect(standingCalls).toEqual([{ kind: "clear", companyId: "co-1" }]);
  });

  it("replay of the byte-identical body is a no-op (single ledger row, no second standing write)", async () => {
    const { deps, store, standingCalls } = makeDeps();
    await store.insertSubscription(mkSub({ openCheckoutSessionRef: "sess-1" }));
    const { rawBody, headers } = signedEvent({
      eventId: "e1", type: "checkout.completed", sessionRef: "sess-1", subRef: "psub-1",
      periodEnd: "2026-08-17T12:00:00.000Z", companyId: "co-1",
    });
    await handleProviderWebhook(deps, { headers, rawBody });
    await handleProviderWebhook(deps, { headers, rawBody });
    expect(standingCalls).toHaveLength(1);
    const history = await store.listLedgerEventsForCompany("co-1", 10);
    expect(history.filter((row) => row.idempotencyKey === ledgerKeyForRawBody(rawBody))).toHaveLength(1);
  });

  it("out-of-order: an unresolvable payment.succeeded is stored unapplied and mutates nothing", async () => {
    const { deps, store, warn } = makeDeps();
    await store.insertSubscription(mkSub());
    const { rawBody, headers } = signedEvent({
      eventId: "e1", type: "payment.succeeded", subRef: "psub-unknown", periodEnd: "2026-09-17T12:00:00.000Z",
    });
    await handleProviderWebhook(deps, { headers, rawBody });
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("awaiting_payment");
    const unapplied = await store.listUnappliedLedgerEvents(10);
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].type).toBe("payment.succeeded");
    expect(warn).toHaveBeenCalled();
  });

  it("falls back to rawPayload.companyId when the subRef is not yet known (one-click first event)", async () => {
    const { deps, store } = makeDeps();
    await store.insertSubscription(mkSub());
    const { rawBody, headers } = signedEvent({
      eventId: "e1", type: "payment.succeeded", subRef: "psub-2", periodEnd: "2026-08-17T12:00:00.000Z", companyId: "co-1",
    });
    await handleProviderWebhook(deps, { headers, rawBody });
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    expect(sub.status).toBe("active");
    expect(sub.providerSubscriptionId).toBe("psub-2");
  });

  it("standing-write failure does not lose the transition: sub updated, ledger applied, warning logged", async () => {
    const failing = makeDeps({
      standing: {
        set: async () => { throw new Error("standing service down"); },
        clear: async () => { throw new Error("standing service down"); },
      },
    });
    await failing.store.insertSubscription(mkSub({ openCheckoutSessionRef: "sess-1" }));
    const { rawBody, headers } = signedEvent({
      eventId: "e1", type: "checkout.completed", sessionRef: "sess-1", subRef: "psub-1",
      periodEnd: "2026-08-17T12:00:00.000Z", companyId: "co-1",
    });
    await handleProviderWebhook(failing.deps, { headers, rawBody });
    expect((await failing.store.getSubscriptionByCompany("co-1"))!.status).toBe("active");
    expect(await failing.store.listUnappliedLedgerEvents(10)).toEqual([]);
    expect(failing.warn).toHaveBeenCalled();
  });
});

describe("applyBillingEvent — provider effects", () => {
  it("admin comp (override 0) cancels the live provider subscription via cancelNow", async () => {
    const { deps, store } = makeDeps();
    const cancelNow = vi.spyOn(deps.provider, "cancelNow").mockResolvedValue();
    await store.insertSubscription(mkSub({ status: "active", providerSubscriptionId: "psub-1" }));
    await store.insertLedgerEvent({ id: "led-1", idempotencyKey: "admin:1", type: "admin.set_price_override", subscriptionId: "sub-1", companyId: "co-1", rawPayload: { priceCents: 0 } });
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    const next = await applyBillingEvent(deps, sub, { type: "admin.set_price_override", priceCents: 0 }, "led-1");
    expect(next.status).toBe("complimentary");
    expect(cancelNow).toHaveBeenCalledExactlyOnceWith("psub-1");
    expect(await store.listUnappliedLedgerEvents(10)).toEqual([]);
  });

  it("a cancelNow provider outage is logged but never blocks the local transition", async () => {
    const { deps, store, warn } = makeDeps();
    vi.spyOn(deps.provider, "cancelNow").mockRejectedValue(new Error("provider down"));
    await store.insertSubscription(mkSub({ status: "active", providerSubscriptionId: "psub-1" }));
    await store.insertLedgerEvent({ id: "led-1", idempotencyKey: "del:1", type: "company.deleted", subscriptionId: "sub-1", companyId: "co-1", rawPayload: {} });
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    const next = await applyBillingEvent(deps, sub, { type: "company.deleted" }, "led-1");
    expect(next.status).toBe("canceled");
    expect(warn).toHaveBeenCalled();
  });
});

describe("crash-after-insert recovery via ledger replay", () => {
  it("a crash between persist and mark-applied leaves the row unapplied; sweep-style replay is idempotent", async () => {
    const { deps, store, standingCalls } = makeDeps();
    await store.insertSubscription(mkSub({ openCheckoutSessionRef: "sess-1" }));
    const { rawBody, headers } = signedEvent({
      eventId: "e1", type: "checkout.completed", sessionRef: "sess-1", subRef: "psub-1",
      periodEnd: "2026-08-17T12:00:00.000Z", companyId: "co-1",
    });

    // Simulate the process dying at the markLedgerApplied step: the ledger row and the
    // transitioned subscription are already durably persisted (both writes happened before
    // this point), but "applied" is never recorded.
    vi.spyOn(store, "markLedgerApplied").mockImplementationOnce(async () => {
      throw new Error("simulated crash");
    });

    await expect(handleProviderWebhook(deps, { headers, rawBody })).rejects.toThrow("simulated crash");

    // The subscription transition already landed even though the crash happened downstream.
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("active");
    const unapplied = await store.listUnappliedLedgerEvents(10);
    expect(unapplied).toHaveLength(1);
    expect(standingCalls).toEqual([]); // never reached before the crash

    // Sweep replay: reconstruct the event from the persisted ledger row (spyOn's "Once"
    // has been consumed, so markLedgerApplied now behaves normally) and re-run the same
    // one mutating code path.
    const row = unapplied[0];
    const event = billingEventFromLedger(row);
    expect(event).not.toBeNull();
    const subBeforeReplay = (await store.getSubscriptionByCompany("co-1"))!;
    const replayed = await applyBillingEvent(deps, subBeforeReplay, event!, row.id);

    expect(replayed.status).toBe("active");
    expect(replayed.providerSubscriptionId).toBe("psub-1");
    expect(await store.listUnappliedLedgerEvents(10)).toEqual([]);
    expect(standingCalls).toEqual([{ kind: "clear", companyId: "co-1" }]);
  });
});

describe("billingEventFromLedger", () => {
  it("reconstructs webhook and internal events from ledger rows", () => {
    const base = { id: "x", idempotencyKey: "k", subscriptionId: null, companyId: "co-1", appliedAt: null, createdAt: "2026-07-18T00:00:00.000Z" };
    expect(billingEventFromLedger({ ...base, type: "checkout.completed", rawPayload: { sessionRef: "s", subRef: "p", periodEnd: "2026-08-01T00:00:00.000Z" } }))
      .toEqual({ type: "checkout.completed", sessionRef: "s", subRef: "p", periodEnd: "2026-08-01T00:00:00.000Z" });
    expect(billingEventFromLedger({ ...base, type: "payment.succeeded", rawPayload: { subRef: "p", periodEnd: "2026-08-01T00:00:00.000Z" } }))
      .toEqual({ type: "payment.succeeded", subRef: "p", periodEnd: "2026-08-01T00:00:00.000Z" });
    expect(billingEventFromLedger({ ...base, type: "payment.failed", rawPayload: { subRef: "p" } }))
      .toEqual({ type: "payment.failed", subRef: "p" });
    expect(billingEventFromLedger({ ...base, type: "subscription.canceled", rawPayload: { subRef: "p" } }))
      .toEqual({ type: "subscription.canceled", subRef: "p" });
    expect(billingEventFromLedger({ ...base, type: "one_click.activated", rawPayload: { subRef: null, periodEnd: "2026-08-01T00:00:00.000Z" } }))
      .toEqual({ type: "one_click.activated", subRef: null, periodEnd: "2026-08-01T00:00:00.000Z" });
    expect(billingEventFromLedger({ ...base, type: "admin.set_price_override", rawPayload: { priceCents: 0 } }))
      .toEqual({ type: "admin.set_price_override", priceCents: 0 });
    expect(billingEventFromLedger({ ...base, type: "admin.extend_trial", rawPayload: { trialEndsAt: "2026-08-01T00:00:00.000Z" } }))
      .toEqual({ type: "admin.extend_trial", trialEndsAt: "2026-08-01T00:00:00.000Z" });
    expect(billingEventFromLedger({ ...base, type: "owner.cancel_at_period_end", rawPayload: {} }))
      .toEqual({ type: "owner.cancel_at_period_end" });
    expect(billingEventFromLedger({ ...base, type: "owner.resume", rawPayload: {} })).toEqual({ type: "owner.resume" });
    expect(billingEventFromLedger({ ...base, type: "company.deleted", rawPayload: {} })).toEqual({ type: "company.deleted" });
    expect(billingEventFromLedger({ ...base, type: "clock", rawPayload: {} })).toEqual({ type: "clock" });
    // bookkeeping rows never transition
    for (const type of ["subscription.created", "trial.started", "checkout.created"]) {
      expect(billingEventFromLedger({ ...base, type, rawPayload: {} })).toBeNull();
    }
  });
});
