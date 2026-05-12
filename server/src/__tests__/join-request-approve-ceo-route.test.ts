import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  invites,
  joinRequests,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: vi.fn(async () => undefined),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping CEO joins:approve route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /companies/:companyId/join-requests/:requestId/{approve,reject} (CEO agent)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let ceoAgentId!: string;
  let inviteId!: string;
  let joinRequestId!: string;
  let placeholderAgentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-join-approve-ceo-route-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    ceoAgentId = randomUUID();
    inviteId = randomUUID();
    joinRequestId = randomUUID();
    placeholderAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ceoAgentId,
        companyId,
        name: "CEO",
        role: "ceo",
      },
      {
        id: placeholderAgentId,
        companyId,
        name: "Joiner",
        role: "engineer",
      },
    ]);
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: ceoAgentId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(invites).values({
      id: inviteId,
      companyId,
      inviteType: "company_join",
      tokenHash: `token-${inviteId}`,
      allowedJoinTypes: "agent",
      defaultsPayload: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await db.insert(joinRequests).values({
      id: joinRequestId,
      inviteId,
      companyId,
      requestType: "agent",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      createdAgentId: placeholderAgentId,
      agentName: "Joiner",
    });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: ceoAgentId,
        companyId,
        companyIds: [companyId],
        source: "agent_key",
      };
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  async function grantJoinsApprove() {
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: ceoAgentId,
      permissionKey: "joins:approve",
      scope: null,
      grantedByUserId: null,
    });
  }

  it("denies the CEO agent without a joins:approve grant", async () => {
    const res = await request(createApp()).post(
      `/api/companies/${companyId}/join-requests/${joinRequestId}/approve`,
    );
    expect(res.status).toBe(403);
  });

  it("approves the join request when the CEO agent has a joins:approve grant", async () => {
    await grantJoinsApprove();

    const res = await request(createApp()).post(
      `/api/companies/${companyId}/join-requests/${joinRequestId}/approve`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("approved");
  });

  it("rejects the join request when the CEO agent has a joins:approve grant", async () => {
    await grantJoinsApprove();

    const res = await request(createApp()).post(
      `/api/companies/${companyId}/join-requests/${joinRequestId}/reject`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("rejected");
  });
});
