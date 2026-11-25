import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { AgentApiKeyScope } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { accessService } from "../services/access.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { assertBoard, assertBoardUser, assertCompanyAccess, assertInstanceAdmin, boardAuthorityUserId } from "../routes/authz.js";
import { attributeActivityToBoardOperator, withBoardOperatorOrigin } from "../services/board-operator-context.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("board operator agents", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), otherCompanyId = randomUUID();
  const operatorId = randomUUID(), peerId = randomUUID(), lowTrustId = randomUUID();
  const ownerUserId = `user-${randomUUID()}`, outsiderUserId = `user-${randomUUID()}`;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "board-operator-agent-authentication-secret");
    database = await startEmbeddedPostgresTestDatabase("paperclip-board-operator-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Operator", issuePrefix: "OPR" },
      { id: otherCompanyId, name: "Elsewhere", issuePrefix: "ELS" },
    ]);
    await db.insert(authUsers).values([ownerUserId, outsiderUserId].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    })));
    await db.insert(agents).values([
      { id: operatorId, companyId, name: "Lead", adapterType: "process", lifecycleHolds: [] },
      { id: peerId, companyId, name: "Peer", adapterType: "process", lifecycleHolds: [] },
      { id: lowTrustId, companyId, name: "Reviewed", adapterType: "process", lifecycleHolds: [],
        permissions: { trustPreset: "low_trust_review" } },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner" },
      { companyId: otherCompanyId, principalType: "user", principalId: outsiderUserId, status: "active", membershipRole: "owner" },
      ...[operatorId, peerId, lowTrustId].map((principalId) => ({
        companyId, principalType: "agent" as const, principalId, status: "active", membershipRole: "member",
      })),
    ]);
  }, 30_000);

  beforeEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(agentApiKeys);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  }, 60_000);

  function grant(agentId: string, scope: Record<string, unknown> | null = null) {
    return db.insert(principalPermissionGrants).values({
      companyId, principalType: "agent", principalId: agentId, permissionKey: "board:operate", scope,
      grantedByUserId: ownerUserId,
    });
  }

  function app() {
    const server = express();
    server.use(express.json());
    server.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    server.get("/actor", (req, res) => { res.json(req.actor); });
    server.post("/companies/:companyId/board-action", (req, res) => {
      assertBoard(req);
      assertCompanyAccess(req, req.params.companyId as string);
      res.json({ ok: true, authorityUserId: boardAuthorityUserId(req) ?? null });
    });
    server.post("/companies/:companyId/person-action", (req, res) => {
      assertBoardUser(req);
      assertCompanyAccess(req, req.params.companyId as string);
      res.json({ ok: true });
    });
    server.post("/instance/action", (req, res) => {
      assertInstanceAdmin(req);
      res.json({ ok: true });
    });
    server.use(errorHandler);
    return server;
  }

  function jwt(agentId: string, responsibleUserId: string | null = ownerUserId, scope?: AgentApiKeyScope) {
    return createLocalAgentJwt(agentId, companyId, "process", randomUUID(), responsibleUserId, scope)!;
  }

  async function agentKey(agentId: string, scopeConfig: AgentApiKeyScope | null = null) {
    const token = `pcp_${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      agentId, companyId, name: "test", keyHash: createHash("sha256").update(token).digest("hex"),
      responsibleUserId: ownerUserId, scopeConfig,
    });
    return token;
  }

  const actor = (token: string) => request(app()).get("/actor").set("authorization", `Bearer ${token}`);
  const post = (token: string, path: string) => request(app()).post(path).set("authorization", `Bearer ${token}`).send({});

  it("marks no agent as an operator without the grant, and board-only routes refuse it exactly as before", async () => {
    const response = await actor(jwt(operatorId));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ type: "agent", agentId: operatorId });
    expect(response.body).not.toHaveProperty("boardOperator");
    const denied = await post(jwt(operatorId), `/companies/${companyId}/board-action`);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: "Board access required", code: "board_access_required" });
  });

  it("lets a granted agent through assertBoard in its own company, with its responsible user's authority", async () => {
    await grant(operatorId);
    for (const token of [jwt(operatorId), await agentKey(operatorId)]) {
      expect((await actor(token)).body).toMatchObject({ type: "agent", agentId: operatorId, boardOperator: true });
      const allowed = await post(token, `/companies/${companyId}/board-action`);
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      expect(allowed.body).toEqual({ ok: true, authorityUserId: ownerUserId });
      expect((await post(token, `/companies/${otherCompanyId}/board-action`)).status).toBe(403);
      const person = await post(token, `/companies/${companyId}/person-action`);
      expect(person.status).toBe(403);
      expect(person.body).toMatchObject({ code: "board_access_required" });
      expect((await post(token, "/instance/action")).status).toBe(403);
    }
    expect((await actor(jwt(peerId))).body).not.toHaveProperty("boardOperator");
    expect((await post(jwt(peerId), `/companies/${companyId}/board-action`)).status).toBe(403);
  });

  it("takes effect on the next request when a board user revokes the grant", async () => {
    await grant(operatorId);
    const token = jwt(operatorId);
    expect((await post(token, `/companies/${companyId}/board-action`)).status).toBe(200);
    await db.delete(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.principalId, operatorId), eq(principalPermissionGrants.permissionKey, "board:operate")));
    expect((await post(token, `/companies/${companyId}/board-action`)).status).toBe(403);
  });

  it("never elevates a task-scoped key, a low-trust agent, a scoped grant or a run without a responsible member", async () => {
    await grant(operatorId);
    await grant(lowTrustId);
    await grant(peerId, { projectIds: [randomUUID()] });
    const skillTest: AgentApiKeyScope = { kind: "skill_test", issueId: randomUUID() };
    const cases = [
      jwt(operatorId, ownerUserId, skillTest),
      await agentKey(operatorId, skillTest),
      jwt(operatorId, null),
      jwt(operatorId, outsiderUserId),
      jwt(lowTrustId),
      jwt(peerId),
    ];
    for (const token of cases) {
      const response = await actor(token);
      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty("boardOperator");
    }
  });

  it("does not make a low-trust run a board operator, even for a granted agent", async () => {
    await grant(operatorId);
    const [standardRun, lowTrustRun] = [randomUUID(), randomUUID()];
    await db.insert(heartbeatRuns).values([
      { id: standardRun, companyId, agentId: operatorId, status: "running", responsibleUserId: ownerUserId },
      { id: lowTrustRun, companyId, agentId: operatorId, status: "running", responsibleUserId: ownerUserId,
        contextSnapshot: { executionPolicy: { trustPreset: "low_trust_review",
          authorizationPolicy: { trustPreset: "low_trust_review", trustBoundary: { rootIssueId: randomUUID() } } } } },
    ]);
    const runJwt = (runId: string) => createLocalAgentJwt(operatorId, companyId, "process", runId, ownerUserId)!;

    expect((await actor(runJwt(standardRun))).body).toMatchObject({ boardOperator: true });
    expect((await actor(runJwt(lowTrustRun))).body).not.toHaveProperty("boardOperator");
    expect((await post(runJwt(lowTrustRun), `/companies/${companyId}/board-action`)).status).toBe(403);
    const key = await agentKey(operatorId);
    const keyed = await request(app()).get("/actor").set("authorization", `Bearer ${key}`).set("x-paperclip-run-id", lowTrustRun);
    expect(keyed.body).not.toHaveProperty("boardOperator");
  });

  it("lets only the grant route add or remove the key, so imports and member edits cannot", async () => {
    const access = accessService(db);
    const keys = async (agentId: string) => (await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, agentId))).map((row) => row.permissionKey).sort();

    await access.setPrincipalPermission(companyId, "agent", peerId, "board:operate", true, ownerUserId);
    await access.setPrincipalGrants(companyId, "agent", lowTrustId, [{ permissionKey: "board:operate" }], ownerUserId);
    expect(await keys(peerId)).toEqual([]);
    expect(await keys(lowTrustId)).toEqual([]);

    await grant(operatorId);
    await access.setPrincipalGrants(companyId, "agent", operatorId, [{ permissionKey: "tasks:assign" }], ownerUserId);
    expect(await keys(operatorId)).toEqual(["board:operate", "tasks:assign"]);
    const [membership] = await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.principalType, "agent"), eq(companyMemberships.principalId, operatorId)));
    await access.setMemberPermissions(companyId, membership!.id, [], ownerUserId);
    expect(await keys(operatorId)).toEqual(["board:operate"]);
  });

  it("stops counting the grant once the agent leaves the company", async () => {
    await grant(operatorId);
    await db.update(companyMemberships).set({ status: "suspended" }).where(and(
      eq(companyMemberships.principalType, "agent"), eq(companyMemberships.principalId, operatorId)));
    try {
      expect((await actor(jwt(operatorId))).body).not.toHaveProperty("boardOperator");
    } finally {
      await db.update(companyMemberships).set({ status: "active" }).where(and(
        eq(companyMemberships.principalType, "agent"), eq(companyMemberships.principalId, operatorId)));
    }
  });
});

describe("board operator activity attribution", () => {
  const origin = { companyId: "company-1", agentId: "operator-1", runId: "run-1", responsibleUserId: "user-1" };

  it("names the operator agent on board rows, and keeps an agent the row is about", () => {
    const row = { companyId: "company-1", actorType: "user" as const, actorId: "board" };
    expect(withBoardOperatorOrigin(origin, () => attributeActivityToBoardOperator({ ...row, agentId: null })))
      .toMatchObject({ actorType: "agent", actorId: "operator-1", agentId: "operator-1", runId: "run-1",
        details: { boardOperator: true } });
    expect(withBoardOperatorOrigin(origin, () => attributeActivityToBoardOperator({ ...row, agentId: "worker-1" })))
      .toMatchObject({ actorId: "operator-1", agentId: "worker-1" });
    expect(withBoardOperatorOrigin(origin, () => attributeActivityToBoardOperator({ ...row, companyId: "company-2" })))
      .toEqual({ ...row, companyId: "company-2" });
  });
});
