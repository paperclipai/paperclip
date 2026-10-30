import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, activityLog, authUsers, companies, companyMemberships, createDb,
  executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { registerAgentProjectAccessRoutes } from "../routes/agent-project-access.js";
import { errorHandler } from "../middleware/error-handler.js";
import { assertTaskWorkspaceExecutionAccess, assertTaskWorkspaceSourceProjectAccess } from "../services/task-workspace-access.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { ProjectAccessDeniedError } from "../services/project-access-denial.js";
import { issueService } from "../services/issues.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("additive project access", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
    if (external) db = createDb(external);
    else { database = await startEmbeddedPostgresTestDatabase("agent-project-access-"); db = createDb(database.connectionString); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Project access", issuePrefix: `A${companyId.slice(0, 6)}` });
    const selected = await db.insert(projects).values(["Existing", "Needed", "Third"].map(name => ({ companyId, name }))).returning();
    const permissions = { canCreateAgents: false, canCreateSkills: false, trustPreset: "low_trust_review",
      authorizationPolicy: { reviewPreset: { id: "low_trust_review", version: 1, rawOutputDisposition: "quarantine" },
        customPolicy: { preserve: true }, trustBoundary: { mode: "low_trust_review", companyId,
          projectIds: [selected[0]!.id], issueIds: [issueId], allowedToolClasses: ["git.read"], allowedSecretBindingIds: [] } } };
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", adapterType: "process", status: "idle", permissions });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Saved message", status: "blocked", assigneeAgentId: agentId, projectId: selected[1]!.id }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "failed", errorCode: "setup_failed",
      error: "Project is outside this low-trust boundary.", contextSnapshot: { issueId } });
    return { companyId, agentId, issue: issue!, runId, selected, permissions };
  }
  function app(actor: express.Request["actor"]) {
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = actor; next(); });
    registerAgentProjectAccessRoutes(app, db); app.use(errorHandler); return app;
  }
  const board = { type: "board" as const, source: "local_implicit" as const };

  it("keeps a historical denial blocked after the task moves to an allowed project but retains its source", async () => {
    const f = await seed();
    const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: f.selected[1]!.id,
      name: "Original repository", cwd: "/tmp/project-access-original" }).returning();
    await db.update(issues).set({ projectWorkspaceId: source!.id,
      workspaceSelection: { version: 1, source: "project", selection: {
        kind: "configured_source", projectWorkspaceId: source!.id, mode: "managed_isolated",
      } } }).where(eq(issues.id, f.issue.id));
    const moved = await issueService(db).update(f.issue.id, { projectId: f.selected[0]!.id });
    expect(moved).toMatchObject({ projectId: f.selected[0]!.id, projectWorkspaceId: source!.id });
    const actor = { type: "agent" as const, source: "agent_key" as const, agentId: f.agentId, companyId: f.companyId };
    await expect(assertTaskWorkspaceExecutionAccess(db, actor, f.companyId, { issueId: f.issue.id }))
      .rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect(await taskInterruptionPresentation(db, moved!)).toMatchObject({
      canRetry: false, userAction: "project_access", projectAccess: { ready: false, projectId: null },
    });
    expect((await request(app(board)).post(`/agents/${f.agentId}/project-access`)
      .send({ projectIds: [f.selected[1]!.id] })).status).toBe(200);
    expect(await taskInterruptionPresentation(db, moved!)).toMatchObject({ canRetry: true, projectAccess: { ready: true } });
    await expect(assertTaskWorkspaceExecutionAccess(db, actor, f.companyId, { issueId: f.issue.id })).resolves.toBeDefined();
  });

  it.each(["applied", "pending"] as const)("rechecks the selected source after an %s repair instead of the old denied project", async repair => {
    const f = await seed();
    const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: f.selected[0]!.id,
      name: "Allowed repository", cwd: "/tmp/project-access-allowed" }).returning();
    await db.update(heartbeatRuns).set({ errorCode: "project_access_denied", error: null,
      resultJson: { projectAccessDenied: { projectId: f.selected[1]!.id } } }).where(eq(heartbeatRuns.id, f.runId));
    const moved = await issueService(db).update(f.issue.id, { projectId: f.selected[0]!.id });
    if (repair === "applied") {
      await issueService(db).update(f.issue.id, { projectWorkspaceId: source!.id, workspaceSelectionActor: board });
    } else {
      await executionWorkspaceService(db).selectTaskWorkspace({ companyId: f.companyId, issueId: f.issue.id, actor: board,
        selection: { kind: "configured_source", projectWorkspaceId: source!.id, mode: "managed_isolated" },
        expectedBindingRevision: 0, requestKey: randomUUID() });
    }
    expect(await taskInterruptionPresentation(db, moved!)).toMatchObject({ canRetry: true, projectAccess: { ready: true } });
    // The original denied source was not granted, and presentation creates no execution.
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]!.permissions).toEqual(f.permissions);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    if (repair === "pending") {
      await db.update(issues).set({ workspaceBindingRevision: 2 }).where(eq(issues.id, f.issue.id));
      const stale = await taskInterruptionPresentation(db, moved!);
      expect(stale).toMatchObject({ state: "failed", canRetry: false, userAction: null });
      expect(stale).not.toHaveProperty("projectAccess");
    }
  });

  it("keeps a pending existing selection blocked if its workspace is archived before retry", async () => {
    const f = await seed();
    const task = await issueService(db).update(f.issue.id, { projectId: f.selected[0]!.id });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId,
      projectId: f.selected[0]!.id, name: "Selected files", cwd: "/tmp/project-access-selected",
      mode: "isolated_workspace", strategyType: "git_worktree" }).returning();
    const service = executionWorkspaceService(db);
    await service.selectTaskWorkspace({ companyId: f.companyId, issueId: f.issue.id, actor: board,
      selection: { kind: "existing", workspaceId: workspace!.id }, expectedBindingRevision: 0, requestKey: randomUUID() });
    expect(await taskInterruptionPresentation(db, task!)).toMatchObject({ canRetry: true, projectAccess: { ready: true } });
    expect(await service.archiveWorkspaceUnderLifecycleLock({ id: workspace!.id, patch: {}, closedAt: new Date() }))
      .toMatchObject({ outcome: "archived" });
    await expect(service.applyPendingTaskWorkspaceSelection({ companyId: f.companyId, issueId: f.issue.id,
      runId: f.runId, actor: { type: "agent", source: "agent_key", agentId: f.agentId, companyId: f.companyId } }))
      .rejects.toThrow("Workspace is unavailable or inaccessible");
    const archived = await taskInterruptionPresentation(db, task!);
    expect(archived).toMatchObject({ state: "failed", canRetry: false, userAction: null });
    expect(archived).not.toHaveProperty("projectAccess");
  });

  it.each(["denied_project", "foreign_company"] as const)("retains the %s gate on a bound workspace even when its source is allowed", async boundary => {
    const f = await seed(), foreign = boundary === "foreign_company" ? await seed() : null;
    const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: f.selected[0]!.id,
      name: "Allowed source", cwd: "/tmp/project-access-source" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: foreign?.companyId ?? f.companyId,
      projectId: foreign?.selected[0]!.id ?? f.selected[1]!.id, projectWorkspaceId: foreign ? null : source!.id,
      name: "Retained files", cwd: "/tmp/project-access-bound", mode: "isolated_workspace", strategyType: "git_worktree" }).returning();
    const [task] = await db.update(issues).set({ projectId: f.selected[0]!.id, projectWorkspaceId: source!.id,
      executionWorkspaceId: workspace!.id }).where(eq(issues.id, f.issue.id)).returning();
    const blocked = await taskInterruptionPresentation(db, task!);
    if (boundary === "denied_project") {
      expect(blocked).toMatchObject({ canRetry: false,
        userAction: "project_access", projectAccess: { ready: false, projectId: null } });
    } else {
      expect(blocked).toMatchObject({ state: "failed", canRetry: false, userAction: null });
      expect(blocked).not.toHaveProperty("projectAccess");
    }
  });

  it("preserves containment, audits concurrent additions, and changes the persisted denial into an explicit retry", async () => {
    const f = await seed();
    const actor = { type: "agent" as const, source: "agent_key" as const, agentId: f.agentId, companyId: f.companyId };
    await expect(assertTaskWorkspaceSourceProjectAccess(db, actor, f.companyId, f.selected[1]!.id)).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect(await taskInterruptionPresentation(db, f.issue)).toMatchObject({ userAction: "project_access", canRetry: false });
    const api = app(board);
    const results = await Promise.all(f.selected.slice(1).map(project => request(api).post(`/agents/${f.agentId}/project-access`).send({ projectIds: [project.id] })));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    const [saved] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(saved!.permissions).toEqual({ ...f.permissions, authorizationPolicy: { ...f.permissions.authorizationPolicy,
      trustBoundary: { ...f.permissions.authorizationPolicy.trustBoundary, projectIds: expect.arrayContaining(f.selected.map(project => project.id)) } } });
    expect((saved!.permissions as typeof f.permissions).authorizationPolicy.trustBoundary.projectIds).toHaveLength(3);
    await expect(assertTaskWorkspaceSourceProjectAccess(db, actor, f.companyId, f.selected[1]!.id)).resolves.toBeUndefined();
    expect(await taskInterruptionPresentation(db, f.issue)).toMatchObject({ canRetry: true, projectAccess: { ready: true } });
    const again = await request(api).post(`/agents/${f.agentId}/project-access`).send({ projectIds: [f.selected[1]!.id] });
    expect(again.status).toBe(200);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "agent.project_access_added")))).toHaveLength(2);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  });

  it("rejects foreign projects, agent self-grants, unknown policy fields, and pending-approval agents", async () => {
    const f = await seed(), other = await seed(), api = app(board);
    expect((await request(api).post(`/agents/${f.agentId}/project-access`).send({ projectIds: [other.selected[1]!.id] })).status).toBe(404);
    expect((await request(api).post(`/agents/${f.agentId}/project-access`).send({ projectIds: [f.selected[1]!.id], trustPreset: "standard" })).status).toBe(400);
    expect((await request(app({ type: "agent", agentId: f.agentId, companyId: f.companyId, source: "agent_key" }))
      .post(`/agents/${f.agentId}/project-access`).send({ projectIds: [f.selected[1]!.id] })).status).toBe(403);
    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, f.agentId));
    expect((await request(api).post(`/agents/${f.agentId}/project-access`).send({ projectIds: [f.selected[1]!.id] })).status).toBe(409);
    const [saved] = await db.select().from(agents).where(eq(agents.id, f.agentId)); expect(saved!.permissions).toEqual(f.permissions);
  });

  it.each(["standard", "root_issue"])("rechecks actual project authority after a %s repair and acknowledges an accepted retry", async repair => {
    const f = await seed();
    const permissions = repair === "standard" ? { canCreateAgents: false, trustPreset: "standard", authorizationPolicy: {} }
      : { ...f.permissions, authorizationPolicy: { ...f.permissions.authorizationPolicy,
        trustBoundary: { ...f.permissions.authorizationPolicy.trustBoundary, rootIssueId: f.issue.id } } };
    await db.update(agents).set({ permissions }).where(eq(agents.id, f.agentId));
    expect(await taskInterruptionPresentation(db, f.issue)).toMatchObject({ canRetry: true, projectAccess: { ready: true } });
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "on_demand", status: "deferred_issue_execution", requestedByActorType: "user", payload: { issueId: f.issue.id } });
    const accepted = await taskInterruptionPresentation(db, f.issue);
    expect(accepted).toMatchObject({ state: "working", canRetry: false });
    expect(accepted).not.toHaveProperty("projectAccess");
    // Current project policy remains authoritative even after agent access changes.
    await db.update(projects).set({ executionWorkspacePolicy: { trustPreset: "low_trust_review", authorizationPolicy: {
      trustBoundary: { mode: "low_trust_review", companyId: f.companyId, projectIds: [f.selected[0]!.id] },
    } } }).where(eq(projects.id, f.selected[1]!.id));
    if (repair === "standard") expect(await taskInterruptionPresentation(db, f.issue))
      .toMatchObject({ canRetry: false, userAction: "project_access" });
  });

  it("shows read-only access to viewers and denies their saves and cross-company reads", async () => {
    const f = await seed(), other = await seed(), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Viewer", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, membershipRole: "viewer", status: "active" });
    const api = app({ type: "board", source: "session", userId, companyIds: [f.companyId], memberships: [{ companyId: f.companyId, membershipRole: "viewer", status: "active" }] });
    expect((await request(api).get(`/agents/${f.agentId}/project-access`)).body).toMatchObject({ canManage: false });
    expect((await request(api).post(`/agents/${f.agentId}/project-access`).send({ projectIds: [f.selected[1]!.id] })).status).toBe(403);
    expect((await request(api).get(`/agents/${other.agentId}/project-access`)).status).toBe(404);
  });
});
