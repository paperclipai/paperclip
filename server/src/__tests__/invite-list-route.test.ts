import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, invites, joinRequests } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    isInstanceAdmin: vi.fn(),
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  boardAuthService: () => ({
    createChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn(),
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres invite list route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /companies/:companyId/invites", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-invite-list-route-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterEach(async () => {
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(currentCompanyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: null,
        companyIds: [currentCompanyId],
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

  it("returns invite history in descending pages with nextOffset", async () => {
    const inviteOneId = randomUUID();
    const inviteTwoId = randomUUID();
    const inviteThreeId = randomUUID();

    await db.insert(invites).values([
      {
        id: inviteOneId,
        companyId,
        inviteType: "company_join",
        tokenHash: "invite-token-1",
        allowedJoinTypes: "human",
        defaultsPayload: { humanRole: "viewer" },
        expiresAt: new Date("2026-04-20T00:00:00.000Z"),
        createdAt: new Date("2026-04-10T00:00:00.000Z"),
        updatedAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        id: inviteTwoId,
        companyId,
        inviteType: "company_join",
        tokenHash: "invite-token-2",
        allowedJoinTypes: "human",
        defaultsPayload: { humanRole: "operator" },
        expiresAt: new Date("2026-04-21T00:00:00.000Z"),
        createdAt: new Date("2026-04-11T00:00:00.000Z"),
        updatedAt: new Date("2026-04-11T00:00:00.000Z"),
      },
      {
        id: inviteThreeId,
        companyId,
        inviteType: "company_join",
        tokenHash: "invite-token-3",
        allowedJoinTypes: "human",
        defaultsPayload: { humanRole: "admin" },
        expiresAt: new Date("2026-04-22T00:00:00.000Z"),
        createdAt: new Date("2026-04-12T00:00:00.000Z"),
        updatedAt: new Date("2026-04-12T00:00:00.000Z"),
      },
    ]);

    await db.insert(joinRequests).values({
      id: randomUUID(),
      inviteId: inviteThreeId,
      companyId,
      requestType: "human",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      requestEmailSnapshot: "person@example.com",
      createdAt: new Date("2026-04-12T00:05:00.000Z"),
      updatedAt: new Date("2026-04-12T00:05:00.000Z"),
    });

    const app = createApp(companyId);

    const firstPage = await request(app).get(`/api/companies/${companyId}/invites?limit=2`);

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.invites).toHaveLength(2);
    expect(firstPage.body.invites.map((invite: { id: string }) => invite.id)).toEqual([inviteThreeId, inviteTwoId]);
    expect(firstPage.body.invites[0].relatedJoinRequestId).toBeTruthy();
    expect(firstPage.body.nextOffset).toBe(2);

    const secondPage = await request(app).get(`/api/companies/${companyId}/invites?limit=2&offset=2`);

    expect(secondPage.status).toBe(200);
    expect(secondPage.body.invites).toHaveLength(1);
    expect(secondPage.body.invites[0].id).toBe(inviteOneId);
    expect(secondPage.body.nextOffset).toBeNull();
  });
});
