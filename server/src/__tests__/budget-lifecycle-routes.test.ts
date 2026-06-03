import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDb,
  agents,
  budgetCaps,
  companies,
  costEvents,
  costEventsWindowAgg,
  heartbeatRuns,
  activityLog,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { errorHandler } from "../middleware/error-handler.js";
import { costRoutes } from "../routes/costs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budget lifecycle routes (POST /cost/preflight, /cost/charge)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Default actor; overridable per request via the `x-test-actor` mechanism below.
  let currentActor: Record<string, unknown> = {
    type: "board",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...currentActor };
      next();
    });
    app.use("/api", costRoutes(db));
    app.use(errorHandler);
    return app;
  }
  let app!: express.Express;

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Budget Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Charging Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      startedAt: new Date("2026-06-03T00:00:00.000Z"),
    });
    return { companyId, agentId, runId };
  }

  function chargeBody(companyId: string, over: Partial<Record<string, unknown>> = {}) {
    return {
      companyId,
      provider: "anthropic",
      model: "claude-opus-4-7",
      kind: "tokens",
      qty: 1000,
      unitPriceMicros: 15,
      idempotencyKey: randomUUID(),
      occurredAt: "2026-06-03T12:00:00.000Z",
      ...over,
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-lifecycle-");
    db = createDb(tempDb.connectionString);
    app = buildApp();
  }, 30_000);

  afterEach(async () => {
    currentActor = { type: "board", source: "local_implicit", isInstanceAdmin: true };
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(costEventsWindowAgg);
    await db.delete(budgetCaps);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("charges a cost_events row, computing costMicros = ceil(qty * unitPriceMicros) and propagating run-id", async () => {
    const { companyId, agentId, runId } = await seedCompany();
    const res = await request(app)
      .post("/api/cost/charge")
      .send(chargeBody(companyId, { agentId, runId, qty: 1000, unitPriceMicros: 15 }));

    expect(res.status).toBe(201);
    expect(res.body.costMicros).toBe(15_000);
    expect(res.body.idempotent).toBe(false);
    expect(res.body.headroomMicros).toBeNull(); // S2: null (not 0) when no binding cap applies

    const [row] = await db.select().from(costEvents).where(eq(costEvents.id, res.body.id));
    expect(row.costMicros).toBe(15_000);
    expect(row.heartbeatRunId).toBe(runId); // run-id propagation (§7.2)
    expect(row.agentId).toBe(agentId);
  });

  it("is idempotent on idempotencyKey: a retry does not double-charge", async () => {
    const { companyId, agentId } = await seedCompany();
    const body = chargeBody(companyId, { agentId, idempotencyKey: "retry-key-1", qty: 1000, unitPriceMicros: 15 });

    const first = await request(app).post("/api/cost/charge").send(body);
    const second = await request(app).post("/api/cost/charge").send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.headroomMicros).toBeNull(); // S2: null sentinel for no-cap case on idempotent retry too

    const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(rows).toHaveLength(1); // no double-charge

    // The per-window aggregate also reflects a single charge.
    const aggRows = await db
      .select()
      .from(costEventsWindowAgg)
      .where(eq(costEventsWindowAgg.scope, "company"));
    const companyDay = aggRows.find((r) => r.scopeKey === companyId && r.window === "day");
    expect(Number(companyDay?.spendMicros)).toBe(15_000);
  });

  it("accepts a source-less (agent-less) system charge", async () => {
    const { companyId } = await seedCompany();
    const res = await request(app)
      .post("/api/cost/charge")
      .send(chargeBody(companyId, { agentId: null, provider: "internal", model: "health-probe", kind: "fixed", qty: 0, costMicros: 0 }));

    expect(res.status).toBe(201);
    const [row] = await db.select().from(costEvents).where(eq(costEvents.id, res.body.id));
    expect(row.agentId).toBeNull();
  });

  it("returns 503 policy.budget_hard_stopped when a charge crosses a hard_stop cap, but still records the row", async () => {
    const { companyId, agentId } = await seedCompany();
    await db.insert(budgetCaps).values({
      companyId,
      scope: "company",
      scopeKey: companyId,
      window: "day",
      limitMicros: 1_000_000,
      warnAtPercent: 60,
      criticalAtPercent: 80,
      hardStopAtPercent: 100,
      action: "hard_stop",
    });

    const res = await request(app)
      .post("/api/cost/charge")
      .send(chargeBody(companyId, { agentId, qty: 1, unitPriceMicros: 2_000_000, costMicros: 2_000_000 }));

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("policy.budget_hard_stopped");
    expect(res.body.details.id).toBeTruthy();
    // The cost was incurred, so the row is recorded (auditability preserved).
    const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(rows).toHaveLength(1);
  });

  it("returns 429 policy.budget_paused_writes when a charge crosses a pause_writes cap", async () => {
    const { companyId, agentId } = await seedCompany();
    await db.insert(budgetCaps).values({
      companyId,
      scope: "company",
      scopeKey: companyId,
      window: "day",
      limitMicros: 1_000_000,
      warnAtPercent: 60,
      criticalAtPercent: 80,
      hardStopAtPercent: 100,
      action: "pause_writes",
    });

    const res = await request(app)
      .post("/api/cost/charge")
      .send(chargeBody(companyId, { agentId, qty: 1, unitPriceMicros: 2_000_000, costMicros: 2_000_000 }));

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("policy.budget_paused_writes");
  });

  it("preflight denies when the estimate pushes a hard_stop cap over its limit, and allows otherwise", async () => {
    const { companyId, agentId } = await seedCompany();
    await db.insert(budgetCaps).values({
      companyId,
      scope: "company",
      scopeKey: companyId,
      window: "day",
      limitMicros: 1_000_000,
      warnAtPercent: 60,
      criticalAtPercent: 80,
      hardStopAtPercent: 100,
      action: "hard_stop",
    });

    const deny = await request(app)
      .post("/api/cost/preflight")
      .send({ companyId, agentId, provider: "anthropic", model: "claude-opus-4-7", kind: "tokens", estimatedCostMicros: 2_000_000 });
    expect(deny.status).toBe(200);
    expect(deny.body.decision).toBe("deny");
    expect(deny.body.bindingCapId).toBeTruthy();
    expect(typeof deny.body.headroomMicros).toBe("number"); // cap binds → number (not null)
    expect(deny.body.softHeadroomMicros).not.toBeNull();

    const allow = await request(app)
      .post("/api/cost/preflight")
      .send({ companyId, agentId, provider: "anthropic", model: "claude-opus-4-7", kind: "tokens", estimatedCostMicros: 100_000 });
    expect(allow.status).toBe(200);
    expect(allow.body.decision).toBe("allow");
    expect(typeof allow.body.headroomMicros).toBe("number");
  });

  it("returns null headroomMicros (and soft) for preflight/charge when no caps bind (S2 sentinel, not 0)", async () => {
    const { companyId, agentId } = await seedCompany();
    // no caps inserted for this company
    const pf = await request(app)
      .post("/api/cost/preflight")
      .send({ companyId, agentId, provider: "anthropic", model: "claude-opus-4-7", kind: "tokens", estimatedCostMicros: 100_000 });
    expect(pf.status).toBe(200);
    expect(pf.body.decision).toBe("allow");
    expect(pf.body.headroomMicros).toBeNull();
    expect(pf.body.softHeadroomMicros).toBeNull();
    expect(pf.body.bindingCapId).toBeNull();

    const ch = await request(app)
      .post("/api/cost/charge")
      .send(chargeBody(companyId, { agentId, qty: 10, unitPriceMicros: 1000 }));
    expect(ch.status).toBe(201);
    expect(ch.body.headroomMicros).toBeNull();
  });

  it("rejects an agent actor charging under another agent's id (auth)", async () => {
    const { companyId, agentId } = await seedCompany();
    currentActor = { type: "agent", agentId, companyId, source: "agent_key" };

    const res = await request(app)
      .post("/api/cost/charge")
      .send(chargeBody(companyId, { agentId: randomUUID() }));

    expect(res.status).toBe(400);
  });
});
