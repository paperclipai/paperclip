import { describe, expect, it } from "vitest";
import { CHECKOUT_PAGE_ROUTE, STUB_SIGNATURE_HEADER } from "../src/constants.js";
import { WebhookVerificationError, signStubPayload } from "../src/hmac.js";
import {
  MemoryStubStateStore,
  StubProvider,
  type StubState,
  type StubStateSnapshot,
  type StubStateStore,
  emptyStubState,
} from "../src/provider/stub.js";

const SECRET = "a".repeat(64);
const NOW = new Date("2026-07-18T12:00:00.000Z");
const DAY = 86_400_000;

interface Delivery { headers: Record<string, string>; body: Record<string, unknown>; rawBody: string; }

function makeStub(options: { failDeliveries?: number } = {}) {
  const deliveries: Delivery[] = [];
  let failures = options.failDeliveries ?? 0;
  let now = NOW;
  const store = new MemoryStubStateStore();
  const provider = new StubProvider({
    store,
    secret: SECRET,
    transport: {
      async deliver(headers, rawBody) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("connection refused");
        }
        deliveries.push({ headers, rawBody, body: JSON.parse(rawBody) as Record<string, unknown> });
      },
    },
    now: () => now,
  });
  return { provider, store, deliveries, setNow: (d: Date) => { now = d; } };
}

async function subscribedCompany(stub: ReturnType<typeof makeStub>) {
  const { customerId } = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
  const { sessionRef } = await stub.provider.createCheckout({
    customerId, companyId: "co-1", priceCents: 4900, currency: "EUR",
    successUrl: "company/settings/billing?checkout=success&session={SESSION_REF}",
    cancelUrl: "company/settings/billing?checkout=cancel",
  });
  await stub.provider.completeCheckout(sessionRef, { savePaymentMethod: false });
  const event = stub.deliveries.at(-1)!.body as { subRef: string; periodEnd: string };
  return { customerId, sessionRef, subRef: event.subRef, periodEnd: event.periodEnd };
}

describe("StubProvider — customers and checkout", () => {
  it("ensureCustomer is idempotent per user", async () => {
    const stub = makeStub();
    const first = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    const second = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    expect(second.customerId).toBe(first.customerId);
  });

  it("createCheckout opens a session, substitutes {SESSION_REF}, and returns the simulator url", async () => {
    const stub = makeStub();
    const { customerId } = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    const { url, sessionRef } = await stub.provider.createCheckout({
      customerId, companyId: "co-1", priceCents: 4900, currency: "EUR",
      trialEndsAt: new Date("2026-07-25T12:00:00.000Z"),
      successUrl: "company/settings/billing?checkout=success&session={SESSION_REF}",
      cancelUrl: "company/settings/billing?checkout=cancel",
    });
    expect(url).toBe(`${CHECKOUT_PAGE_ROUTE}?session=${sessionRef}`);
    const session = await stub.provider.getSession(sessionRef);
    expect(session).toMatchObject({
      status: "open", kind: "checkout", companyId: "co-1", priceCents: 4900,
      trialEndsAtIso: "2026-07-25T12:00:00.000Z",
      successUrl: `company/settings/billing?checkout=success&session=${sessionRef}`,
    });
    expect(await stub.provider.resolveCheckout(sessionRef)).toBe("open");
    expect(await stub.provider.resolveCheckout("sess_unknown")).toBe("expired");
  });

  it("completeCheckout emits a correctly signed checkout.completed honoring trialEndsAt, and saves the payment method", async () => {
    const stub = makeStub();
    const { customerId } = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    const { sessionRef } = await stub.provider.createCheckout({
      customerId, companyId: "co-1", priceCents: 4900, currency: "EUR",
      trialEndsAt: new Date("2026-07-25T12:00:00.000Z"),
      successUrl: "s?session={SESSION_REF}", cancelUrl: "c",
    });
    await stub.provider.completeCheckout(sessionRef, { savePaymentMethod: true });

    expect(stub.deliveries).toHaveLength(1);
    const { headers, rawBody, body } = stub.deliveries[0];
    expect(headers[STUB_SIGNATURE_HEADER]).toBe(signStubPayload(SECRET, rawBody));
    expect(body).toMatchObject({
      type: "checkout.completed",
      sessionRef,
      companyId: "co-1",
      periodEnd: "2026-07-25T12:00:00.000Z", // billing starts when the trial ends
    });
    expect(typeof body.subRef).toBe("string");
    expect(typeof body.eventId).toBe("string");
    expect(await stub.provider.resolveCheckout(sessionRef)).toBe("complete");
    expect(await stub.provider.customerHasSavedMethod(customerId)).toBe(true);
  });

  it("failCheckout records the decline and keeps the session open; cancelCheckout expires it silently", async () => {
    const stub = makeStub();
    const { customerId } = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    const a = await stub.provider.createCheckout({ customerId, companyId: "co-1", priceCents: 4900, currency: "EUR", successUrl: "s?session={SESSION_REF}", cancelUrl: "c" });
    await stub.provider.failCheckout(a.sessionRef);
    expect((await stub.provider.getSession(a.sessionRef))?.lastError).toBe("card_declined");
    expect(await stub.provider.resolveCheckout(a.sessionRef)).toBe("open");
    await stub.provider.cancelCheckout(a.sessionRef);
    expect(await stub.provider.resolveCheckout(a.sessionRef)).toBe("expired");
    expect(stub.deliveries).toHaveLength(0); // neither fail nor cancel changes state via webhook
  });
});

