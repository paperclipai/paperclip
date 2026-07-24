import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { MemoryBillingStore } from "../src/store-memory.js";
import { MemoryStubStateStore } from "../src/provider/stub.js";
import { createWorker } from "../src/worker.js";
import { WEBHOOK_ENDPOINT_KEY } from "../src/constants.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");

function mkCompany(id: string): Company {
  return {
    id,
    name: `Company ${id}`,
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "PC",
    issueCounter: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 0,
    defaultResponsibleUserId: "user-1",
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  } as Company;
}

async function makeWorker() {
  const store = new MemoryBillingStore(() => NOW);
  const stubStateStore = new MemoryStubStateStore();
  const standingCalls: Array<Record<string, unknown>> = [];

  const plugin = createWorker({
    store,
    stubStateStore,
    transport: {
      deliver: (headers, rawBody) =>
        plugin.definition.onWebhook!({
          endpointKey: WEBHOOK_ENDPOINT_KEY,
          headers,
          rawBody,
          parsedBody: JSON.parse(rawBody),
          requestId: "req-1",
        }),
    },
    now: () => NOW,
  });

  const harness = createTestHarness({ manifest });
  Object.assign(harness.ctx.companies, {
    setStanding: async (companyId: string, input: Record<string, unknown>) => {
      standingCalls.push({ kind: "set", companyId, ...input });
    },
    clearStanding: async (companyId: string) => {
      standingCalls.push({ kind: "clear", companyId });
    },
  });
  harness.seed({ companies: [mkCompany("co-1"), mkCompany("co-2")] });
  await plugin.definition.setup(harness.ctx);
  return { plugin, harness, store, standingCalls };
}

