import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agents-cancel-route integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agents router cancel-route integration (SPA-9035 v3)", { timeout: 60_000 }, () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agents-cancel-route-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const agentAId = randomUUID();
    const agentBId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Cancel Route Co",
      status: "active",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: ownerUserId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Agent A",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Agent B",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, ownerUserId, agentAId, agentBId };
  }

  async function insertRun(input: {
    companyId: string;
    agentId: string;
    status: "queued" | "running";
    requestedByActorType: "agent" | "user" | "system";
    requestedByActorId: string | null;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "callback",
      status: input.status,
      responsibleUserId: `owner-${randomUUID()}`,
      wakeupRequestId: null,
      runtimeMode: "legacy",
      nextEventSeq: 1,
      issueCommentStatus: "not_applicable",
      contextSnapshot: {
        issueId: randomUUID(),
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
      },
    });
    return runId;
  }

  async function mountAgentsRouter(actor: Record<string, unknown>) {
    const [{ agentRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/agents.js"),
      import("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("agent-initiated run + agent self-cancel → 200, run becomes cancelled", async () => {
    const { companyId, agentAId } = await seedCompany();
    const runId = await insertRun({
      companyId,
      agentId: agentAId,
      status: "queued",
      requestedByActorType: "agent",
      requestedByActorId: agentAId,
    });

    const app = await mountAgentsRouter({
      type: "agent",
      agentId: agentAId,
      companyId,
      source: "agent_key",
      runId,
    });

    const res = await request(app)
      .post(`/api/heartbeat-runs/${runId}/cancel`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("agent-initiated run + DIFFERENT agent cancels → 403", async () => {
    const { companyId, agentAId, agentBId } = await seedCompany();
    const runId = await insertRun({
      companyId,
      agentId: agentAId,
      status: "queued",
      requestedByActorType: "agent",
      requestedByActorId: agentAId,
    });

    const app = await mountAgentsRouter({
      type: "agent",
      agentId: agentBId,
      companyId,
      source: "agent_key",
      runId,
    });

    const res = await request(app)
      .post(`/api/heartbeat-runs/${runId}/cancel`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Agent can only cancel a run it itself started/);
  });

  it("system-initiated run lands on agent + agent self-cancel → 403 (initiator is system)", async () => {
    const { companyId, agentAId } = await seedCompany();
    const runId = await insertRun({
      companyId,
      agentId: agentAId,
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: null,
    });

    const app = await mountAgentsRouter({
      type: "agent",
      agentId: agentAId,
      companyId,
      source: "agent_key",
      runId,
    });

    const res = await request(app)
      .post(`/api/heartbeat-runs/${runId}/cancel`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("user-initiated run lands on agent + agent self-cancel → 403 (initiator is user)", async () => {
    const { companyId, ownerUserId, agentAId } = await seedCompany();
    const runId = await insertRun({
      companyId,
      agentId: agentAId,
      status: "queued",
      requestedByActorType: "user",
      requestedByActorId: ownerUserId,
    });

    const app = await mountAgentsRouter({
      type: "agent",
      agentId: agentAId,
      companyId,
      source: "agent_key",
      runId,
    });

    const res = await request(app)
      .post(`/api/heartbeat-runs/${runId}/cancel`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("coalescence preserves the original initiator — system-stamped run stays un-cancelable", async () => {
    const { companyId, agentAId } = await seedCompany();

    // Step 1: simulate the engine writing a system-stamped run row. (We
    // bypass the wake path because the engine kicks off background
    // execution; this test isolates the snapshot-stamp-preservation
    // claim.)
    const systemRunId = await insertRun({
      companyId,
      agentId: agentAId,
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: null,
    });

    // Step 2: an agent attempts to cancel it via the route. The cancel
    // auth must read contextSnapshot.requestedByActorType, see "system",
    // and return 403.
    const app = await mountAgentsRouter({
      type: "agent",
      agentId: agentAId,
      companyId,
      source: "agent_key",
      runId: systemRunId,
    });

    const res = await request(app)
      .post(`/api/heartbeat-runs/${systemRunId}/cancel`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("running run + agent self-cancel → 200 (queued and running are both cancelable)", async () => {
    const { companyId, agentAId } = await seedCompany();
    const runId = await insertRun({
      companyId,
      agentId: agentAId,
      status: "running",
      requestedByActorType: "agent",
      requestedByActorId: agentAId,
    });

    const app = await mountAgentsRouter({
      type: "agent",
      agentId: agentAId,
      companyId,
      source: "agent_key",
      runId,
    });

    const res = await request(app)
      .post(`/api/heartbeat-runs/${runId}/cancel`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("terminal run + agent self-cancel → 409", async () => {
    const { companyId, agentAId } = await seedCompany();
    const runId = await insertRun({
      companyId,
      agentId: agentAId,
      status: "queued",
      requestedByActorType: "agent",
      requestedByActorId: agentAId,
    });
    // Manually mark as cancelled to simulate a terminal state. The cancel
    // route refuses to act on terminal runs even when the initiator matches.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));

    const app = await mountAgentsRouter({
      type: "agent",
      agentId: agentAId,
      companyId,
      source: "agent_key",
      runId,
    });

    const res = await request(app)
      .post(`/api/heartbeat-runs/${runId}/cancel`)
      .send({});
    expect(res.status).toBe(409);
  });
});

// eq needed for the where clause above
import { eq } from "drizzle-orm";