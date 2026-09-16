import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent-hire idempotency route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

/**
 * Seed a company, a hiring agent that carries the standard-trust
 * `canCreateAgents` permission, and a running heartbeat run for that agent. The
 * hire route authorizes the agent through the legacy `agents:create` path, and
 * the run id is what the idempotency guard keys on.
 */
async function seedHiringFixture(db: Db) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db
    .insert(companies)
    .values({
      name: `Idempotency Co ${nonce}`,
      issuePrefix: `ID${nonce.slice(0, 4).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
      // Direct hires (no board approval) mirror the reported QA org where the
      // duplicate "Sam 2" agent was actually created.
      requireBoardApprovalForNewAgents: false,
    })
    .returning();
  const [hiringAgent] = await db
    .insert(agents)
    .values({
      companyId: company!.id,
      name: "Chief Of Staff",
      role: "general",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: { canCreateAgents: true },
    })
    .returning();
  const [run] = await db
    .insert(heartbeatRuns)
    .values({
      companyId: company!.id,
      agentId: hiringAgent!.id,
      status: "running",
      contextSnapshot: {},
    })
    .returning();
  return { company: company!, hiringAgent: hiringAgent!, run: run! };
}

function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId,
    companyId,
    runId,
    source: "agent_jwt",
  };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("agent hire idempotency within a run", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-hire-idempotency-");
    db = createDb(tempDb.connectionString);
    // Embedded Postgres cold-starts slowly on a loaded machine.
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns the existing hire when the same run re-posts an identical payload", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));
    const payload = { name: "Sam", role: "engineer", title: "Store Builder", adapterType: "process" as const };

    const first = await request(app).post(`/api/companies/${company.id}/agent-hires`).send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.agent?.name).toBe("Sam");
    const createdId = first.body.agent?.id as string;

    // The agent misreads the wrapped 201 body and re-sends the identical payload.
    const second = await request(app).post(`/api/companies/${company.id}/agent-hires`).send(payload);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.agent?.id).toBe(createdId);
    // The retry must not have auto-renamed a duplicate to "Sam 2".
    expect(second.body.agent?.name).toBe("Sam");

    const samAgents = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, company.id), eq(agents.role, "engineer")));
    expect(samAgents.map((row) => row.name)).toEqual(["Sam"]);
  });

  it("creates one agent when two identical retries overlap in the same run", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));
    const payload = { name: "Sam", role: "engineer", title: "Store Builder", adapterType: "process" as const };

    // Both requests are in flight at once, so neither can see the other's
    // activity record unless the route serializes them.
    const [first, second] = await Promise.all([
      request(app).post(`/api/companies/${company.id}/agent-hires`).send(payload),
      request(app).post(`/api/companies/${company.id}/agent-hires`).send(payload),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses, JSON.stringify([first.body, second.body])).toEqual([200, 201]);
    const created = first.status === 201 ? first : second;
    const replayed = first.status === 200 ? first : second;
    expect(replayed.body.idempotent).toBe(true);
    expect(replayed.body.agent?.id).toBe(created.body.agent?.id);

    const samAgents = await db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, company.id), eq(agents.role, "engineer")));
    expect(samAgents.map((row) => row.name)).toEqual(["Sam"]);
  });

  it("treats a changed payload in the same run as a new hire, not a retry", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));

    const first = await request(app)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Sam", role: "engineer", adapterType: "process" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // Same identity, corrected configuration: the agent meant a different hire.
    const corrected = await request(app)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Sam", role: "engineer", adapterType: "process", budgetMonthlyCents: 5000 });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    expect(corrected.body.idempotent).toBeUndefined();
    expect(corrected.body.agent?.id).not.toBe(first.body.agent?.id);
    expect(corrected.body.agent?.budgetMonthlyCents).toBe(5000);
  });

  it("still creates a distinct agent for a different hire in the same run", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));

    const sam = await request(app)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Sam", role: "engineer", adapterType: "process" });
    expect(sam.status, JSON.stringify(sam.body)).toBe(201);

    const casey = await request(app)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Casey", role: "designer", adapterType: "process" });
    expect(casey.status, JSON.stringify(casey.body)).toBe(201);
    expect(casey.body.agent?.id).not.toBe(sam.body.agent?.id);

    const names = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, company.id));
    expect(names.map((row) => row.name).sort()).toEqual(["Casey", "Chief Of Staff", "Sam"]);
  });

  it("does not deduplicate identical hires across different runs", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    const [secondRun] = await db
      .insert(heartbeatRuns)
      .values({ companyId: company.id, agentId: hiringAgent.id, status: "running", contextSnapshot: {} })
      .returning();
    const payload = { name: "Sam", role: "engineer", adapterType: "process" as const };

    const firstRunApp = createApp(db, agentActor(company.id, hiringAgent.id, run.id));
    const firstRunHire = await request(firstRunApp)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send(payload);
    expect(firstRunHire.status, JSON.stringify(firstRunHire.body)).toBe(201);

    const secondRunApp = createApp(db, agentActor(company.id, hiringAgent.id, secondRun!.id));
    const secondRunHire = await request(secondRunApp).post(`/api/companies/${company.id}/agent-hires`).send(payload);
    // A genuinely separate run is not a retry, so the legacy dedup names it "Sam 2".
    expect(secondRunHire.status, JSON.stringify(secondRunHire.body)).toBe(201);
    expect(secondRunHire.body.idempotent).toBeUndefined();
    expect(secondRunHire.body.agent?.name).toBe("Sam 2");
  });
});
