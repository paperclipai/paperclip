import { describe, expect, it } from "vitest";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { DB_NAMESPACE } from "../src/constants.js";
import { SqlBillingStore } from "../src/store-sql.js";

interface Recorded { sql: string; params?: unknown[]; }

function fakeDb(options: { rows?: Record<string, unknown>[]; rowCount?: number } = {}) {
  const queries: Recorded[] = [];
  const executes: Recorded[] = [];
  const db: PluginDatabaseClient = {
    namespace: DB_NAMESPACE,
    async query(sql, params) {
      queries.push({ sql, params });
      return (options.rows ?? []) as never[];
    },
    async execute(sql, params) {
      executes.push({ sql, params });
      return { rowCount: options.rowCount ?? 1 };
    },
  };
  return { db, queries, executes };
}

const DB_SUB_ROW = {
  id: "sub-1",
  company_id: "co-1",
  owner_user_id: "user-1",
  customer_id: null,
  status: "trialing",
  trial_ends_at: "2026-07-25T12:00:00.000Z",
  grace_since: null,
  current_period_end: null,
  cancel_at_period_end: false,
  price_cents_override: null,
  provider_subscription_id: null,
  open_checkout_session_ref: null,
  open_checkout_url: null,
  created_at: "2026-07-18T00:00:00.000Z",
  updated_at: "2026-07-18T00:00:00.000Z",
};

