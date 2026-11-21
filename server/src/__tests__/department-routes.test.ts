import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  agentDepartments,
  agents,
  companies,
  companyMemberships,
  createDb,
  departments,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { departmentRoutes } from "../routes/departments.js";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

type Db = ReturnType<typeof createDb>;
type Actor = Record<string, unknown>;

function createApp(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", departmentRoutes(db));
  app.use(errorHandler);
  return app;
}

(support.supported ? describe : describe.skip)("department routes", () => {
  it("denies catalog creation and ungranted membership replacement, and hides unreadable members", async () => {
    const database = await startEmbeddedPostgresTestDatabase("department-routes-");
    const db = createDb(database.connectionString);
    try {
      const companyId = randomUUID();
      const userId = randomUUID();
      const agentId = randomUUID();
      const peerId = randomUUID();
      const projectId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Departments", issuePrefix: "DPT" });
      await db.insert(agents).values([
        {
          id: agentId,
          companyId,
          name: "Restricted",
          permissions: {
            trustPreset: LOW_TRUST_REVIEW_PRESET,
            authorizationPolicy: {
              trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, projectIds: [projectId] },
            },
          },
        },
        { id: peerId, companyId, name: "Peer" },
      ]);
      await db.insert(companyMemberships).values([
        { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
        { companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" },
      ]);
      const member = {
        type: "board" as const,
        userId,
        source: "session" as const,
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      };
      const agent = {
        type: "agent" as const,
        agentId,
        companyId,
        source: "agent_key" as const,
        companyIds: [companyId],
      };
      // A standard agent can update its own configuration. That allowance must
      // not create a company-wide department.
      const peer = {
        type: "agent" as const,
        agentId: peerId,
        companyId,
        source: "agent_key" as const,
        companyIds: [companyId],
      };
      const memberApp = createApp(db, member);
      const agentApp = createApp(db, agent);
      const peerApp = createApp(db, peer);

      const createdByAgent = await request(peerApp).post(`/api/companies/${companyId}/departments`).send({ name: "Accounting" });
      expect(createdByAgent.status).toBe(403);
      expect(await db.select().from(departments)).toHaveLength(0);

      const created = await request(memberApp).post(`/api/companies/${companyId}/departments`).send({ name: "Accounting" });
      expect(created.status).toBe(201);
      const departmentId = created.body.id as string;

      const denied = await request(memberApp).put(`/api/agents/${agentId}/departments`).send({ departmentIds: [departmentId] });
      expect(denied.status).toBe(403);
      expect(await db.select().from(agentDepartments)).toHaveLength(0);

      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "user",
        principalId: userId,
        permissionKey: "agents:configure",
        scope: {},
      });
      const replaced = await request(memberApp).put(`/api/agents/${agentId}/departments`).send({
        departmentIds: [departmentId],
      });
      expect(replaced.status).toBe(200);
      const assignedByPeer = await request(peerApp).put(`/api/agents/${peerId}/departments`).send({
        departmentIds: [departmentId],
      });
      expect(assignedByPeer.status).toBe(200);

      const listed = await request(agentApp).get(`/api/companies/${companyId}/departments`);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([
        expect.objectContaining({ id: departmentId, name: "Accounting", agentIds: [agentId] }),
      ]);
      expect(JSON.stringify(listed.body)).not.toContain(peerId);

      const named = await request(peerApp).put(`/api/agents/${peerId}/departments`).send({
        departmentIds: [departmentId],
        names: ["Finance"],
      });
      expect(named.status).toBe(403);
      expect(await db.select().from(departments).where(eq(departments.companyId, companyId))).toHaveLength(1);
      expect(await db.select().from(agentDepartments)).toHaveLength(2);
    } finally {
      await database.cleanup();
    }
  }, 120_000);
});
