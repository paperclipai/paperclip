import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  buildCircuitKey,
  getCircuitState,
  recordCircuitExecutionFailure,
  resetAllCircuits,
  toRouteKey,
} from "../adapters/circuit-breaker.js";
import { errorHandler } from "../middleware/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mocks = vi.hoisted(() => ({
  reconcileCircuitQuarantine: vi.fn(async () => ({ clearedHolds: 0, promoted: [], stalePromoted: 0 })),
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({
    reconcileCircuitQuarantine: mocks.reconcileCircuitQuarantine,
  }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeAdminRoutes = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const overrideAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "claude_local",
    status: "pass" as const,
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
};

describeAdminRoutes("admin adapter routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let adminAdapterRoutes!: typeof import("../routes/admin-adapters.js").adminAdapterRoutes;
  let registerServerAdapter!: typeof import("../adapters/registry.js").registerServerAdapter;
  let unregisterServerAdapter!: typeof import("../adapters/registry.js").unregisterServerAdapter;
  let isOverridePaused!: typeof import("../adapters/registry.js").isOverridePaused;
  let setOverridePaused!: typeof import("../adapters/registry.js").setOverridePaused;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-admin-adapters-");
    db = createDb(tempDb.connectionString);
    const [routes, registry] = await Promise.all([
      import("../routes/admin-adapters.js"),
      import("../adapters/registry.js"),
    ]);
    adminAdapterRoutes = routes.adminAdapterRoutes;
    registerServerAdapter = registry.registerServerAdapter;
    unregisterServerAdapter = registry.unregisterServerAdapter;
    isOverridePaused = registry.isOverridePaused;
    setOverridePaused = registry.setOverridePaused;
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    resetAllCircuits();
    setOverridePaused("claude_local", false);
    unregisterServerAdapter("claude_local");
    registerServerAdapter(overrideAdapter);
  });

  afterEach(async () => {
    resetAllCircuits();
    setOverridePaused("claude_local", false);
    unregisterServerAdapter("claude_local");
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api/admin/adapters", adminAdapterRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCircuit() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Admin Adapter Route Co",
      issuePrefix: "AADM",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RouteAgent",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: { model: "haiku" },
      runtimeConfig: {},
      permissions: {},
    });

    const circuitKey = buildCircuitKey({
      adapterType: "claude_local",
      adapterConfig: { model: "haiku" },
    });
    const baseTime = Date.now();
    for (let i = 0; i < 3; i += 1) {
      recordCircuitExecutionFailure({
        key: circuitKey,
        adapterType: "claude_local",
        adapterConfig: { model: "haiku" },
        adapterFailureReason: "adapter_protocol_error",
        now: new Date(baseTime - (2_000 - (i * 500))),
      });
    }

    return { companyId, agentId, circuitKey, routeKey: toRouteKey(circuitKey) };
  }

  const boardActor: Express.Request["actor"] = {
    type: "board",
    userId: "local-board",
    userName: null,
    userEmail: null,
    source: "local_implicit",
    isInstanceAdmin: true,
    companyIds: [],
    memberships: [],
  };

  it("resets a circuit for a board actor and audits the applied action", async () => {
    const { companyId, routeKey, circuitKey } = await seedCircuit();
    const app = createApp(boardActor);

    const res = await request(app)
      .post(`/api/admin/adapters/${routeKey}/reset`)
      .send({ reason: "fix deployed", actor: "local-board" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(getCircuitState(circuitKey)?.state).toBe("Closed");
    expect(mocks.reconcileCircuitQuarantine).toHaveBeenCalledWith({ circuitKey });

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("circuit_reset");
    expect(rows[0]?.actorId).toBe("local-board");
    expect(rows[0]?.details).toMatchObject({
      action: "reset",
      key: circuitKey,
      reason: "fix deployed",
      outcome: "applied",
      oldState: { state: "Open" },
      newState: { state: "Closed" },
      expiresAt: null,
      actor: {
        kind: "board",
        userId: "local-board",
        agentId: null,
      },
    });
  });

  it("rejects agent-driven reset attempts and audits the rejection", async () => {
    const { companyId, routeKey, circuitKey, agentId } = await seedCircuit();
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/admin/adapters/${routeKey}/reset`)
      .send({ reason: "self-rescue attempt", actor: agentId });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toEqual({ error: "Agent actors cannot manually release adapter quarantine" });
    expect(getCircuitState(circuitKey)?.state).toBe("Open");

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("circuit_reset");
    expect(rows[0]?.actorId).toBe(agentId);
    expect(rows[0]?.details).toMatchObject({
      action: "reset",
      key: circuitKey,
      reason: "self-rescue attempt",
      outcome: "rejected_agent_actor",
      oldState: null,
      newState: null,
      expiresAt: null,
      actor: {
        kind: "agent",
        userId: null,
        agentId,
      },
    });
  });

  it("fails reset before breaker mutation when board actor lacks org access", async () => {
    const { routeKey, circuitKey } = await seedCircuit();
    const app = createApp({
      type: "board",
      userId: "outsider-1",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/admin/adapters/${routeKey}/reset`)
      .send({ reason: "fix deployed", actor: "outsider-1" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toEqual({ error: "Company membership or instance admin access required" });
    expect(getCircuitState(circuitKey)?.state).toBe("Open");
    expect(mocks.reconcileCircuitQuarantine).not.toHaveBeenCalled();
  });

  it("override-pauses a circuit for a board actor and audits the applied action", async () => {
    const { companyId, routeKey, circuitKey } = await seedCircuit();
    const app = createApp(boardActor);

    const res = await request(app)
      .post(`/api/admin/adapters/${routeKey}/override-pause`)
      .send({ reason: "route to builtin fallback" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      adapterType: "claude_local",
      circuitKey,
      overridePaused: true,
      state: "Closed",
    });
    expect(isOverridePaused("claude_local")).toBe(true);
    expect(getCircuitState(circuitKey)?.state).toBe("Closed");
    expect(mocks.reconcileCircuitQuarantine).toHaveBeenCalledWith({ circuitKey });

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("adapter_override_pause");
    expect(rows[0]?.details).toMatchObject({
      action: "override_pause",
      key: circuitKey,
      reason: "route to builtin fallback",
      outcome: "applied",
      oldState: { state: "Open" },
      newState: { state: "Closed" },
    });
  });

  it("rejects agent-driven override-pause attempts and audits the rejection", async () => {
    const { companyId, routeKey, circuitKey, agentId } = await seedCircuit();
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_jwt",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/admin/adapters/${routeKey}/override-pause`)
      .send({ reason: "route to builtin fallback" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toEqual({ error: "Agent actors cannot manually release adapter quarantine" });
    expect(isOverridePaused("claude_local")).toBe(false);
    expect(getCircuitState(circuitKey)?.state).toBe("Open");

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("adapter_override_pause");
    expect(rows[0]?.actorId).toBe(agentId);
    expect(rows[0]?.details).toMatchObject({
      action: "override_pause",
      key: circuitKey,
      reason: "route to builtin fallback",
      outcome: "rejected_agent_actor",
      oldState: null,
      newState: null,
    });
  });

  it("fails override-pause before breaker mutation when board actor lacks org access", async () => {
    const { routeKey, circuitKey } = await seedCircuit();
    const app = createApp({
      type: "board",
      userId: "outsider-1",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/admin/adapters/${routeKey}/override-pause`)
      .send({ reason: "route to builtin fallback" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toEqual({ error: "Company membership or instance admin access required" });
    expect(isOverridePaused("claude_local")).toBe(false);
    expect(getCircuitState(circuitKey)?.state).toBe("Open");
    expect(mocks.reconcileCircuitQuarantine).not.toHaveBeenCalled();
  });
});
