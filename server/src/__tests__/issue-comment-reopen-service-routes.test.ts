import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  issueComments,
  issueRelations,
  issues,
  principalPermissionGrants,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    heartbeatService: () => mockHeartbeatService,
  };
});

const { issueRoutes } = await import("../routes/issues.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue comment reopen route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres.sequential("issue comment reopen routes with issueService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-comment-reopen-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(workspaceOperations);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
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

  async function seedScenario(blockerStatus: "done" | "in_progress") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const blockerIssueId = randomUUID();
    const dependentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
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
      name: "Assigned Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Rule B" });
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        projectId,
        title: "Blocker",
        identifier: "RLB-1",
        issueNumber: 1,
        status: blockerStatus,
        assigneeAgentId: agentId,
      },
      {
        id: dependentIssueId,
        companyId,
        projectId,
        title: "Dependent",
        identifier: "RLB-2",
        issueNumber: 2,
        status: "blocked",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
      createdByUserId: "cloud-user-1",
    });

    if (blockerStatus === "done") {
      const executionWorkspaceId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: blockerIssueId,
        mode: "isolated",
        strategyType: "git_worktree",
        name: "rule-b-blocker",
      });
      await db.update(issues).set({ executionWorkspaceId }).where(eq(issues.id, blockerIssueId));
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "adapter_execute",
        status: "succeeded",
        finishedAt: new Date(),
      });
    }

    return { agentId, companyId, dependentIssueId };
  }

  it("reopens a blocked issue when every blocker edge is done but finalize is pending", async () => {
    const { agentId, companyId, dependentIssueId } = await seedScenario("done");

    const response = await request(createApp(companyId))
      .post(`/api/issues/${dependentIssueId}/comments`)
      .send({ body: "Please continue." });

    expect(response.status).toBe(201);
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, dependentIssueId)))
      .resolves.toEqual([{ status: "todo" }]);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({ issueId: dependentIssueId, reopenedFrom: "blocked" }),
      }),
    ));
  });

  it("does not reopen a blocked issue for an agent comment", async () => {
    const { agentId, companyId, dependentIssueId } = await seedScenario("done");

    const response = await request(createApp(companyId, {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: null,
    }))
      .post(`/api/issues/${dependentIssueId}/comments`)
      .send({ body: "Agent progress update." });

    expect(response.status).toBe(201);
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, dependentIssueId)))
      .resolves.toEqual([{ status: "blocked" }]);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ reason: "issue_reopened_via_comment" }),
    );
  });

  it("keeps a blocked issue blocked when a blocker edge is unresolved", async () => {
    const { agentId, companyId, dependentIssueId } = await seedScenario("in_progress");

    const response = await request(createApp(companyId))
      .post(`/api/issues/${dependentIssueId}/comments`)
      .send({ body: "Can this continue?" });

    expect(response.status).toBe(201);
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, dependentIssueId)))
      .resolves.toEqual([{ status: "blocked" }]);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ reason: "issue_commented" }),
    ));
  });
});