describe("StubProvider — saved method and SCA", () => {
  it("subscribeWithSavedMethod activates immediately and emits payment.succeeded", async () => {
    const stub = makeStub();
    const { customerId } = await subscribedCompany(stub);
    // saved method was not stored above; store it now
    await stub.provider.setSavedMethod(customerId, true);
    const result = await stub.provider.subscribeWithSavedMethod({ customerId, companyId: "co-2", priceCents: 4900, currency: "EUR" });
    expect(result).toEqual({ status: "active" });
    const event = stub.deliveries.at(-1)!.body;
    expect(event).toMatchObject({ type: "payment.succeeded", companyId: "co-2" });
    expect(typeof event.subRef).toBe("string");
  });

  it("rejects one-click without a saved method", async () => {
    const stub = makeStub();
    const { customerId } = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    await expect(
      stub.provider.subscribeWithSavedMethod({ customerId, companyId: "co-2", priceCents: 4900, currency: "EUR" }),
    ).rejects.toThrow("no saved payment method");
  });

  it("requires_action branch returns an SCA session whose completion emits checkout.completed", async () => {
    const stub = makeStub();
    const { customerId } = await subscribedCompany(stub);
    await stub.provider.setSavedMethod(customerId, true);
    await stub.provider.setScaRequired(customerId, true);
    const result = await stub.provider.subscribeWithSavedMethod({ customerId, companyId: "co-3", priceCents: 4900, currency: "EUR" });
    if (result.status !== "requires_action") throw new Error("expected requires_action");
    const sessionRef = new URL(result.url, "http://x.invalid").searchParams.get("session")!;
    expect((await stub.provider.getSession(sessionRef))?.kind).toBe("sca");
    await stub.provider.completeCheckout(sessionRef, { savePaymentMethod: false });
    expect(stub.deliveries.at(-1)!.body).toMatchObject({ type: "checkout.completed", sessionRef, companyId: "co-3" });
  });
});

describe("StubProvider — renewals, dunning, cancellation", () => {
  it("deliverDue renews an active subscription: payment.succeeded, +30 days, next renewal scheduled", async () => {
    const stub = makeStub();
    const { subRef, periodEnd } = await subscribedCompany(stub);
    stub.setNow(new Date(Date.parse(periodEnd) + 1));
    const delivered = await stub.provider.deliverDue(new Date(Date.parse(periodEnd) + 1));
    expect(delivered).toBe(1);
    const renewal = stub.deliveries.at(-1)!.body as { type: string; subRef: string; periodEnd: string };
    expect(renewal.type).toBe("payment.succeeded");
    expect(renewal.subRef).toBe(subRef);
    expect(Date.parse(renewal.periodEnd)).toBe(Date.parse(periodEnd) + 30 * DAY);
    // and nothing more is due until the new period end
    expect(await stub.provider.deliverDue(new Date(Date.parse(periodEnd) + 2))).toBe(0);
  });

  it("failNextRenewal produces payment.failed with a delayed retry that succeeds after the flag clears", async () => {
    const stub = makeStub();
    const { subRef, periodEnd } = await subscribedCompany(stub);
    await stub.provider.setFailNextRenewal(subRef, true);
    const dueAt = new Date(Date.parse(periodEnd) + 1);
    await stub.provider.deliverDue(dueAt);
    expect(stub.deliveries.at(-1)!.body).toMatchObject({ type: "payment.failed", subRef });
    // delayed dunning retry: due one day later, not immediately
    expect(await stub.provider.deliverDue(dueAt)).toBe(0);
    await stub.provider.setFailNextRenewal(subRef, false);
    const retryAt = new Date(dueAt.getTime() + DAY);
    expect(await stub.provider.deliverDue(retryAt)).toBe(1);
    expect(stub.deliveries.at(-1)!.body).toMatchObject({ type: "payment.succeeded", subRef });
  });

  it("cancelAtPeriodEnd converts the next renewal into subscription.canceled; resume restores renewals", async () => {
    const stub = makeStub();
    const { subRef, periodEnd } = await subscribedCompany(stub);
    await stub.provider.cancelAtPeriodEnd(subRef);
    await stub.provider.resume(subRef);
    await stub.provider.cancelAtPeriodEnd(subRef);
    await stub.provider.deliverDue(new Date(Date.parse(periodEnd) + 1));
    expect(stub.deliveries.at(-1)!.body).toMatchObject({ type: "subscription.canceled", subRef });
  });

  it("cancelNow emits subscription.canceled immediately and drops pending renewals", async () => {
    const stub = makeStub();
    const { subRef, periodEnd } = await subscribedCompany(stub);
    await stub.provider.cancelNow(subRef);
    expect(stub.deliveries.at(-1)!.body).toMatchObject({ type: "subscription.canceled", subRef });
    expect(await stub.provider.deliverDue(new Date(Date.parse(periodEnd) + 1))).toBe(0);
  });

  it("re-queues the raw signed body when the transport fails and redelivers it on deliverDue", async () => {
    const stub = makeStub({ failDeliveries: 1 });
    const { customerId } = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    const { sessionRef } = await stub.provider.createCheckout({ customerId, companyId: "co-1", priceCents: 4900, currency: "EUR", successUrl: "s?session={SESSION_REF}", cancelUrl: "c" });
    await stub.provider.completeCheckout(sessionRef, { savePaymentMethod: false }); // delivery fails silently
    expect(stub.deliveries).toHaveLength(0);
    await stub.provider.deliverDue(NOW);
    expect(stub.deliveries).toHaveLength(1);
    const { headers, rawBody, body } = stub.deliveries[0];
    expect(body).toMatchObject({ type: "checkout.completed", sessionRef });
    expect(headers[STUB_SIGNATURE_HEADER]).toBe(signStubPayload(SECRET, rawBody));
  });
});

