import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, projectAccessMembers, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import type { AuthorizationActor } from "../services/authorization.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("task bridge issue creation in a project with a configured workspace", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = randomUUID();
  const bridgeAgentId = randomUUID();
  const workerAgentId = randomUUID();
  const openProjectId = randomUUID();
  const otherProjectId = randomUUID();
  const privateProjectId = randomUUID();
  const memberProjectId = randomUUID();
  const keyId = randomUUID();
  const workspacePolicy = {
    enabled: true,
    defaultMode: "isolated_workspace",
    workspaceStrategy: { type: "git_worktree" },
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-task-bridge-workspace-");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: "PAP", defaultResponsibleUserId: "board-user", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: bridgeAgentId, companyId, name: "Bridge", role: "engineer", adapterType: "codex_local", status: "active" },
      { id: workerAgentId, companyId, name: "Worker", role: "engineer", adapterType: "codex_local", status: "active" },
    ]);
    await db.insert(projects).values([
      { id: openProjectId, companyId, name: "Open", visibility: "open", executionWorkspacePolicy: workspacePolicy },
      { id: otherProjectId, companyId, name: "Other", visibility: "open", executionWorkspacePolicy: workspacePolicy },
      { id: privateProjectId, companyId, name: "Private", visibility: "private", executionWorkspacePolicy: workspacePolicy },
      { id: memberProjectId, companyId, name: "Private member", visibility: "private", executionWorkspacePolicy: workspacePolicy },
    ]);
    await db.insert(projectWorkspaces).values([openProjectId, otherProjectId, privateProjectId, memberProjectId].map((projectId) => ({
      companyId, projectId, name: "Repository", sourceType: "git_repo", cwd: `/tmp/${projectId}`,
      repoUrl: "https://example.com/repo.git", isPrimary: true,
    })));
    await db.insert(projectAccessMembers).values({
      companyId, projectId: memberProjectId, subjectType: "agent", subjectId: bridgeAgentId,
    });
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });

  function bridgeActor(projectId: string): Express.Request["actor"] {
    return {
      type: "agent", agentId: bridgeAgentId, companyId, source: "agent_key", keyId,
      keyScope: { kind: "task_bridge", projectId, allowedAssigneeAgentIds: [workerAgentId] },
    } as Express.Request["actor"];
  }
  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { req.actor = actor; next(); });
    instance.use("/api", issueRoutes(db, {} as never));
    instance.use(errorHandler);
    return instance;
  }

  it("creates an unassigned issue in the scoped project", async () => {
    const res = await request(app(bridgeActor(openProjectId)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Bridge task", projectId: openProjectId, status: "backlog" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.projectId).toBe(openProjectId);
    expect(res.body.projectWorkspaceId).toBeTruthy();
    expect(res.body.originKind).toBe("task_bridge");
  });

  it("creates an assigned issue with an isolated workspace in the scoped project", async () => {
    const res = await request(app(bridgeActor(openProjectId)))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Bridge task for the worker", projectId: openProjectId, assigneeAgentId: workerAgentId,
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.assigneeAgentId).toBe(workerAgentId);
    expect(res.body.projectWorkspaceId).toBeTruthy();
    expect(res.body.originKind).toBe("task_bridge");
  });

  it("refuses a project outside the key's scope", async () => {
    const res = await request(app(bridgeActor(openProjectId)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Out of scope", projectId: otherProjectId, status: "backlog" });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it("keeps project privacy for a scoped private project", async () => {
    const denied = await request(app(bridgeActor(privateProjectId)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Private without membership", projectId: privateProjectId, status: "backlog" });
    expect(denied.status, JSON.stringify(denied.body)).toBe(404);

    const allowed = await request(app(bridgeActor(memberProjectId)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Private with membership", projectId: memberProjectId, status: "backlog" });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect(allowed.body.originKind).toBe("task_bridge");
  });

  it("keeps the key scope and project privacy on the workspace source check in the issue service", async () => {
    const create = (actorProjectId: string, projectId: string) => issueService(db).create(companyId, {
      title: "Direct create", projectId, status: "backlog", createdByAgentId: bridgeAgentId,
      workspaceSelectionActor: bridgeActor(actorProjectId) as AuthorizationActor,
    });
    await expect(create(openProjectId, otherProjectId)).rejects.toMatchObject({
      status: 403, message: "Task bridge keys cannot use company-wide, peer-agent, project, runtime, or secret APIs.",
    });
    await expect(create(privateProjectId, privateProjectId)).rejects.toMatchObject({
      status: 404, message: "Workspace source is unavailable or inaccessible",
    });
    await expect(create(memberProjectId, memberProjectId)).resolves.toMatchObject({ projectId: memberProjectId });
  });
});
