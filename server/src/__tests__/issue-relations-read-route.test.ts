import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issueRelations,
  issues,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
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
    `Skipping embedded Postgres issue relation read route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue relation read route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-relations-read-route-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, actor?: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor ?? {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `REL${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
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

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Relation route company",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    return companyId;
  }

  async function seedProject(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(projects).values({
      id,
      companyId,
      name,
    });
    return { id, name };
  }

  async function seedAgent(companyId: string, permissions: Record<string, unknown>) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "Low trust relation reader",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions,
    });
    return { id };
  }

  async function seedIssue(
    companyId: string,
    title: string,
    issueNumber: number,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ) {
    const id = overrides.id ?? randomUUID();
    const identifier = overrides.identifier ?? `REL-${issueNumber}`;
    await db.insert(issues).values({
      id,
      companyId,
      title,
      status: overrides.status ?? "todo",
      priority: overrides.priority ?? "medium",
      identifier,
      issueNumber,
      createdByUserId: "cloud-user-1",
      projectId: overrides.projectId,
      parentId: overrides.parentId,
      assigneeAgentId: overrides.assigneeAgentId,
    });
    return { id, identifier, title };
  }

  it("returns canonical blocker relation summaries without mutating relation or activity rows", async () => {
    const companyId = await seedCompany();
    const blocked = await seedIssue(companyId, "Blocked issue", 1);
    const blocker = await seedIssue(companyId, "Blocker issue", 2);
    const downstream = await seedIssue(companyId, "Downstream issue", 3);
    await db.insert(issueRelations).values([
      {
        companyId,
        issueId: blocker.id,
        relatedIssueId: blocked.id,
        type: "blocks",
        createdByUserId: "cloud-user-1",
      },
      {
        companyId,
        issueId: blocked.id,
        relatedIssueId: downstream.id,
        type: "blocks",
        createdByUserId: "cloud-user-1",
      },
    ]);

    const app = createApp(companyId);
    const beforeRelations = await db.select().from(issueRelations);
    const beforeActivity = await db.select().from(activityLog);

    const res = await request(app).get(`/api/issues/${blocked.id}/relations`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ issueId: blocked.id });
    expect(res.body.blockedBy).toEqual([
      expect.objectContaining({
        id: blocker.id,
        identifier: blocker.identifier,
        title: blocker.title,
      }),
    ]);
    expect(res.body.blocks).toEqual([
      expect.objectContaining({
        id: downstream.id,
        identifier: downstream.identifier,
        title: downstream.title,
      }),
    ]);

    const afterRelations = await db.select().from(issueRelations);
    const afterActivity = await db.select().from(activityLog);
    expect(afterRelations).toEqual(beforeRelations);
    expect(afterActivity).toEqual(beforeActivity);
  });

  it("returns 404 for a missing issue", async () => {
    const companyId = await seedCompany();
    const app = createApp(companyId);

    const res = await request(app).get(`/api/issues/${randomUUID()}/relations`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
  });

  it("enforces company access before returning relation summaries", async () => {
    const companyId = await seedCompany();
    const issue = await seedIssue(companyId, "Private relation issue", 1);
    const app = createApp(companyId, {
      type: "board",
      userId: "cloud-user-2",
      companyIds: [],
      memberships: [],
      source: "cloud_tenant",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/issues/${issue.id}/relations`);

    expect(res.status).toBe(403);
  });

  it("enforces issue read policy after company access succeeds", async () => {
    const companyId = await seedCompany();
    const allowedProject = await seedProject(companyId, "Allowed relation project");
    const deniedProject = await seedProject(companyId, "Denied relation project");
    const agent = await seedAgent(companyId, {
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: {
        trustBoundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          projectIds: [allowedProject.id],
          allowedAgentIds: [],
        },
      },
    });
    const issue = await seedIssue(companyId, "Outside read boundary", 4, {
      projectId: deniedProject.id,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: agent.id,
      companyId,
      source: "agent_key",
    });

    const res = await request(app).get(`/api/issues/${issue.id}/relations`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Issue is outside this actor's authorization boundary" });
  });
});
