import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentConfigRevisions,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";

// `adapterConfig.maxConcurrentRuns` is a deprecated, write-only alias for
// `runtimeConfig.heartbeat.maxConcurrentRuns` — the only value the scheduler reads
// (parseHeartbeatPolicy, server/src/services/heartbeat/queue.ts). These route tests pin the
// write-side contract against a real database: the alias is accepted, stored exactly once
// under runtimeConfig, and never persisted on the adapter — including on writes that never
// mention the key, so stale rows self-heal.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping max-concurrent-runs alias route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

async function seedCompany(db: Db, agentsToSeed: Array<Record<string, unknown>> = [{}]) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db
    .insert(companies)
    .values({
      name: `Alias Co ${nonce}`,
      issuePrefix: `AL${nonce.slice(0, 4).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
      requireBoardApprovalForNewAgents: false,
    })
    .returning();
  const seeded: Array<typeof agents.$inferSelect> = [];
  for (const overrides of agentsToSeed) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: `Alias Agent ${seeded.length + 1}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: { canCreateAgents: true },
        ...overrides,
      })
      .returning();
    seeded.push(agent!);
  }
  return { company: company!, agents: seeded };
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "local-board",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_jwt" };
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

async function readAgent(db: Db, id: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  return row!;
}

const queue = createHeartbeatQueue(new Proxy({}, { get: () => { throw new Error("policy parsing must not query the database"); } }) as never, {} as never);

