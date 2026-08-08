import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { assertCompanyAccess } from "../routes/authz.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createApp(
  db: ReturnType<typeof createDb>,
  companyId: string,
  deploymentMode: "authenticated" | "local_trusted" = "authenticated",
) {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode, resolveSession: async () => null }));
  app.get("/protected", (req, res, next) => {
    try {
      assertCompanyAccess(req, companyId);
      res.json({ actor: req.actor });
    } catch (error) {
      next(error);
    }
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Request failed" });
  });
  return app;
}

describeEmbeddedPostgres("agent API key scope authentication", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-key-scope-auth-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentApiKeys);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentKey(scopeConfig: unknown) {
    const company = await db
      .insert(companies)
      .values({
        name: `Scope Auth ${randomUUID()}`,
        issuePrefix: `SA${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const responsibleUserId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Responsible User",
      email: `${responsibleUserId}@example.com`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "owner",
    });
    const token = `unit-${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      agentId: agent.id,
      companyId: company.id,
      name: "scoped auth test",
      keyHash: hashToken(token),
      responsibleUserId,
      scopeConfig: scopeConfig as never,
    });
    return { company, agent, token, responsibleUserId };
  }

  it("preserves null legacy scope_config as standard agent authority", async () => {
    const { company, agent, token, responsibleUserId } = await seedAgentKey(null);
    const response = await request(createApp(db, company.id))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.actor).toMatchObject({
      type: "agent",
      agentId: agent.id,
      companyId: company.id,
      source: "agent_key",
      keyScope: { kind: "standard" },
      onBehalfOfUserId: responsibleUserId,
    });
  });

  it.each(["authenticated", "local_trusted"] as const)(
    "rejects malformed non-null scope_config in %s mode",
    async (deploymentMode) => {
      const { company, token } = await seedAgentKey({
        kind: "task_bridge",
        projectId: "not-a-uuid",
      });
      const response = await request(createApp(db, company.id, deploymentMode))
        .get("/protected")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status, JSON.stringify(response.body)).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    },
  );
});
