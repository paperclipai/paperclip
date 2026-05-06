import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  authUsers,
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

describeEmbeddedPostgres("POST /invites/:token/accept human auto approval", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-invite-auto-approval-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("auto-approves explicit owner human invites and grants the role permissions", async () => {
    const now = new Date();
    const inviterId = `inviter-${randomUUID()}`;
    const invitedUserId = `invited-${randomUUID()}`;
    const token = `pcp_invite_${randomUUID().replaceAll("-", "")}`;
    await db.insert(authUsers).values([
      {
        id: inviterId,
        name: "Inviter Admin",
        email: "admin@example.com",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: invitedUserId,
        name: "Invited Owner",
        email: "owner@example.com",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const company = await db
      .insert(companies)
      .values({
        name: "Invite Auto Approval Co",
        issuePrefix: `IA${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(invites).values({
      companyId: company.id,
      inviteType: "company_join",
      tokenHash: hashToken(token),
      allowedJoinTypes: "human",
      defaultsPayload: {
        human: {
          role: "owner",
          grants: [
            { permissionKey: "agents:create", scope: null },
            { permissionKey: "users:invite", scope: null },
            { permissionKey: "users:manage_permissions", scope: null },
            { permissionKey: "tasks:assign", scope: null },
            { permissionKey: "joins:approve", scope: null },
          ],
        },
      },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      invitedByUserId: inviterId,
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId: invitedUserId,
        companyIds: [],
        memberships: [],
      };
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/invites/${token}/accept`)
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("approved");
    expect(res.body.approvedByUserId).toBe(inviterId);

    const membership = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.principalId, invitedUserId))
      .then((rows) => rows[0]!);
    expect(membership.companyId).toBe(company.id);
    expect(membership.membershipRole).toBe("owner");
    expect(membership.status).toBe("active");

    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, invitedUserId));
    expect(grants.map((grant) => grant.permissionKey).sort()).toEqual([
      "agents:create",
      "joins:approve",
      "tasks:assign",
      "users:invite",
      "users:manage_permissions",
    ]);

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, res.body.id));
    expect(activity.map((entry) => entry.action)).toEqual(["join.auto_approved"]);
  }, 20_000);

  it("leaves agent invites in the existing pending approval flow", async () => {
    const token = `pcp_invite_${randomUUID().replaceAll("-", "")}`;
    const company = await db
      .insert(companies)
      .values({
        name: "Agent Invite Co",
        issuePrefix: `AI${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(invites).values({
      companyId: company.id,
      inviteType: "company_join",
      tokenHash: hashToken(token),
      allowedJoinTypes: "agent",
      defaultsPayload: {
        agent: {
          grants: [{ permissionKey: "tasks:assign", scope: null }],
        },
      },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      invitedByUserId: null,
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "anonymous",
        source: "none",
      };
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/invites/${token}/accept`)
      .send({ requestType: "agent", agentName: "Research Agent" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending_approval");
    expect(res.body.requestType).toBe("agent");

    const memberships = await db.select().from(companyMemberships);
    expect(memberships).toEqual([]);
  }, 20_000);
});
