import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentPresets,
  agents,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createApp(db: Db, companyId: string, userId: string) {
  const { agentPresetRoutes } = await import("../routes/agent-presets.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId,
      source: "local_implicit",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", agentPresetRoutes(db));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function createCompanyWithOwner(db: Db) {
  const company = await db
    .insert(companies)
    .values({
      name: `Agent Preset ${randomUUID()}`,
      issuePrefix: `AP${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const owner = await db
    .insert(companyMemberships)
    .values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    })
    .returning()
    .then((rows) => rows[0]!);
  return { company, owner };
}

async function createAgent(
  db: Db,
  companyId: string,
  name: string,
  adapterType: string,
  adapterConfig: Record<string, unknown> = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name,
      role: "general",
      adapterType,
      adapterConfig,
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("agent preset routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-presets-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentPresets);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates a preset by snapshotting current company agents", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    await createAgent(db, company.id, "Engineer Medal", "claude_local", { model: "opus" });
    await createAgent(db, company.id, "Marketing Lead", "claude_local", { model: "sonnet" });

    const res = await request(await createApp(db, company.id, owner.principalId))
      .post(`/api/companies/${company.id}/agent-presets`)
      .send({ name: "Claude" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.preset.name).toBe("Claude");
    expect(res.body.preset.snapshot).toHaveLength(2);
    expect(res.body.preset.snapshot.map((e: any) => e.agentNameKey).sort()).toEqual([
      "engineer-medal",
      "marketing-lead",
    ]);
    expect(res.body.preset.snapshot[0].adapterConfig).toEqual({ model: "opus" });
  });

  it("rejects duplicate preset names", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    await createAgent(db, company.id, "Engineer", "claude_local");

    const app = await createApp(db, company.id, owner.principalId);
    await request(app)
      .post(`/api/companies/${company.id}/agent-presets`)
      .send({ name: "Claude" });

    const dup = await request(app)
      .post(`/api/companies/${company.id}/agent-presets`)
      .send({ name: "Claude" });

    expect(dup.status).toBe(409);
  });

  it("lists presets ordered by created_at", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    await createAgent(db, company.id, "Engineer", "claude_local");
    const app = await createApp(db, company.id, owner.principalId);

    await request(app)
      .post(`/api/companies/${company.id}/agent-presets`)
      .send({ name: "Claude" });
    await request(app)
      .post(`/api/companies/${company.id}/agent-presets`)
      .send({
        name: "Codex",
        snapshot: [
          { agentNameKey: "engineer", agentName: "Engineer", adapterType: "codex_local", adapterConfig: { model: "gpt-5" } },
        ],
      });

    const res = await request(app).get(`/api/companies/${company.id}/agent-presets`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.map((p: any) => p.name)).toEqual(["Claude", "Codex"]);
  });

  it("dryRun apply returns preview without mutating agents", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const engineer = await createAgent(db, company.id, "Engineer", "claude_local", { model: "opus" });

    const app = await createApp(db, company.id, owner.principalId);
    const create = await request(app)
      .post(`/api/companies/${company.id}/agent-presets`)
      .send({
        name: "Codex",
        snapshot: [
          { agentNameKey: "engineer", agentName: "Engineer", adapterType: "codex_local", adapterConfig: { model: "gpt-5" } },
        ],
      });
    const presetId = create.body.preset.id;

    const dry = await request(app)
      .post(`/api/companies/${company.id}/agent-presets/${presetId}/apply?dryRun=true`)
      .send({});

    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.appliedAgentIds).toEqual([engineer.id]);
    expect(dry.body.unmatched).toEqual([]);

    const after = await db.select().from(agents).where(eq(agents.id, engineer.id));
    expect(after[0]!.adapterType).toBe("claude_local");
    expect(after[0]!.adapterConfig).toEqual({ model: "opus" });
  });

  it("apply mutates matched agents and returns unmatched entries by agentNameKey", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const engineer = await createAgent(db, company.id, "Engineer", "claude_local", { model: "opus" });
    await createAgent(db, company.id, "Marketing", "claude_local", { model: "sonnet" });

    const app = await createApp(db, company.id, owner.principalId);
    const create = await request(app)
      .post(`/api/companies/${company.id}/agent-presets`)
      .send({
        name: "Codex",
        snapshot: [
          { agentNameKey: "engineer", agentName: "Engineer", adapterType: "codex_local", adapterConfig: { model: "gpt-5" } },
          { agentNameKey: "ghost", agentName: "Ghost", adapterType: "codex_local", adapterConfig: {} },
        ],
      });
    const presetId = create.body.preset.id;

    const applyRes = await request(app)
      .post(`/api/companies/${company.id}/agent-presets/${presetId}/apply`)
      .send({});

    expect(applyRes.status).toBe(200);
    expect(applyRes.body.dryRun).toBe(false);
    expect(applyRes.body.appliedAgentIds).toEqual([engineer.id]);
    expect(applyRes.body.unmatched).toEqual([{ agentNameKey: "ghost", agentName: "Ghost" }]);

    const engineerRow = await db
      .select()
      .from(agents)
      .where(eq(agents.id, engineer.id))
      .then((rows) => rows[0]!);
    expect(engineerRow.adapterType).toBe("codex_local");
    expect(engineerRow.adapterConfig).toEqual({ model: "gpt-5" });

    const log = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, "agent_preset_applied")));
    expect(log).toHaveLength(1);
  });

  it("deletes a preset", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    await createAgent(db, company.id, "Engineer", "claude_local");

    const app = await createApp(db, company.id, owner.principalId);
    const create = await request(app)
      .post(`/api/companies/${company.id}/agent-presets`)
      .send({ name: "Claude" });
    const presetId = create.body.preset.id;

    const del = await request(app).delete(`/api/companies/${company.id}/agent-presets/${presetId}`);
    expect(del.status).toBe(204);

    const remaining = await db
      .select()
      .from(agentPresets)
      .where(eq(agentPresets.id, presetId));
    expect(remaining).toHaveLength(0);
  });
});
