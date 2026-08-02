import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentFallbackSisters, agents, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue identifier route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue identifier routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-identifier-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        // cloud_tenant actors are never instance admins — access flows through
        // company-scoped membership grants, seeded per test company below.
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCloudTenantMember(companyId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
  }

  it("resolves alphanumeric Cloud tenant issue identifiers for detail reads and updates", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Cloud tenant",
      issuePrefix: "PC1A2",
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 7,
      identifier: "PC1A2-7",
      title: "Tenant identifier route",
      status: "todo",
      priority: "medium",
      createdByUserId: "cloud-user-1",
    });

    const app = createApp(companyId);
    const read = await request(app).get("/api/issues/pc1a2-7");

    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({
      id: issueId,
      companyId,
      identifier: "PC1A2-7",
    });

    const updated = await request(app)
      .patch("/api/issues/PC1A2-7")
      .send({ priority: "high" });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({
      id: issueId,
      companyId,
      identifier: "PC1A2-7",
      priority: "high",
    });

    const stored = await db
      .select({ priority: issues.priority })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(stored?.priority).toBe("high");
  });

  it("keeps ordinary foreign issue detail reads denied", async () => {
    const localCompanyId = randomUUID();
    const foreignCompanyId = randomUUID();
    const foreignIssueId = randomUUID();

    await db.insert(companies).values([
      {
        id: localCompanyId,
        name: "Local tenant",
        issuePrefix: "LOCAL",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: foreignCompanyId,
        name: "Foreign tenant",
        issuePrefix: "FOREIGN",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await seedCloudTenantMember(localCompanyId);
    await db.insert(issues).values({
      id: foreignIssueId,
      companyId: foreignCompanyId,
      identifier: "FOREIGN-42",
      title: "Foreign title must remain private",
      status: "done",
      priority: "high",
    });

    const byId = await request(createApp(localCompanyId)).get(`/api/issues/${foreignIssueId}`);
    const byIdentifier = await request(createApp(localCompanyId)).get("/api/issues/FOREIGN-42");

    // Foreign detail lookups stay tenant-dark, even when their id or identifier is known.
    expect(byId.status).toBe(404);
    expect(byId.body.error).toBe("Issue not found");
    expect(byIdentifier.status).toBe(404);
    expect(byIdentifier.body.error).toBe("Issue not found");
  });

  it("stores the exact requested fallback sister on create and patch", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const primaryAgentId = randomUUID();
    const sisterAgentId = randomUUID();
    const issuePrefix = `PC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Cloud tenant",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values([
      {
        id: primaryAgentId,
        companyId,
        name: "Auditor",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: sisterAgentId,
        companyId,
        name: "Auditor-Codex",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(agentFallbackSisters).values({
      companyId,
      primaryAgentId,
      sisterAgentId,
      priority: 0,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 7,
      identifier: `${issuePrefix}-7`,
      title: "Tenant identifier route",
      status: "todo",
      priority: "medium",
      assigneeAgentId: primaryAgentId,
      createdByUserId: "cloud-user-1",
    });

    const app = createApp(companyId);

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Create should keep the requested sister",
        status: "todo",
        assigneeAgentId: sisterAgentId,
      });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      assigneeAgentId: sisterAgentId,
    });
    const createdStored = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, created.body.id))
      .then((rows) => rows[0] ?? null);
    expect(createdStored?.assigneeAgentId).toBe(sisterAgentId);

    const updated = await request(app)
      .patch(`/api/issues/${issuePrefix}-7`)
      .send({ assigneeAgentId: sisterAgentId });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({
      id: issueId,
      assigneeAgentId: sisterAgentId,
    });

    const stored = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(stored?.assigneeAgentId).toBe(sisterAgentId);
  });
});