describe("StubProvider — optimistic concurrency", () => {
  it("interleaved mutations do not lose writes (compare-and-swap + retry)", async () => {
    const stub = makeStub();
    // Two mutations that each read-modify-write the singleton state. Running them
    // concurrently interleaves their load/save around the awaits: without CAS the
    // second save would clobber the first. Each ensureCustomer appends a distinct
    // customer, so a lost write would drop one of them.
    await Promise.all([
      stub.provider.ensureCustomer({ id: "user-1", email: "a@x.invalid", name: "A" }),
      stub.provider.ensureCustomer({ id: "user-2", email: "b@x.invalid", name: "B" }),
    ]);

    const first = await stub.provider.ensureCustomer({ id: "user-1", email: "a@x.invalid", name: "A" });
    const second = await stub.provider.ensureCustomer({ id: "user-2", email: "b@x.invalid", name: "B" });
    // Idempotent per user AND both survived: neither concurrent insert was lost.
    const { state } = await stub.store.load();
    expect(state.customers.map((c) => c.userId).sort()).toEqual(["user-1", "user-2"]);
    expect(state.customers.find((c) => c.userId === "user-1")!.customerId).toBe(first.customerId);
    expect(state.customers.find((c) => c.userId === "user-2")!.customerId).toBe(second.customerId);
  });

  it("rethrows a clear error when the retry budget is exhausted", async () => {
    // A store whose save always reports a conflict forces the retry loop to give up.
    const alwaysConflict = {
      load: async () => ({ state: emptyStubState(), version: 0 }),
      save: async () => false,
    };
    const provider = new StubProvider({
      store: alwaysConflict,
      secret: SECRET,
      transport: { deliver: async () => {} },
      now: () => NOW,
    });
    await expect(
      provider.ensureCustomer({ id: "user-1", email: "a@x.invalid", name: "A" }),
    ).rejects.toThrow(/optimistic concurrency retries exhausted/);
  });
});

