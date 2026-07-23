import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BILLING_CONFIG } from "../src/config.js";
import { MemoryStubStateStore, StubProvider } from "../src/provider/stub.js";
import { ensureSubscriptionForCompany, initialSubscription } from "../src/creation.js";
import { MemoryBillingStore } from "../src/store-memory.js";
import type { ApplyDeps } from "../src/apply.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");
const CONFIG = DEFAULT_BILLING_CONFIG;

describe("initialSubscription — creation matrix", () => {
  const base = { id: "sub-1", companyId: "co-1", ownerUserId: "user-1", ownerHadTrial: false };

  it("owner's first company with first-company-per-owner policy → trialing with trial_ends_at = now + trialDays", () => {
    const sub = initialSubscription(base, CONFIG, NOW);
    expect(sub.status).toBe("trialing");
    expect(sub.trialEndsAt).toBe("2026-07-25T12:00:00.000Z");
  });

  it("owner already used a trial → awaiting_payment", () => {
    const sub = initialSubscription({ ...base, ownerHadTrial: true }, CONFIG, NOW);
    expect(sub.status).toBe("awaiting_payment");
    expect(sub.trialEndsAt).toBeNull();
  });

  it("trialPolicy none → awaiting_payment even for a first company", () => {
    const sub = initialSubscription(base, { ...CONFIG, trialPolicy: "none" }, NOW);
    expect(sub.status).toBe("awaiting_payment");
  });

  it("trialPolicy every-company → trialing even after a previous trial", () => {
    const sub = initialSubscription({ ...base, ownerHadTrial: true }, { ...CONFIG, trialPolicy: "every-company" }, NOW);
    expect(sub.status).toBe("trialing");
  });

  it("priceCentsOverride 0 → complimentary, no trial, no checkout ever", () => {
    const sub = initialSubscription({ ...base, priceCentsOverride: 0 }, CONFIG, NOW);
    expect(sub.status).toBe("complimentary");
    expect(sub.priceCentsOverride).toBe(0);
    expect(sub.trialEndsAt).toBeNull();
  });

  it("zero trialDays never produces a trial", () => {
    const sub = initialSubscription(base, { ...CONFIG, trialDays: 0 }, NOW);
    expect(sub.status).toBe("awaiting_payment");
  });
});

describe("ensureSubscriptionForCompany", () => {
  function makeDeps() {
    const store = new MemoryBillingStore(() => NOW);
    const standingCalls: Array<Record<string, unknown>> = [];
    const deps: ApplyDeps & { owners: { resolveOwnerUserId(companyId: string): Promise<string> } } = {
      store,
      config: CONFIG,
      standing: {
        set: async (companyId, input) => { standingCalls.push({ kind: "set", companyId, status: input.status, reason: input.reason }); },
        clear: async (companyId) => { standingCalls.push({ kind: "clear", companyId }); },
      },
      provider: new StubProvider({ store: new MemoryStubStateStore(), secret: "c".repeat(64), transport: { deliver: async () => {} }, now: () => NOW }),
      logger: { warn: vi.fn() },
      now: () => NOW,
      owners: { resolveOwnerUserId: async () => "user-1" },
    };
    return { deps, store, standingCalls };
  }

  it("creates a trialing row + both ledger rows + informational standing for a first company", async () => {
    const { deps, store, standingCalls } = makeDeps();
    const sub = await ensureSubscriptionForCompany(deps, "co-1");
    expect(sub.status).toBe("trialing");
    const events = await store.listLedgerEventsForCompany("co-1", 10);
    expect(events.map((event) => event.type).sort()).toEqual(["subscription.created", "trial.started"]);
    expect(events.every((event) => event.appliedAt !== null)).toBe(true);
    expect(await store.ownerHadTrial("user-1")).toBe(true);
    expect(standingCalls).toEqual([{ kind: "set", companyId: "co-1", status: "active", reason: "trialing" }]);
  });

  it("second company of the same owner is awaiting_payment and blocked (trial burned via ledger)", async () => {
    const { deps, store, standingCalls } = makeDeps();
    await ensureSubscriptionForCompany(deps, "co-1");
    const second = await ensureSubscriptionForCompany(deps, "co-2");
    expect(second.status).toBe("awaiting_payment");
    expect(standingCalls.at(-1)).toEqual({ kind: "set", companyId: "co-2", status: "blocked", reason: "awaiting_subscription" });
    void store;
  });

  it("is idempotent: an existing row is returned untouched (event + sweep race safety)", async () => {
    const { deps, store } = makeDeps();
    const first = await ensureSubscriptionForCompany(deps, "co-1");
    const again = await ensureSubscriptionForCompany(deps, "co-1");
    expect(again.id).toBe(first.id);
    expect((await store.listLedgerEventsForCompany("co-1", 10))).toHaveLength(2);
  });

  it("trial eligibility survives company deletion: ledger row remains even if the sub row vanished", async () => {
    const { deps, store } = makeDeps();
    await ensureSubscriptionForCompany(deps, "co-1");
    // simulate the trial company being deleted: sub row gone, ledger remains
    await store.updateSubscription({ ...(await store.getSubscriptionByCompany("co-1"))!, companyId: "co-deleted" });
    const second = await ensureSubscriptionForCompany(deps, "co-2");
    expect(second.status).toBe("awaiting_payment");
  });

  it("concurrent calls for the same company converge on one subscription and exactly one trial.started row (race safety)", async () => {
    const { deps, store } = makeDeps();
    const [a, b] = await Promise.all([
      ensureSubscriptionForCompany(deps, "co-1"),
      ensureSubscriptionForCompany(deps, "co-1"),
    ]);
    expect(a.id).toBe(b.id);
    expect((await store.listSubscriptions()).filter((row) => row.companyId === "co-1")).toHaveLength(1);
    const events = await store.listLedgerEventsForCompany("co-1", 10);
    expect(events.filter((event) => event.type === "trial.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "subscription.created")).toHaveLength(1);
    expect(events.every((event) => event.appliedAt !== null)).toBe(true);
  });
});
