import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { WEBHOOK_ENDPOINT_KEY } from "../src/constants.js";
import { MemoryStubStateStore, type StubProvider } from "../src/provider/stub.js";
import { MemoryBillingStore } from "../src/store-memory.js";
import { createWorker } from "../src/worker.js";

const DAY = 86_400_000;
const T0 = new Date("2026-07-18T12:00:00.000Z");

function mkCompany(id: string, owner: string): Company {
  return {
    id, name: `Company ${id}`, description: null, status: "active", pauseReason: null, pausedAt: null,
    issuePrefix: "PC", issueCounter: 0, budgetMonthlyCents: 0, spentMonthlyCents: 0, attachmentMaxBytes: 0,
    defaultResponsibleUserId: owner, requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false, feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null, feedbackDataSharingTermsVersion: null,
    brandColor: null, logoAssetId: null, logoUrl: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"), updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  } as Company;
}

describe("stub provider e2e journey (spec §9)", () => {
  function makeJourney(options: { config?: Record<string, unknown> } = {}) {
    let now = T0;
    let companies: Company[] = [mkCompany("co-1", "user-1")];
    const store = new MemoryBillingStore(() => now);
    const standings: Array<{ kind: string; companyId: string; status?: string; reason?: string }> = [];
    let stub!: StubProvider;

    const plugin = createWorker({
      store,
      stubStateStore: new MemoryStubStateStore(),
      transport: {
        deliver: (headers, rawBody) =>
          plugin.definition.onWebhook!({
            endpointKey: WEBHOOK_ENDPOINT_KEY,
            headers,
            rawBody,
            parsedBody: JSON.parse(rawBody),
            requestId: "req",
          }),
      },
      now: () => now,
      onStubReady: (instance) => { stub = instance; },
    });

    const harness = createTestHarness({ manifest, config: options.config });
    Object.assign(harness.ctx.companies, {
      list: async () => companies,
      // The test-harness default `get` reads from an internal seeded Map that this
      // journey never populates (it drives `companies` directly instead); without
      // this override, ownerResolverFromContext's `ctx.companies.get` fallback
      // would return null for every company and every subscription would resolve
      // to the "local-board" owner instead of "user-1", breaking customer lookups.
      get: async (companyId: string) => companies.find((company) => company.id === companyId) ?? null,
      setStanding: async (companyId: string, input: { status: string; reason: string }) => {
        standings.push({ kind: "set", companyId, status: input.status, reason: input.reason });
      },
      clearStanding: async (companyId: string) => {
        standings.push({ kind: "clear", companyId });
      },
    });

    return {
      plugin,
      harness,
      store,
      standings,
      getStub: () => stub,
      setNow: (d: Date) => { now = d; },
      getNow: () => now,
      addCompany: (id: string) => { companies = [...companies, mkCompany(id, "user-1")]; },
      removeCompany: (id: string) => { companies = companies.filter((company) => company.id !== id); },
      standingFor: (companyId: string) => standings.filter((s) => s.companyId === companyId).at(-1),
    };
  }

  it("runs the full lifecycle end to end", async () => {
    const j = makeJourney();
    await j.plugin.definition.setup(j.harness.ctx);
    const board = { companyId: "co-1", actor: { type: "user" as const, userId: "user-1" } };

    // 1. signup → first company gets a trial via company.created
    await j.harness.emit("company.created", {}, { companyId: "co-1", entityId: "co-1", entityType: "company" });
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("trialing");

    // 2. trial expiry → grace → wall (blocked): runs blocked, reads keep working (standing-only enforcement)
    j.setNow(new Date(T0.getTime() + 8 * DAY));
    await j.harness.runJob("billing-sweep");
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("grace");
    expect(j.standingFor("co-1")).toMatchObject({ kind: "set", status: "grace", reason: "trial_ended" });
    j.setNow(new Date(T0.getTime() + 16 * DAY));
    await j.harness.runJob("billing-sweep");
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("blocked");
    expect(j.standingFor("co-1")).toMatchObject({ kind: "set", status: "blocked" });

    // 3. stub checkout → signed webhook → active → standing cleared (runs unblocked)
    const checkout = await j.harness.performAction<{ sessionRef: string; url: string }>("create-checkout", {}, board);
    expect(checkout.url).toContain("billing-checkout?session=");
    await j.harness.performAction("stub-checkout-complete", { sessionRef: checkout.sessionRef, outcome: "pay", savePaymentMethod: true }, board);
    const activated = (await j.store.getSubscriptionByCompany("co-1"))!;
    expect(activated.status).toBe("active");
    expect(activated.providerSubscriptionId).not.toBeNull();
    expect(j.standingFor("co-1")).toEqual({ kind: "clear", companyId: "co-1" });

    // 4. second company, card on file → blocked on creation, then one-click activates
    j.addCompany("co-2");
    await j.harness.emit("company.created", {}, { companyId: "co-2", entityId: "co-2", entityType: "company" });
    expect((await j.store.getSubscriptionByCompany("co-2"))!.status).toBe("awaiting_payment"); // no second trial
    expect(j.standingFor("co-2")).toMatchObject({ kind: "set", status: "blocked", reason: "awaiting_subscription" });
    const oneClick = await j.harness.performAction<{ status: string }>("one-click-subscribe", {}, { ...board, companyId: "co-2" });
    expect(oneClick.status).toBe("active");
    expect((await j.store.getSubscriptionByCompany("co-2"))!.status).toBe("active");
    expect(j.standingFor("co-2")).toEqual({ kind: "clear", companyId: "co-2" });

    // 5. SCA requires_action path on a third company
    const summary1 = await j.harness.getData<{ hasDefaultPaymentMethod: boolean }>("billing-summary", { companyId: "co-1" });
    expect(summary1.hasDefaultPaymentMethod).toBe(true);
    j.addCompany("co-3");
    await j.harness.emit("company.created", {}, { companyId: "co-3", entityId: "co-3", entityType: "company" });
    const customer = (await j.store.getCustomerByUser("stub", "user-1"))!;
    await j.getStub().setScaRequired(customer.providerCustomerId, true);
    const sca = await j.harness.performAction<{ status: string; url?: string }>("one-click-subscribe", {}, { ...board, companyId: "co-3" });
    expect(sca.status).toBe("requires_action");
    const scaSessionRef = new URL(sca.url!, "http://x.invalid").searchParams.get("session")!;
    await j.harness.performAction("stub-checkout-complete", { sessionRef: scaSessionRef, outcome: "pay", savePaymentMethod: false }, { ...board, companyId: "co-3" });
    expect((await j.store.getSubscriptionByCompany("co-3"))!.status).toBe("active");
    await j.getStub().setScaRequired(customer.providerCustomerId, false);

    // 6. renewal: payment.succeeded extends the period
    const beforeRenewal = (await j.store.getSubscriptionByCompany("co-1"))!;
    j.setNow(new Date(Date.parse(beforeRenewal.currentPeriodEnd!) + DAY));
    await j.harness.runJob("billing-sweep");
    const renewed = (await j.store.getSubscriptionByCompany("co-1"))!;
    expect(Date.parse(renewed.currentPeriodEnd!)).toBeGreaterThan(Date.parse(beforeRenewal.currentPeriodEnd!));
    expect(renewed.status).toBe("active");

    // 7. cancel at period end → "ends on" state → resume clears it
    const afterCancel = await j.harness.performAction<{ cancelAtPeriodEnd: boolean }>("cancel-at-period-end", {}, board);
    expect(afterCancel.cancelAtPeriodEnd).toBe(true);
    const afterResume = await j.harness.performAction<{ cancelAtPeriodEnd: boolean }>("resume-subscription", {}, board);
    expect(afterResume.cancelAtPeriodEnd).toBe(false);

    // 8. company deletion → local cancel + provider cancel (sweep-only: no company.deleted event exists)
    j.removeCompany("co-2");
    await j.harness.runJob("billing-sweep");
    expect((await j.store.getSubscriptionByCompany("co-2"))!.status).toBe("canceled");

    // 9. provider-side cancellation → resubscribe (canceled → checkout → active)
    const sub1 = (await j.store.getSubscriptionByCompany("co-1"))!;
    await j.getStub().cancelNow(sub1.providerSubscriptionId!);
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("canceled");
    expect(j.standingFor("co-1")).toMatchObject({ kind: "set", status: "blocked", reason: "subscription_ended" });
    const resub = await j.harness.performAction<{ sessionRef: string }>("create-checkout", {}, board);
    await j.harness.performAction("stub-checkout-complete", { sessionRef: resub.sessionRef, outcome: "pay", savePaymentMethod: false }, board);
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("active");
    expect(j.standingFor("co-1")).toEqual({ kind: "clear", companyId: "co-1" });
  }, 30_000);

  it("payment failure → dunning → auto-unblock, plus failed/canceled checkout leaves state unchanged", async () => {
    const j = makeJourney({ config: { trialPolicy: "none" } });
    await j.plugin.definition.setup(j.harness.ctx);
    const board = { companyId: "co-1", actor: { type: "user" as const, userId: "user-1" } };

    // creation → awaiting_payment; a failed then canceled checkout changes nothing
    await j.harness.runJob("billing-sweep");
    const checkout = await j.harness.performAction<{ sessionRef: string }>("create-checkout", {}, board);
    await j.harness.performAction("stub-checkout-complete", { sessionRef: checkout.sessionRef, outcome: "fail" }, board);
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("awaiting_payment");
    await j.harness.performAction("stub-checkout-complete", { sessionRef: checkout.sessionRef, outcome: "cancel" }, board);
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("awaiting_payment");

    // canceled session expired → next create-checkout mints a fresh session and pays
    const fresh = await j.harness.performAction<{ sessionRef: string }>("create-checkout", {}, board);
    expect(fresh.sessionRef).not.toBe(checkout.sessionRef);
    await j.harness.performAction("stub-checkout-complete", { sessionRef: fresh.sessionRef, outcome: "pay", savePaymentMethod: false }, board);
    const active = (await j.store.getSubscriptionByCompany("co-1"))!;
    expect(active.status).toBe("active");

    // renewal fails → grace (dunning); retry a day later succeeds → active, standing cleared (auto-unblock)
    await j.getStub().setFailNextRenewal(active.providerSubscriptionId!, true);
    const failAt = new Date(Date.parse(active.currentPeriodEnd!) + 1);
    j.setNow(failAt);
    await j.harness.runJob("billing-sweep");
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("grace");
    expect(j.standingFor("co-1")).toMatchObject({ kind: "set", status: "grace", reason: "payment_past_due" });

    await j.getStub().setFailNextRenewal(active.providerSubscriptionId!, false);
    j.setNow(new Date(failAt.getTime() + DAY));
    await j.harness.runJob("billing-sweep");
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("active");
    expect(j.standingFor("co-1")).toEqual({ kind: "clear", companyId: "co-1" });
  }, 30_000);
});