describe("StubProvider — CAS collision emit-after-commit", () => {
  /**
   * Wraps a real store and forces the next N `save` calls to report a version
   * conflict (as a concurrent writer would), so `mutate` reloads and re-runs its
   * callback. A regression that emits/mints INSIDE the callback would fire twice.
   */
  class ForcedCollisionStore implements StubStateStore {
    private collisions = 0;
    constructor(private readonly inner: StubStateStore) {}
    armCollisions(n: number): void { this.collisions = n; }
    load(): Promise<StubStateSnapshot> { return this.inner.load(); }
    async save(state: StubState, expectedVersion: number): Promise<boolean> {
      if (this.collisions > 0) { this.collisions -= 1; return false; }
      return this.inner.save(state, expectedVersion);
    }
  }

  function makeCollidingStub() {
    const store = new ForcedCollisionStore(new MemoryStubStateStore());
    const events: Array<Record<string, unknown>> = [];
    const provider = new StubProvider({
      store,
      secret: SECRET,
      transport: { async deliver(_headers, rawBody) { events.push(JSON.parse(rawBody) as Record<string, unknown>); } },
      now: () => NOW,
    });
    return { store, events, provider };
  }

  it("completeCheckout emits ONE subRef across a CAS retry, matching the persisted subscription", async () => {
    const { store, events, provider } = makeCollidingStub();
    const { customerId } = await provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    const { sessionRef } = await provider.createCheckout({
      customerId, companyId: "co-1", priceCents: 4900, currency: "EUR",
      successUrl: "s?session={SESSION_REF}", cancelUrl: "c",
    });

    store.armCollisions(1); // force exactly one CAS collision inside completeCheckout's mutate
    await provider.completeCheckout(sessionRef, { savePaymentMethod: false });

    const checkoutEvents = events.filter((e) => e.type === "checkout.completed");
    expect(checkoutEvents).toHaveLength(1); // reverting the fix emits two (one per attempt)
    const emittedSubRef = checkoutEvents[0].subRef as string;

    const { state } = await store.load();
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0].subRef).toBe(emittedSubRef); // emitted ref === persisted ref

    // cancel against the emitted subRef must FIND the sub (not silently no-op).
    await provider.cancelNow(emittedSubRef);
    expect(events.filter((e) => e.type === "subscription.canceled")).toHaveLength(1);
  });

  it("subscribeWithSavedMethod emits ONE subRef across a CAS retry, matching the persisted subscription", async () => {
    const { store, events, provider } = makeCollidingStub();
    const { customerId } = await provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    await provider.setSavedMethod(customerId, true);

    store.armCollisions(1); // force exactly one CAS collision inside subscribeWithSavedMethod's mutate
    const result = await provider.subscribeWithSavedMethod({ customerId, companyId: "co-2", priceCents: 4900, currency: "EUR" });
    expect(result).toEqual({ status: "active" });

    const paymentEvents = events.filter((e) => e.type === "payment.succeeded");
    expect(paymentEvents).toHaveLength(1); // reverting the fix emits two (one per attempt)
    const emittedSubRef = paymentEvents[0].subRef as string;

    const { state } = await store.load();
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0].subRef).toBe(emittedSubRef);

    await provider.cancelNow(emittedSubRef);
    expect(events.filter((e) => e.type === "subscription.canceled")).toHaveLength(1);
  });
});

describe("StubProvider — verifyAndParseWebhook", () => {
  function signed(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, headers: { [STUB_SIGNATURE_HEADER]: signStubPayload(SECRET, rawBody) } };
  }

  it("parses each of the four event types", () => {
    const stub = makeStub();
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        { eventId: "e1", type: "checkout.completed", sessionRef: "s1", subRef: "p1", periodEnd: "2026-08-18T12:00:00.000Z", companyId: "co-1" },
        { type: "checkout.completed", sessionRef: "s1", subRef: "p1", periodEnd: "2026-08-18T12:00:00.000Z" },
      ],
      [
        { eventId: "e2", type: "payment.succeeded", subRef: "p1", periodEnd: "2026-09-17T12:00:00.000Z", companyId: "co-1" },
        { type: "payment.succeeded", subRef: "p1", periodEnd: "2026-09-17T12:00:00.000Z" },
      ],
      [{ eventId: "e3", type: "payment.failed", subRef: "p1", companyId: "co-1" }, { type: "payment.failed", subRef: "p1" }],
      [{ eventId: "e4", type: "subscription.canceled", subRef: "p1", companyId: "co-1" }, { type: "subscription.canceled", subRef: "p1" }],
    ];
    for (const [body, expected] of cases) {
      const { rawBody, headers } = signed(body);
      expect(stub.provider.verifyAndParseWebhook(headers, rawBody)).toEqual(expected);
    }
  });

  it("throws WebhookVerificationError on missing/invalid signature or tampered body — never returns", () => {
    const stub = makeStub();
    const { rawBody, headers } = signed({ eventId: "e1", type: "payment.failed", subRef: "p1" });
    expect(() => stub.provider.verifyAndParseWebhook({}, rawBody)).toThrow(WebhookVerificationError);
    expect(() => stub.provider.verifyAndParseWebhook({ [STUB_SIGNATURE_HEADER]: "00" }, rawBody)).toThrow(WebhookVerificationError);
    expect(() => stub.provider.verifyAndParseWebhook(headers, rawBody.replace("p1", "p2"))).toThrow(WebhookVerificationError);
  });

  it("throws on a validly-signed but unknown event type", () => {
    const stub = makeStub();
    const { rawBody, headers } = signed({ eventId: "e1", type: "invoice.finalized" });
    expect(() => stub.provider.verifyAndParseWebhook(headers, rawBody)).toThrow("unknown stub event type");
  });
});