describe("SqlBillingStore", () => {
  it("maps a snake_case subscription row to the domain shape", async () => {
    const { db } = fakeDb({ rows: [DB_SUB_ROW] });
    const sub = await new SqlBillingStore(db).getSubscriptionByCompany("co-1");
    expect(sub).toEqual({
      id: "sub-1",
      companyId: "co-1",
      ownerUserId: "user-1",
      customerId: null,
      status: "trialing",
      trialEndsAt: "2026-07-25T12:00:00.000Z",
      graceSince: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      priceCentsOverride: null,
      providerSubscriptionId: null,
      openCheckoutSessionRef: null,
      openCheckoutUrl: null,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
  });

  it("every query and execute is namespace-qualified and parameterized", async () => {
    const { db, queries, executes } = fakeDb({ rows: [] });
    const store = new SqlBillingStore(db);
    await store.getSubscriptionByCompany("co-1");
    await store.getSubscriptionByProviderRef("psub-1");
    await store.getSubscriptionBySessionRef("sess-1");
    await store.listSubscriptions();
    await store.getCustomerByUser("stub", "user-1");
    await store.listUnappliedLedgerEvents(50);
    await store.listLedgerEventsForCompany("co-1", 20);
    await store.ownerHadTrial("user-1");
    await store.markLedgerApplied("ev-1", "2026-07-18T12:00:00.000Z");
    for (const recorded of [...queries, ...executes]) {
      expect(recorded.sql).toContain(`${DB_NAMESPACE}.`);
      expect(recorded.sql).not.toMatch(/'\$\{|" \+ /); // no string interpolation of values
    }
    const byCompany = queries[0];
    expect(byCompany.sql).toContain("WHERE company_id = $1");
    expect(byCompany.params).toEqual(["co-1"]);
  });

  it("getSubscriptionByProviderRef/BySessionRef never match null refs — explicit IS NOT NULL guard, no query on null arg", async () => {
    const { db, queries } = fakeDb({ rows: [] });
    const store = new SqlBillingStore(db);

    const byProvider = await store.getSubscriptionByProviderRef("psub-1");
    expect(byProvider).toBeNull();
    expect(queries[0].sql).toContain("provider_subscription_id IS NOT NULL AND provider_subscription_id = $1");
    expect(queries[0].params).toEqual(["psub-1"]);

    const bySession = await store.getSubscriptionBySessionRef("sess-1");
    expect(bySession).toBeNull();
    expect(queries[1].sql).toContain("open_checkout_session_ref IS NOT NULL AND open_checkout_session_ref = $1");
    expect(queries[1].params).toEqual(["sess-1"]);

    // Early JS null-arg guard: no query issued at all for null/undefined refs.
    const preCount = queries.length;
    expect(await store.getSubscriptionByProviderRef(null as unknown as string)).toBeNull();
    expect(await store.getSubscriptionByProviderRef(undefined as unknown as string)).toBeNull();
    expect(await store.getSubscriptionBySessionRef(null as unknown as string)).toBeNull();
    expect(await store.getSubscriptionBySessionRef(undefined as unknown as string)).toBeNull();
    expect(queries.length).toBe(preCount);
  });

  it("insertLedgerEvent uses ON CONFLICT DO NOTHING and reports duplicate on rowCount 0", async () => {
    const inserted = fakeDb({ rowCount: 1 });
    const dup = fakeDb({ rowCount: 0 });
    const event = { id: "ev-1", idempotencyKey: "k", type: "t", subscriptionId: null, companyId: null, rawPayload: { a: 1 } };
    expect(await new SqlBillingStore(inserted.db).insertLedgerEvent(event)).toBe("inserted");
    expect(await new SqlBillingStore(dup.db).insertLedgerEvent(event)).toBe("duplicate");
    expect(inserted.executes[0].sql).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(inserted.executes[0].params?.[5]).toBe(JSON.stringify({ a: 1 }));
  });

  it("upsertCustomer conflicts on (provider, user_id) and RETURNs the surviving stored id", async () => {
    // The driver echoes the stored row's id (the winner of a concurrent insert),
    // which may differ from the locally-minted id the caller passed in.
    const { db, queries } = fakeDb({ rows: [{ id: "stored-winner" }] });
    const returned = await new SqlBillingStore(db).upsertCustomer({ id: "cust-local", userId: "user-1", provider: "stub", providerCustomerId: "sc-1", hasDefaultPaymentMethod: true });
    expect(queries[0].sql).toContain("ON CONFLICT (provider, user_id) DO UPDATE");
    expect(queries[0].sql).toContain("RETURNING id");
    // id is NOT in the DO UPDATE SET, so RETURNING reflects the surviving row id.
    expect(queries[0].sql).not.toMatch(/SET[^)]*\bid\s*=/);
    expect(returned).toBe("stored-winner");
  });

  it("insert and update write all subscription columns", async () => {
    const { db, executes } = fakeDb();
    const store = new SqlBillingStore(db);
    const sub = {
      id: "sub-1", companyId: "co-1", ownerUserId: "user-1", customerId: "cust-1",
      status: "active" as const, trialEndsAt: null, graceSince: null,
      currentPeriodEnd: "2026-08-18T12:00:00.000Z", cancelAtPeriodEnd: false,
      priceCentsOverride: 9900, providerSubscriptionId: "psub-1",
      openCheckoutSessionRef: null, openCheckoutUrl: null,
      createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z",
    };
    await store.insertSubscription(sub);
    await store.updateSubscription(sub);
    expect(executes[0].sql).toContain(`INSERT INTO ${DB_NAMESPACE}.subscriptions`);
    expect(executes[0].params).toEqual([
      sub.id, sub.companyId, sub.ownerUserId, sub.customerId, sub.status, sub.trialEndsAt, sub.graceSince,
      sub.currentPeriodEnd, sub.cancelAtPeriodEnd, sub.priceCentsOverride, sub.providerSubscriptionId,
      sub.openCheckoutSessionRef, sub.openCheckoutUrl, sub.createdAt, sub.updatedAt,
    ]);
    expect(executes[1].sql).toContain(`UPDATE ${DB_NAMESPACE}.subscriptions`);
    expect(executes[1].sql).toContain("WHERE id = $1");
    expect(executes[1].params?.[0]).toBe("sub-1");
    expect(executes[1].params).toEqual([
      sub.id, sub.customerId, sub.status, sub.trialEndsAt, sub.graceSince, sub.currentPeriodEnd,
      sub.cancelAtPeriodEnd, sub.priceCentsOverride, sub.providerSubscriptionId,
      sub.openCheckoutSessionRef, sub.openCheckoutUrl, sub.updatedAt,
    ]);
  });

  it("normalizes Date values from the driver to ISO strings", async () => {
    const { db } = fakeDb({ rows: [{ ...DB_SUB_ROW, trial_ends_at: new Date("2026-07-25T12:00:00.000Z") }] });
    const sub = await new SqlBillingStore(db).getSubscriptionByCompany("co-1");
    expect(sub?.trialEndsAt).toBe("2026-07-25T12:00:00.000Z");
  });
});