describeEmbeddedPostgres("agent maxConcurrentRuns adapter alias", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-max-concurrent-runs-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    // Agent create/hire also writes rows the routes own (budget policies, membership grants,
    // runtime state). Truncating the company root cascades to every one of them instead of
    // tracking each new FK here.
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("admits the runtime cap when the stored adapter copy disagrees", async () => {
    const { company, agents: [agent] } = await seedCompany(db);
    // The exact state the decoy produced on the live control plane: an old adapter copy next
    // to a raised runtime cap.
    await db
      .update(agents)
      .set({ adapterConfig: { maxConcurrentRuns: 1 }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } })
      .where(eq(agents.id, agent!.id));
    const stored = await readAgent(db, agent!.id);

    expect(queue.parseHeartbeatPolicy(stored).maxConcurrentRuns).toBe(2);
    expect(stored.companyId).toBe(company.id);
  });

  it("stores a PATCH alias under runtimeConfig and never under adapterConfig", async () => {
    const { company, agents: [agent] } = await seedCompany(db, [
      { runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, maxConcurrentRuns: 2 } } },
    ]);
    const app = createApp(db, boardActor(company.id));

    const res = await request(app).patch(`/api/agents/${agent!.id}`).send({ adapterConfig: { maxConcurrentRuns: 5 } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await readAgent(db, agent!.id);
    expect(Object.hasOwn(stored.adapterConfig as object, "maxConcurrentRuns")).toBe(false);
    const heartbeat = (stored.runtimeConfig as Record<string, any>).heartbeat;
    expect(heartbeat.maxConcurrentRuns).toBe(5);
    // The rest of the stored policy survives the alias write.
    expect(heartbeat.enabled).toBe(true);
    expect(heartbeat.intervalSec).toBe(60);
    expect(queue.parseHeartbeatPolicy(stored).maxConcurrentRuns).toBe(5);
  });

  it("rejects a request that supplies both keys with different values", async () => {
    const { company, agents: [agent] } = await seedCompany(db);
    const app = createApp(db, boardActor(company.id));

    const res = await request(app)
      .patch(`/api/agents/${agent!.id}`)
      .send({ adapterConfig: { maxConcurrentRuns: 1 }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } } });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error)).toContain("Conflicting maxConcurrentRuns");
    const stored = await readAgent(db, agent!.id);
    expect(stored.adapterConfig).toEqual({});
    expect(stored.runtimeConfig).toEqual({});
  });

  it.each([["many"], [0], [-1], [true], [2.9]])("rejects a non-numeric or out-of-range alias (%s)", async (alias) => {
    const { company, agents: [agent] } = await seedCompany(db);
    const app = createApp(db, boardActor(company.id));

    const res = await request(app).patch(`/api/agents/${agent!.id}`).send({ adapterConfig: { maxConcurrentRuns: alias } });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const stored = await readAgent(db, agent!.id);
    expect(stored.adapterConfig).toEqual({});
    expect(stored.runtimeConfig).toEqual({});
  });

  it.each([[null], [""]])("rejects a blank alias (%s) instead of silently dropping it", async (alias) => {
    const { company, agents: [agent] } = await seedCompany(db, [
      { runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } },
    ]);
    const app = createApp(db, boardActor(company.id));

    const res = await request(app).patch(`/api/agents/${agent!.id}`).send({ adapterConfig: { maxConcurrentRuns: alias } });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const stored = await readAgent(db, agent!.id);
    expect(stored.adapterConfig).toEqual({});
    expect((stored.runtimeConfig as Record<string, any>).heartbeat.maxConcurrentRuns).toBe(2);
  });

  it("rejects an alias sent next to an unparsable runtime cap instead of resolving it silently", async () => {
    const { company, agents: [agent] } = await seedCompany(db);
    const app = createApp(db, boardActor(company.id));

    const res = await request(app)
      .patch(`/api/agents/${agent!.id}`)
      .send({ adapterConfig: { maxConcurrentRuns: 5 }, runtimeConfig: { heartbeat: { maxConcurrentRuns: "many" } } });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const stored = await readAgent(db, agent!.id);
    expect(stored.adapterConfig).toEqual({});
    expect(stored.runtimeConfig).toEqual({});
  });

  it("drops a stale adapter copy restored by a config rollback", async () => {
    const { company, agents: [agent] } = await seedCompany(db, [
      { adapterConfig: { cwd: "/tmp/alias-rollback" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 4 } } },
    ]);
    await db.insert(agentConfigRevisions).values({
      companyId: company.id,
      agentId: agent!.id,
      source: "patch",
      changedKeys: ["adapterConfig"],
      beforeConfig: { adapterConfig: {} },
      // A revision captured before the alias was retired: the dead adapter copy rides along with
      // the effective runtime cap.
      afterConfig: {
        name: agent!.name,
        role: agent!.role,
        adapterType: agent!.adapterType,
        budgetMonthlyCents: 0,
        adapterConfig: { maxConcurrentRuns: 1, cwd: "/tmp/alias-rollback" },
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 4 } },
        metadata: null,
        title: null,
        reportsTo: null,
        capabilities: null,
        defaultEnvironmentId: null,
      },
    }).returning();
    const [revision] = await db.select().from(agentConfigRevisions);
    const app = createApp(db, boardActor(company.id));

    const res = await request(app).post(`/api/agents/${agent!.id}/config-revisions/${revision!.id}/rollback`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await readAgent(db, agent!.id);
    expect(Object.hasOwn(stored.adapterConfig as object, "maxConcurrentRuns")).toBe(false);
    expect((stored.adapterConfig as Record<string, unknown>).cwd).toBe("/tmp/alias-rollback");
    expect(queue.parseHeartbeatPolicy(stored).maxConcurrentRuns).toBe(4);
  });

  it("heals a stale stored adapter copy on an unrelated adapter PATCH", async () => {
    const { company, agents: [agent] } = await seedCompany(db, [
      { adapterConfig: { maxConcurrentRuns: 1, cwd: "/tmp/alias-agent" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } },
    ]);
    const app = createApp(db, boardActor(company.id));

    const res = await request(app).patch(`/api/agents/${agent!.id}`).send({ adapterConfig: { model: "alias-model" } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await readAgent(db, agent!.id);
    expect(Object.hasOwn(stored.adapterConfig as object, "maxConcurrentRuns")).toBe(false);
    expect((stored.adapterConfig as Record<string, unknown>).model).toBe("alias-model");
    // The request never mentioned the cap, so the applied cap is untouched.
    expect((stored.runtimeConfig as Record<string, any>).heartbeat.maxConcurrentRuns).toBe(2);
  });

  it("writes a create alias into runtimeConfig", async () => {
    const { company } = await seedCompany(db, []);
    const app = createApp(db, boardActor(company.id));

    const res = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({ name: "Created Alias", adapterType: "process", adapterConfig: { maxConcurrentRuns: 4 } });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const stored = await readAgent(db, res.body.id ?? res.body.agent?.id);
    expect(Object.hasOwn(stored.adapterConfig as object, "maxConcurrentRuns")).toBe(false);
    expect((stored.runtimeConfig as Record<string, any>).heartbeat.maxConcurrentRuns).toBe(4);
  });

  it("writes a hire alias into runtimeConfig", async () => {
    const { company, agents: [hiringAgent] } = await seedCompany(db, [
      { role: "general", permissions: { canCreateAgents: true } },
    ]);
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: company.id, agentId: hiringAgent!.id, status: "running", contextSnapshot: {} })
      .returning();
    const app = createApp(db, agentActor(company.id, hiringAgent!.id));

    const res = await request(app)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Hired Alias", role: "engineer", adapterType: "claude_local", adapterConfig: { maxConcurrentRuns: 3 } });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const stored = await readAgent(db, res.body.agent?.id ?? res.body.id);
    expect(Object.hasOwn(stored.adapterConfig as object, "maxConcurrentRuns")).toBe(false);
    expect((stored.runtimeConfig as Record<string, any>).heartbeat.maxConcurrentRuns).toBe(3);
    expect(run!.id).toBeTruthy();
  });

  it("backfill migration strips stored adapter copies without changing applied caps", async () => {
    const { agents: [withAlias, withoutAlias] } = await seedCompany(db, [
      { adapterConfig: { maxConcurrentRuns: 1, cwd: "/tmp/alias-a" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } },
      { adapterConfig: { cwd: "/tmp/alias-b" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } } },
    ]);
    const migrationSql = readFileSync(
      new URL("../../../packages/db/src/migrations/0375_agent_max_concurrent_runs_alias.sql", import.meta.url),
      "utf8",
    );

    await db.execute(sql.raw(migrationSql));

    const healed = await readAgent(db, withAlias!.id);
    expect(Object.hasOwn(healed.adapterConfig as object, "maxConcurrentRuns")).toBe(false);
    expect((healed.adapterConfig as Record<string, unknown>).cwd).toBe("/tmp/alias-a");
    expect(queue.parseHeartbeatPolicy(healed).maxConcurrentRuns).toBe(2);

    const untouched = await readAgent(db, withoutAlias!.id);
    expect(untouched.adapterConfig).toEqual({ cwd: "/tmp/alias-b" });
    expect((untouched.runtimeConfig as Record<string, any>).heartbeat.maxConcurrentRuns).toBe(3);
  });
});
