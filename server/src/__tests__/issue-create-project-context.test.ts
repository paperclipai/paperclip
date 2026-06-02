import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue create project-context tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue create project context inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-project-context-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProjectIssueFixture() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Jersey Empire",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Launch project",
      status: "active",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Launch source task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: sourceIssueId, taskId: sourceIssueId, wakeReason: "issue_assigned" },
    });

    return { agentId, companyId, projectId, projectWorkspaceId, runId, sourceIssueId };
  }

  function createAgentApp(input: { agentId: string; companyId: string; runId: string }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: input.agentId,
        companyId: input.companyId,
        runId: input.runId,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("inherits project and project workspace when create() reuses another issue workspace", async () => {
    const { companyId, projectId, projectWorkspaceId, sourceIssueId } = await seedProjectIssueFixture();

    const created = await issueService(db).create(companyId, {
      title: "Sibling follow-up",
      status: "todo",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
    });

    expect(created.projectId).toBe(projectId);
    expect(created.projectWorkspaceId).toBe(projectWorkspaceId);
  });

  it("inherits project context for agent-created follow-up issues from the current run issue", async () => {
    const { agentId, companyId, projectId, projectWorkspaceId, runId, sourceIssueId } = await seedProjectIssueFixture();

    const res = await request(createAgentApp({ agentId, companyId, runId }))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Prepare merge follow-up",
        description: "Root follow-up created while handling the source task.",
        status: "todo",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      title: "Prepare merge follow-up",
      projectId,
      projectWorkspaceId,
      parentId: null,
      createdByAgentId: agentId,
    });

    const stored = await db
      .select({ projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId, parentId: issues.parentId })
      .from(issues)
      .where(eq(issues.id, res.body.id))
      .then((rows) => rows[0] ?? null);

    expect(stored).toEqual({ projectId, projectWorkspaceId, parentId: null });
    expect(res.body.id).not.toBe(sourceIssueId);
  });
});
