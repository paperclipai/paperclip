import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sandboxBillingCapRoutes } from "../routes/sandbox-billing-cap.js";
import { errorHandler } from "../middleware/index.js";
import {
  BillingCapMonitor,
  InMemoryBillingCapStore,
  LeaseBasedSourceB,
  LogCapNotifier,
} from "../services/sandbox/billing-cap/index.js";

const mockListSandboxLeasesForCompany = vi.hoisted(() => vi.fn());
vi.mock("../services/sandbox/queries.js", () => ({
  listSandboxLeasesForCompany: mockListSandboxLeasesForCompany,
  getSandboxLeaseForCompany: vi.fn(),
}));

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

let currentActor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  source: "local_implicit",
};

function buildApp(actor: Record<string, unknown>): express.Express {
  currentActor = actor;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: typeof currentActor }).actor = currentActor;
    next();
  });
  const store = new InMemoryBillingCapStore();
  // Use a stub SourceB so the route doesn't hit the DB.
  const monitor = new BillingCapMonitor({
    store,
    sourceA: null,
    sourceB: {
      async sample() {
        return {
          dayCents: 0,
          monthCents: 0,
          dayRuntimeSeconds: 0,
          monthRuntimeSeconds: 0,
          ratePerSecondCents: 0.01,
        };
      },
    },
    notifier: new LogCapNotifier(silentLogger() as never),
    logger: silentLogger(),
  });
  app.use(
    "/api",
    sandboxBillingCapRoutes({} as never, {
      monitor,
      store,
      resolveProviderDescriptor: async () => ({
        key: "e2b",
        displayLabel: "E2B",
        apiKeyConfigured: false,
        secretRefRedactedSuffix: null,
      }),
      isAllowLive: () => false,
    }),
  );
  app.use(errorHandler);
  // Expose store + monitor on the express instance for tests.
  (app as unknown as { __store: InMemoryBillingCapStore }).__store = store;
  (app as unknown as { __monitor: BillingCapMonitor }).__monitor = monitor;
  return app;
}

beforeEach(() => {
  mockListSandboxLeasesForCompany.mockReset();
  mockListSandboxLeasesForCompany.mockResolvedValue([]);
});

describe("GET /companies/:companyId/sandbox/billing-cap/status", () => {
  it("returns the within-cap default for an empty store", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app).get("/api/companies/company-1/sandbox/billing-cap/status");
    expect(res.status).toBe(200);
    expect(res.body.capState).toBe("within-cap");
    expect(res.body.meta.allowLive).toBe(false);
    expect(res.body.killSwitch.layers.find((l: { id: string }) => l.id === "env-gate").state).toBe(
      "disabled",
    );
    expect(res.body.operatorToggle.canOperate).toBe(true);
  });

  it("denies non-board actors operator authority", async () => {
    const app = buildApp({
      type: "board",
      userId: "user-1",
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }],
      companyIds: ["company-1"],
    });
    const res = await request(app).get("/api/companies/company-1/sandbox/billing-cap/status");
    expect(res.status).toBe(200);
    expect(res.body.operatorToggle.canOperate).toBe(false);
    expect(res.body.operatorToggle.lockedReason).toContain("Viewer");
  });
});

describe("POST /companies/:companyId/sandbox/billing-cap/operator-toggle", () => {
  it("requires a reason and returns 422 when missing", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app)
      .post("/api/companies/company-1/sandbox/billing-cap/operator-toggle")
      .send({ enable: false });
    expect(res.status).toBe(422);
  });

  it("flips operator toggle off and returns currentlyEnabled=false", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const res = await request(app)
      .post("/api/companies/company-1/sandbox/billing-cap/operator-toggle")
      .send({ enable: false, reason: "manual pause" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, currentlyEnabled: false });
  });

  it("returns 409 when re-enable is refused due to monthly hard-cap breach", async () => {
    const app = buildApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const store = (app as unknown as { __store: InMemoryBillingCapStore }).__store;
    await store.flipProviderEnable({
      companyId: "company-1",
      provider: "e2b",
      enabled: false,
      actorLabel: "auto-cap-monitor",
      reason: "month_hard_cap_breached",
      at: new Date(),
      recordHardCapBreach: "month",
    });
    // Pre-disable the operator toggle so the re-enable code path runs.
    await store.flipOperatorToggle({
      companyId: "company-1",
      provider: "e2b",
      enabled: false,
      actorLabel: "operator:test",
      reason: "pre-disable",
      at: new Date(),
    });
    const res = await request(app)
      .post("/api/companies/company-1/sandbox/billing-cap/operator-toggle")
      .send({ enable: true, reason: "try to re-enable" });
    expect(res.status).toBe(409);
  });

  it("rejects non-board actor with 403", async () => {
    const app = buildApp({ type: "agent", agentId: "agent-1", companyId: "company-1" });
    const res = await request(app)
      .post("/api/companies/company-1/sandbox/billing-cap/operator-toggle")
      .send({ enable: false, reason: "agent attempt" });
    expect(res.status).toBe(403);
  });
});

describe("LeaseBasedSourceB integration sanity", () => {
  it("instantiates without error and exposes sample()", () => {
    const source = new LeaseBasedSourceB({} as never);
    expect(typeof source.sample).toBe("function");
  });
});
