import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AGENT_CHAT_ORIGIN_KIND } from "@paperclipai/shared";
import { activityLog, agents, companies, companyMemberships, createDb, heartbeatRuns, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { issueService } from "../services/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent chat issue route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent chat issue routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-chat-issue-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
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

  function createApp(
    companyId: string,
    actor?: { type: "agent"; agentId: string },
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (actor?.type === "agent") {
        (req as any).actor = {
          type: "agent",
          agentId: actor.agentId,
          companyId,
          source: "agent_key",
        };
      } else {
        (req as any).actor = {
          type: "board",
          userId: "cloud-user-1",
          companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: "cloud-user-1" }],
          source: "cloud_tenant",
          isInstanceAdmin: false,
        };
      }
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
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
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Alpha Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("creates the standing chat issue on first open and reuses it afterwards", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const app = createApp(companyId);

    const first = await request(app).post(`/api/agents/${agentId}/chat-issue`);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.created).toBe(true);
    expect(first.body.issue.originKind).toBe(AGENT_CHAT_ORIGIN_KIND);
    expect(first.body.issue.originId).toBe(agentId);
    expect(first.body.issue.workMode).toBe("ask");
    expect(first.body.issue.status).toBe("backlog");
    expect(first.body.issue.assigneeAgentId).toBe(agentId);
    expect(first.body.issue.title).toBe("Chat with Alpha Agent");
    expect(first.body.issue.identifier).toBeTruthy();

    const second = await request(app).post(`/api/agents/${agentId}/chat-issue`);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.issue.id).toBe(first.body.issue.id);
  });

  it("keeps chat issues out of default lists and counts, but explicit origin filters find them", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const app = createApp(companyId);
    const svc = issueService(db);

    const opened = await request(app).post(`/api/agents/${agentId}/chat-issue`);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const chatIssueId = opened.body.issue.id as string;

    await svc.create(companyId, {
      title: "Real task",
      status: "todo",
      assigneeAgentId: agentId,
    });

    const defaultList = await svc.list(companyId, { limit: 50 });
    expect(defaultList.map((issue) => issue.title)).toEqual(["Real task"]);
    expect(defaultList.some((issue) => issue.id === chatIssueId)).toBe(false);

    const assignedList = await svc.list(companyId, { assigneeAgentId: agentId, limit: 50 });
    expect(assignedList.some((issue) => issue.id === chatIssueId)).toBe(false);

    expect(await svc.count(companyId)).toBe(1);

    const chats = await svc.list(companyId, { originKind: AGENT_CHAT_ORIGIN_KIND, originId: agentId });
    expect(chats.map((issue) => issue.id)).toEqual([chatIssueId]);

    const included = await svc.list(companyId, { includeAgentChats: true, limit: 50 });
    expect(included.some((issue) => issue.id === chatIssueId)).toBe(true);
  });

  it("rejects agent actors", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const app = createApp(companyId, { type: "agent", agentId });

    const res = await request(app).post(`/api/agents/${agentId}/chat-issue`);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const [row] = await db.select().from(issues);
    expect(row).toBeUndefined();
  });
});