describe("worker wiring", () => {
  it("company.created event creates the subscription row and writes standing", async () => {
    const { harness, store, standingCalls } = await makeWorker();
    await harness.emit("company.created", { name: "Company co-1" }, { companyId: "co-1", entityId: "co-1", entityType: "company" });
    expect(await store.getSubscriptionByCompany("co-1")).toMatchObject({ status: "trialing", ownerUserId: "user-1" });
    expect(standingCalls.at(-1)).toMatchObject({ kind: "set", status: "active", reason: "trialing" });
  });

  it("billing-sweep job runs the sweep (rowless pickup for both seeded companies)", async () => {
    const { harness, store } = await makeWorker();
    await harness.runJob("billing-sweep");
    expect(await store.getSubscriptionByCompany("co-1")).not.toBeNull();
    expect(await store.getSubscriptionByCompany("co-2")).not.toBeNull();
  });

  it("paginates past the host's per-call company limit instead of wrongly canceling companies beyond it", async () => {
    // Regression for the phase-4 wrong-cancellation bug: ctx.companies.list
    // only returns 500 rows per call, so the sweep's own companies.list
    // adapter (worker.ts) must page to completion. Seed 501 companies —
    // one past a single 500-row page — with an existing, active
    // subscription on the 501st. If the adapter stopped at page 1, that
    // company would look "deleted" and get force-canceled.
    const store = new MemoryBillingStore(() => NOW);
    const stubStateStore = new MemoryStubStateStore();
    const plugin = createWorker({ store, stubStateStore, now: () => NOW });
    const harness = createTestHarness({ manifest });
    Object.assign(harness.ctx.companies, {
      setStanding: async () => {},
      clearStanding: async () => {},
    });
    const companies = Array.from({ length: 501 }, (_, i) => mkCompany(`co-page-${i + 1}`));
    harness.seed({ companies });
    await plugin.definition.setup(harness.ctx);

    const lastCompanyId = companies[companies.length - 1]!.id;
    await store.insertSubscription({
      id: "sub-last", companyId: lastCompanyId, ownerUserId: "user-1", customerId: "cust-1",
      status: "active", trialEndsAt: null, graceSince: null,
      currentPeriodEnd: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
      cancelAtPeriodEnd: false, priceCentsOverride: null, providerSubscriptionId: "psub-last",
      openCheckoutSessionRef: null, openCheckoutUrl: null,
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    });

    await harness.runJob("billing-sweep");

    // rowless pickup ran for every company, not just the first page
    expect(await store.getSubscriptionByCompany("co-page-1")).not.toBeNull();
    expect(await store.getSubscriptionByCompany(companies[499]!.id)).not.toBeNull();
    // the 501st company's pre-existing subscription was NOT force-canceled
    expect((await store.getSubscriptionByCompany(lastCompanyId))!.status).toBe("active");
  });

  it("billing-summary data requires the host-authorized companyId", async () => {
    const { harness } = await makeWorker();
    const summary = await harness.getData<{ status: string }>("billing-summary", { companyId: "co-1" });
    expect(summary.status).toBe("trialing");
    await expect(harness.getData("billing-summary", {})).rejects.toThrow("company scope");
  });

  it("admin-overview data rejects company-scoped calls (only the instance-admin bridge path may call it)", async () => {
    const { harness } = await makeWorker();
    await harness.runJob("billing-sweep");
    const rows = await harness.getData<Array<{ companyId: string }>>("admin-overview", {});
    expect(rows.map((row) => row.companyId).sort()).toEqual(["co-1", "co-2"]);
    await expect(harness.getData("admin-overview", { companyId: "co-1" })).rejects.toThrow("instance admin");
  });

  it("admin actions enforce the no-company instance-admin bridge contract", async () => {
    const { harness, store } = await makeWorker();
    await harness.runJob("billing-sweep");
    // company-scoped call (owner spoof attempt): context.companyId is set → rejected
    await expect(
      harness.performAction("admin-set-price-override", { targetCompanyId: "co-1", priceCents: 0 }, {
        companyId: "co-1",
        actor: { type: "user", userId: "owner-1" },
      }),
    ).rejects.toThrow("instance admin");
    // agent actor without company scope → rejected
    await expect(
      harness.performAction("admin-set-price-override", { targetCompanyId: "co-1", priceCents: 0 }, {
        companyId: null,
        actor: { type: "agent", agentId: "agent-1" },
      }),
    ).rejects.toThrow("instance admin");
    // proper admin path
    const summary = await harness.performAction<{ status: string }>(
      "admin-set-price-override",
      { targetCompanyId: "co-1", priceCents: 0 },
      { companyId: null, actor: { type: "user", userId: "admin-1" } },
    );
    expect(summary.status).toBe("complimentary");
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("complimentary");
  });

  it("create-checkout → stub-checkout-complete round trip activates through the real webhook path", async () => {
    const { harness, store, standingCalls } = await makeWorker();
    const checkout = await harness.performAction<{ url: string; sessionRef: string }>(
      "create-checkout",
      {},
      { companyId: "co-1", actor: { type: "user", userId: "user-1" } },
    );
    expect(checkout.url).toContain("billing-checkout?session=");
    await harness.performAction(
      "stub-checkout-complete",
      { sessionRef: checkout.sessionRef, outcome: "pay", savePaymentMethod: true },
      { companyId: "co-1", actor: { type: "user", userId: "user-1" } },
    );
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    expect(sub.status).toBe("active");
    expect(standingCalls.at(-1)).toEqual({ kind: "clear", companyId: "co-1" });
    const summary = await harness.getData<{ hasDefaultPaymentMethod: boolean }>("billing-summary", { companyId: "co-1" });
    expect(summary.hasDefaultPaymentMethod).toBe(true);
  });

  it("stub-session data refuses sessions of other companies", async () => {
    const { harness } = await makeWorker();
    const checkout = await harness.performAction<{ sessionRef: string }>(
      "create-checkout", {}, { companyId: "co-1", actor: { type: "user", userId: "user-1" } },
    );
    await expect(
      harness.getData("stub-session", { companyId: "co-2", sessionRef: checkout.sessionRef }),
    ).rejects.toThrow("forbidden");
  });

  it("onWebhook accepts only the declared endpoint key", async () => {
    const { plugin } = await makeWorker();
    await expect(
      plugin.definition.onWebhook!({ endpointKey: "other", headers: {}, rawBody: "{}", requestId: "r" }),
    ).rejects.toThrow("unknown webhook endpoint");
  });

  it("onApiRequest serves creation-summary from the trusted actor and maps BillingUserError to 4xx", async () => {
    const { plugin, harness } = await makeWorker();
    void harness;
    const base = {
      method: "GET", path: "/creation-summary", params: {}, query: {}, body: null,
      actor: { actorType: "user" as const, actorId: "user-1", userId: "user-1", agentId: null, runId: null },
      companyId: "co-1", headers: {},
    };
    const ok = await plugin.definition.onApiRequest!({ ...base, routeKey: "creation-summary" });
    expect(ok.status).toBe(200);
    expect((ok.body as { trialAvailable: boolean }).trialAvailable).toBe(true);

    // summary then force an error path: cancel without an active subscription → 400 with typed code
    const err = await plugin.definition.onApiRequest!({
      ...base, routeKey: "cancel", method: "POST", path: "/cancel", body: { companyId: "co-1" },
    });
    expect(err.status).toBe(400);
    expect((err.body as { error: string }).error).toBe("not_active");

    const unknown = await plugin.definition.onApiRequest!({ ...base, routeKey: "nope" });
    expect(unknown.status).toBe(404);
  });
});
