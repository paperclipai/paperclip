import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, heartbeatRuns, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import {
  __clearIssueListResponseCacheForTests,
  issueRoutes,
} from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list query-param tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list query parameter validation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-query-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    __clearIssueListResponseCacheForTests();
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    const userId = "cloud-user-1";
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
    return companyId;
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id") ?? "cloud-user-1";
      (req as any).actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: userId }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  // A guessed parameter name used to return the whole board with HTTP 200, so a
  // caller could not tell its filter had done nothing. That is worse than a 400.
  it.each(["assigneeId", "assignedTo", "agentId", "includeClosed", "totallyBogusParam"])(
    "rejects the unrecognised query parameter %s with 400 instead of ignoring it",
    async (param) => {
      const companyId = await seedCompany();
      const app = createApp(companyId);

      const res = await request(app)
        .get(`/api/companies/${companyId}/issues`)
        .query({ [param]: "x" });

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error).toContain(`'${param}'`);
      expect(Array.isArray(res.body.supported)).toBe(true);
      expect(res.body.supported).toContain("assigneeAgentId");
    },
  );

  it.each([
    ["assigneeId", "assigneeAgentId"],
    ["assignedTo", "assigneeAgentId"],
    ["agentId", "assigneeAgentId"],
  ])("names assigneeAgentId as the correct parameter for %s", async (param, suggestion) => {
    const companyId = await seedCompany();
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ [param]: randomUUID() });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toContain(`Did you mean '${suggestion}'?`);
  });

  it("rejects an unrecognised status instead of returning an empty list", async () => {
    const companyId = await seedCompany();
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "bogusstatus" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toContain("in_progress");
  });

  it("rejects an unrecognised status inside an otherwise valid comma list", async () => {
    const companyId = await seedCompany();
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo,bogusstatus" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toContain("bogusstatus");
  });

  it("accepts a valid status list", async () => {
    const companyId = await seedCompany();
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo,in_progress,blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("accepts the documented working parameter and actually filters", async () => {
    const companyId = await seedCompany();
    const assignedAgentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: assignedAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
      },
    ]);
    const assignedIssueId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        issuePrefix: "P1",
        issueNumber: 1,
        title: "Mine",
        status: "todo",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: otherIssueId,
        companyId,
        issuePrefix: "P1",
        issueNumber: 2,
        title: "Theirs",
        status: "todo",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.execute(
      `UPDATE issues SET assignee_agent_id = '${assignedAgentId}' WHERE id = '${assignedIssueId}'`,
    );

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ assigneeAgentId: assignedAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([assignedIssueId]);
  });

  it("still accepts every parameter the board UI sends", async () => {
    const companyId = await seedCompany();
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({
        status: "todo",
        projectId: randomUUID(),
        parentId: randomUUID(),
        assigneeAgentId: randomUUID(),
        participantAgentId: randomUUID(),
        assigneeUserId: "me",
        touchedByUserId: "me",
        inboxArchivedByUserId: "me",
        unreadForUserId: "me",
        labelId: randomUUID(),
        workspaceId: randomUUID(),
        executionWorkspaceId: randomUUID(),
        originKind: "manual",
        originKindPrefix: "manual",
        originId: randomUUID(),
        descendantOf: randomUUID(),
        createdFromIssueId: randomUUID(),
        includeRoutineExecutions: "true",
        includeBlockedBy: "true",
        includeBlockedInboxAttention: "true",
        includeLiveDescendantSummary: "true",
        hasPlanDocument: "false",
        q: "anything",
        limit: "20",
        offset: "0",
        sortField: "id",
        sortDir: "asc",
        afterId: randomUUID(),
        attention: "blocked",
        updatedSince: new Date().toISOString(),
        view: "compact",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
