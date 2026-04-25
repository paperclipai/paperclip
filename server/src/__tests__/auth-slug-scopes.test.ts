import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import WebSocket from "ws";
import { eq } from "drizzle-orm";
import {
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  cliAuthChallenges,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
} from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { assertCompanyAccess } from "../routes/authz.js";
import { boardApiKeyExpiresAt, boardAuthService, hashBearerToken } from "../services/board-auth.js";
import { agentService } from "../services/agents.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function expectedSlug(issuePrefix: string, fallbackId: string) {
  return issuePrefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallbackId;
}

function createAccessApp(db: ReturnType<typeof createDb>) {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
  app.get("/companies/:companyId", (req, res, next) => {
    try {
      assertCompanyAccess(req, req.params.companyId);
      res.json(req.actor);
    } catch (err) {
      next(err);
    }
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    res.status(status).json({ message: err instanceof Error ? err.message : "error" });
  });
  return app;
}

describeEmbeddedPostgres("auth slug scopes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-auth-slug-scopes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(cliAuthChallenges);
    await db.delete(boardApiKeys);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(issuePrefix: string) {
    return db
      .insert(companies)
      .values({
        name: `Company ${randomUUID()}`,
        issuePrefix,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createUser() {
    const now = new Date();
    return db
      .insert(authUsers)
      .values({
        id: `user-${randomUUID()}`,
        name: "Board User",
        email: `${randomUUID()}@example.com`,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function addMembership(userId: string, companyId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "admin",
    });
  }

  async function addInstanceAdmin(userId: string) {
    await db.insert(instanceUserRoles).values({
      userId,
      role: "instance_admin",
    });
  }

  async function createBoardKey(userId: string, allowedCompanySlugs: string[]) {
    const token = `pcp_board_test_${randomUUID()}`;
    await db.insert(boardApiKeys).values({
      userId,
      name: "test board key",
      keyHash: hashBearerToken(token),
      allowedCompanySlugs,
      expiresAt: boardApiKeyExpiresAt(),
    });
    return token;
  }

  async function createAgent(companyId: string) {
    return db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createAgentKey(input: {
    agentId: string;
    companyId: string;
    allowedCompanySlugs: string[];
  }) {
    const token = `pcp_agent_test_${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      agentId: input.agentId,
      companyId: input.companyId,
      name: "test agent key",
      keyHash: hashToken(token),
      allowedCompanySlugs: input.allowedCompanySlugs,
    });
    return token;
  }

  it("preserves board API key membership and admin access when allowedCompanySlugs is empty", async () => {
    const companyA = await createCompany(`A${randomUUID().slice(0, 8)}`);
    const companyB = await createCompany(`B${randomUUID().slice(0, 8)}`);
    const user = await createUser();
    await addMembership(user.id, companyA.id);
    await addMembership(user.id, companyB.id);
    await addInstanceAdmin(user.id);
    const token = await createBoardKey(user.id, []);
    const app = createAccessApp(db);

    const [resA, resB] = await Promise.all([
      request(app).get(`/companies/${companyA.id}`).set("authorization", `Bearer ${token}`),
      request(app).get(`/companies/${companyB.id}`).set("authorization", `Bearer ${token}`),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.isInstanceAdmin).toBe(true);
    expect(resB.body.companyIds).toEqual(expect.arrayContaining([companyA.id, companyB.id]));
  });

  it("rejects board API key access outside non-empty allowedCompanySlugs even for an admin and member", async () => {
    const companyA = await createCompany(`Alpha ${randomUUID().slice(0, 8)}`);
    const companyB = await createCompany(`Beta ${randomUUID().slice(0, 8)}`);
    const slugA = expectedSlug(companyA.issuePrefix, companyA.id);
    const user = await createUser();
    await addMembership(user.id, companyA.id);
    await addMembership(user.id, companyB.id);
    await addInstanceAdmin(user.id);
    const token = await createBoardKey(user.id, [slugA]);
    const app = createAccessApp(db);

    const res = await request(app)
      .get(`/companies/${companyB.id}`)
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("User does not have access to this company");
  });

  it("allows board API key access inside non-empty allowedCompanySlugs with existing access", async () => {
    const companyA = await createCompany(`Scoped ${randomUUID().slice(0, 8)}`);
    const companyB = await createCompany(`Other ${randomUUID().slice(0, 8)}`);
    const slugA = expectedSlug(companyA.issuePrefix, companyA.id);
    const user = await createUser();
    await addMembership(user.id, companyA.id);
    await addMembership(user.id, companyB.id);
    const token = await createBoardKey(user.id, [slugA]);
    const app = createAccessApp(db);

    const res = await request(app)
      .get(`/companies/${companyA.id}`)
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.companyIds).toEqual([companyA.id]);
    expect(res.body.memberships).toEqual([
      expect.objectContaining({ companyId: companyA.id, status: "active" }),
    ]);
  });

  it("stores the requested company slug when approving a company-scoped CLI auth challenge", async () => {
    const company = await createCompany(`CLI ${randomUUID().slice(0, 8)}`);
    const user = await createUser();
    const boardAuth = boardAuthService(db);
    const { challenge, challengeSecret } = await boardAuth.createCliAuthChallenge({
      command: "paperclipai test",
      requestedAccess: "board",
      requestedCompanyId: company.id,
    });

    const approved = await boardAuth.approveCliAuthChallenge(challenge.id, challengeSecret, user.id);

    const stored = await db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.id, approved.challenge.boardApiKeyId!))
      .then((rows) => rows[0]!);
    expect(stored.allowedCompanySlugs).toEqual([expectedSlug(company.issuePrefix, company.id)]);
  });

  it("stores the normalized company issue prefix when creating an agent API key", async () => {
    const company = await createCompany(` Acme & Co!! ${randomUUID().slice(0, 4)} `);
    const agent = await createAgent(company.id);

    const created = await agentService(db).createApiKey(agent.id, "agent key");

    const stored = await db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, created.id))
      .then((rows) => rows[0]!);
    expect(stored.allowedCompanySlugs).toEqual([expectedSlug(company.issuePrefix, company.id)]);
  });

  it("does not authenticate an agent API key when its allowedCompanySlugs excludes the key company", async () => {
    const company = await createCompany(`Agent ${randomUUID().slice(0, 8)}`);
    const agent = await createAgent(company.id);
    const token = await createAgentKey({
      agentId: agent.id,
      companyId: company.id,
      allowedCompanySlugs: ["different-company"],
    });
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.get("/actor", (req, res) => {
      res.status(req.actor.type === "none" ? 401 : 200).json(req.actor);
    });

    const res = await request(app).get("/actor").set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.type).toBe("none");
  });

  it("rejects live event websocket agent-key auth when allowedCompanySlugs excludes the requested company", async () => {
    const company = await createCompany(`Events ${randomUUID().slice(0, 8)}`);
    const agent = await createAgent(company.id);
    const token = await createAgentKey({
      agentId: agent.id,
      companyId: company.id,
      allowedCompanySlugs: ["different-company"],
    });
    const server = createServer();
    setupLiveEventsWebSocketServer(server, db, { deploymentMode: "authenticated" });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const result = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/api/companies/${company.id}/events/ws?token=${encodeURIComponent(token)}`,
        );
        ws.once("open", () => {
          ws.close();
          reject(new Error("websocket unexpectedly opened"));
        });
        ws.once("error", (err) => {
          resolve(err.message);
        });
      });

      expect(result).toContain("403");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
