import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueAccessGrants,
  issueComments,
  issueRecoveryActions,
  issues,
  projectAccessMembers,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Spy on the wake boundaries only. Project selection, privacy, assignment and
// execution-stage transitions run for real.
const wakeups = vi.hoisted(() => ({ queueIssueAssignmentWakeup: vi.fn() }));
vi.mock("../services/issue-assignment-wakeup.js", () => wakeups);
const heartbeatWakeup = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) =>
    Object.assign(actual.heartbeatService(...args), { wakeup: heartbeatWakeup }) };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

const PROJECT_NAME = "Confidential launch plan";

function boardActor(companyId: string, userId: string): Express.Request["actor"] {
  return { type: "board", userId, companyIds: [companyId], source: "session", isInstanceAdmin: false };
}

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const { issueRoutes } = await import("../routes/issues.js");
  const { errorHandler } = await import("../middleware/error-handler.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("private project assignment admission", { concurrent: false }, () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-private-project-assignment-");
    db = createDb(tempDb.connectionString);
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    await import("../routes/issues.js");
  }, 120_000);

  afterEach(async () => {
    wakeups.queueIssueAssignmentWakeup.mockClear();
    heartbeatWakeup.mockClear();
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issueAccessGrants);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectAccessMembers);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousPrivacyMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacyMode;
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const ownerId = `owner-${randomUUID()}`;
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Example company",
      issuePrefix: `A${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({ id: ownerId, name: "Example Owner", email: `${ownerId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" });
    const agentRow = (name: string) => ({ companyId, name, role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const [memberAgent, outsiderAgent] = await db.insert(agents)
      .values([agentRow("Member agent"), agentRow("Outsider agent")]).returning();
    const [privateProject, filelessPrivateProject, openProject] = await db.insert(projects).values([
      { companyId, name: PROJECT_NAME, visibility: "private", status: "planned" },
      { companyId, name: "Private notes", visibility: "private", status: "planned" },
      { companyId, name: "Open project", visibility: "open", status: "planned" },
    ]).returning();
    await db.insert(projectWorkspaces).values([
      { companyId, projectId: privateProject!.id, name: "repo", cwd: "/srv/example/private-repo", isPrimary: true },
      { companyId, projectId: openProject!.id, name: "repo", cwd: "/srv/example/open-repo", isPrimary: true },
    ]);
    await db.insert(projectAccessMembers).values([
      { companyId, projectId: privateProject!.id, subjectType: "user", subjectId: ownerId },
      { companyId, projectId: privateProject!.id, subjectType: "agent", subjectId: memberAgent!.id },
      { companyId, projectId: filelessPrivateProject!.id, subjectType: "user", subjectId: ownerId },
    ]);
    const app = await createApp(db, boardActor(companyId, ownerId));
    return { companyId, ownerId, memberAgent: memberAgent!, outsiderAgent: outsiderAgent!,
      privateProject: privateProject!, filelessPrivateProject: filelessPrivateProject!, openProject: openProject!, app };
  }

  type Fixture = Awaited<ReturnType<typeof seedFixture>>;

  function expectAssignmentRejected(response: request.Response, fixture: Fixture) {
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details).toMatchObject({
      code: "agent_not_assignable",
      reason: "assignee_lacks_project_access",
      assigneeAgentId: fixture.outsiderAgent.id,
    });
    expect(response.body.error).toContain("project access member");
    // The answer must not disclose the private project to a caller that cannot read it.
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(PROJECT_NAME);
    expect(body).not.toContain(fixture.privateProject.id);
  }

  async function expectNoRunSideEffects(fixture: Fixture) {
    expect(wakeups.queueIssueAssignmentWakeup).not.toHaveBeenCalled();
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests)).toEqual([]);
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
    expect(await db.select().from(issueRecoveryActions)).toEqual([]);
    const [outsider] = await db.select().from(agents).where(eq(agents.id, fixture.outsiderAgent.id));
    expect(outsider?.status).toBe("idle");
  }

  async function seedIssue(fixture: Fixture, values: Partial<typeof issues.$inferInsert>) {
    const id = randomUUID();
    const isPrivateProject = values.projectId === fixture.privateProject.id;
    return db.insert(issues).values({
      id,
      companyId: fixture.companyId,
      identifier: `${randomUUID().slice(0, 4)}-1`,
      title: "Existing task",
      status: "todo",
      priority: "medium",
      createdByUserId: fixture.ownerId,
      responsibleUserId: fixture.ownerId,
      ...(isPrivateProject ? { visibility: "private", privacyRootIssueId: id } : {}),
      ...values,
    }).returning().then((rows) => rows[0]!);
  }

  it("rejects creating a task in a private project for an agent that is not an access member", async () => {
    const fixture = await seedFixture();
    const response = await request(fixture.app).post(`/api/companies/${fixture.companyId}/issues`).send({
      title: "Ship the plan", status: "todo", projectId: fixture.privateProject.id, assigneeAgentId: fixture.outsiderAgent.id,
    });
    expectAssignmentRejected(response, fixture);
    expect(await db.select().from(issues)).toEqual([]);
    await expectNoRunSideEffects(fixture);
  }, 30_000);

  it("rejects a child task that inherits the private project from its parent", async () => {
    const fixture = await seedFixture();
    const parent = await seedIssue(fixture, { projectId: fixture.privateProject.id, assigneeAgentId: fixture.memberAgent.id });
    const response = await request(fixture.app).post(`/api/companies/${fixture.companyId}/issues`).send({
      title: "Child step", status: "todo", parentId: parent.id, assigneeAgentId: fixture.outsiderAgent.id,
    });
    expectAssignmentRejected(response, fixture);
    expect((await db.select().from(issues)).map((row) => row.id)).toEqual([parent.id]);
    await expectNoRunSideEffects(fixture);
  }, 30_000);

  it("rejects reassigning a private-project task to a non-member agent and leaves the task unchanged", async () => {
    const fixture = await seedFixture();
    const task = await seedIssue(fixture, { projectId: fixture.privateProject.id, assigneeAgentId: fixture.memberAgent.id });
    const response = await request(fixture.app).patch(`/api/issues/${task.id}`).send({ assigneeAgentId: fixture.outsiderAgent.id });
    expectAssignmentRejected(response, fixture);
    const [after] = await db.select().from(issues);
    expect(after).toMatchObject({ assigneeAgentId: fixture.memberAgent.id, projectId: fixture.privateProject.id,
      status: "todo", statusVersion: task.statusVersion });
    expect(await db.select().from(issueAccessGrants)).toEqual([]);
    await expectNoRunSideEffects(fixture);
  }, 30_000);

  it("rejects moving an assigned task into a private project its assignee cannot access", async () => {
    const fixture = await seedFixture();
    const task = await seedIssue(fixture, { projectId: fixture.openProject.id, assigneeAgentId: fixture.outsiderAgent.id });
    const response = await request(fixture.app).patch(`/api/issues/${task.id}`).send({ projectId: fixture.privateProject.id });
    expectAssignmentRejected(response, fixture);
    const [after] = await db.select().from(issues);
    expect(after).toMatchObject({ assigneeAgentId: fixture.outsiderAgent.id, projectId: fixture.openProject.id, visibility: "open" });
    await expectNoRunSideEffects(fixture);
  }, 30_000);

  it("still assigns access members, open projects, and private projects that supply no workspace files", async () => {
    const fixture = await seedFixture();
    const member = await request(fixture.app).post(`/api/companies/${fixture.companyId}/issues`).send({
      title: "Member work", status: "todo", projectId: fixture.privateProject.id, assigneeAgentId: fixture.memberAgent.id,
    });
    expect(member.status, JSON.stringify(member.body)).toBe(201);
    const open = await request(fixture.app).post(`/api/companies/${fixture.companyId}/issues`).send({
      title: "Open work", status: "todo", projectId: fixture.openProject.id, assigneeAgentId: fixture.outsiderAgent.id,
    });
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    // Run setup only checks project access when the project supplies workspace files.
    const fileless = await request(fixture.app).post(`/api/companies/${fixture.companyId}/issues`).send({
      title: "Notes work", status: "todo", projectId: fixture.filelessPrivateProject.id, assigneeAgentId: fixture.outsiderAgent.id,
    });
    expect(fileless.status, JSON.stringify(fileless.body)).toBe(201);
    // A private task with no project is parked in the responsible person's file-less personal project.
    const personal = await request(fixture.app).post(`/api/companies/${fixture.companyId}/issues`).send({
      title: "Personal work", status: "todo", visibility: "private", assigneeAgentId: fixture.outsiderAgent.id,
    });
    expect(personal.status, JSON.stringify(personal.body)).toBe(201);
    expect(personal.body.projectId).toBeTruthy();
    expect(wakeups.queueIssueAssignmentWakeup).toHaveBeenCalledTimes(4);

    const reassigned = await request(fixture.app).patch(`/api/issues/${open.body.id}`).send({ assigneeAgentId: fixture.memberAgent.id });
    expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);
    const moved = await request(fixture.app).patch(`/api/issues/${reassigned.body.id}`).send({ projectId: fixture.privateProject.id });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.projectId).toBe(fixture.privateProject.id);
  }, 30_000);

  it("admits external-provider agents whose runs never open the project's workspace files", async () => {
    const fixture = await seedFixture();
    const assignAs = async (provider: string) => {
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider } })
        .where(eq(agents.id, fixture.outsiderAgent.id));
      return request(fixture.app).post(`/api/companies/${fixture.companyId}/issues`).send({
        title: `Work via ${provider}`, status: "todo", projectId: fixture.privateProject.id, assigneeAgentId: fixture.outsiderAgent.id,
      });
    };
    // Run setup skips project workspace access for these placements, so admission does too.
    const { heartbeatRunIsControllerOnly } = await import("../services/heartbeat/external-provider.js");
    for (const provider of ["muse", "openai_dot", "grok_bot"]) {
      expect(heartbeatRunIsControllerOnly({ run: { runtimeMode: null, runnerProfileJson: null },
        agent: { adapterType: "paperclip_runner", adapterConfig: { provider } } })).toBe(true);
      const response = await assignAs(provider);
      expect(response.status, `${provider}: ${JSON.stringify(response.body)}`).toBe(201);
      expect(response.body.assigneeAgentId).toBe(fixture.outsiderAgent.id);
    }
    expect(wakeups.queueIssueAssignmentWakeup).toHaveBeenCalledTimes(3);

    // A runner provider that works in the task's files is still refused.
    wakeups.queueIssueAssignmentWakeup.mockClear();
    const before = (await db.select().from(issues)).length;
    expectAssignmentRejected(await assignAs("codex"), fixture);
    expect(await db.select().from(issues)).toHaveLength(before);
    expect(wakeups.queueIssueAssignmentWakeup).not.toHaveBeenCalled();
  }, 30_000);

  it("rejects reassignment when a bound execution workspace belongs to a private project", async () => {
    const fixture = await seedFixture();
    // The task project supplies no files itself, but its retained workspace does.
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId: fixture.companyId, projectId: fixture.filelessPrivateProject.id, name: "Retained task workspace",
      mode: "shared_workspace", strategyType: "project_primary", cwd: "/srv/example/retained-workspace",
    }).returning();
    await db.insert(projectAccessMembers).values({ companyId: fixture.companyId,
      projectId: fixture.filelessPrivateProject.id, subjectType: "agent", subjectId: fixture.memberAgent.id });
    const task = await seedIssue(fixture, { projectId: fixture.filelessPrivateProject.id, assigneeAgentId: fixture.memberAgent.id,
      visibility: "private", executionWorkspaceId: workspace!.id,
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "existing", workspaceId: workspace!.id } } });
    const response = await request(fixture.app).patch(`/api/issues/${task.id}`).send({ assigneeAgentId: fixture.outsiderAgent.id });
    expectAssignmentRejected(response, fixture);
    expect(JSON.stringify(response.body)).not.toContain(fixture.filelessPrivateProject.id);
    const [after] = await db.select().from(issues);
    expect(after).toMatchObject({ assigneeAgentId: fixture.memberAgent.id, executionWorkspaceId: workspace!.id,
      statusVersion: task.statusVersion });
    await expectNoRunSideEffects(fixture);

    // Run setup refuses the same outsider for this binding once it holds the
    // task, as it would have on the base, and admits the member.
    const { assertTaskWorkspaceExecutionAccess } = await import("../services/task-workspace-access.js");
    const runtimeCheck = (agentId: string) => assertTaskWorkspaceExecutionAccess(db,
      { type: "agent", agentId, companyId: fixture.companyId }, fixture.companyId, { issueId: task.id, workspaceId: workspace!.id });
    await expect(runtimeCheck(fixture.memberAgent.id)).resolves.toBeTruthy();
    await db.update(issues).set({ assigneeAgentId: fixture.outsiderAgent.id }).where(eq(issues.id, task.id));
    await expect(runtimeCheck(fixture.outsiderAgent.id)).rejects.toThrow("Project is private and the actor is not an access member.");
    await db.update(issues).set({ assigneeAgentId: fixture.memberAgent.id }).where(eq(issues.id, task.id));

    // An access member of the bound project can still take the task.
    const unassigned = await request(fixture.app).patch(`/api/issues/${task.id}`).send({ assigneeAgentId: null });
    expect(unassigned.status, JSON.stringify(unassigned.body)).toBe(200);
    const member = await request(fixture.app).patch(`/api/issues/${task.id}`).send({ assigneeAgentId: fixture.memberAgent.id });
    expect(member.status, JSON.stringify(member.body)).toBe(200);
    expect(member.body.assigneeAgentId).toBe(fixture.memberAgent.id);
  }, 30_000);

  describe("execution policy transitions", () => {
    const agentPrincipal = (agentId: string) => ({ type: "agent" as const, agentId, userId: null });
    const userPrincipal = (userId: string) => ({ type: "user" as const, agentId: null, userId });
    const stage = (type: "review" | "approval", principal: ReturnType<typeof agentPrincipal> | ReturnType<typeof userPrincipal>) => ({
      id: randomUUID(), type, approvalsNeeded: 1 as const, participants: [{ id: randomUUID(), ...principal }],
    });
    const policy = (...stages: ReturnType<typeof stage>[]) => ({ mode: "normal" as const, commentRequired: true, stages });
    const pendingState = (current: ReturnType<typeof stage>, index: number, returnAgentId: string) => ({
      status: "pending" as const, currentStageId: current.id, currentStageIndex: index, currentStageType: current.type,
      currentParticipant: { type: current.participants[0]!.type, agentId: current.participants[0]!.agentId,
        userId: current.participants[0]!.userId },
      returnAssignee: agentPrincipal(returnAgentId), reviewRequest: null, completedStageIds: [],
      lastDecisionId: null, lastDecisionOutcome: null,
    });

    async function expectTransitionRolledBack(response: request.Response, fixture: Fixture, before: typeof issues.$inferSelect) {
      expectAssignmentRejected(response, fixture);
      const [after] = await db.select().from(issues);
      expect(after).toMatchObject({ status: before.status, assigneeAgentId: before.assigneeAgentId,
        assigneeUserId: before.assigneeUserId, statusVersion: before.statusVersion });
      expect(after?.executionState).toEqual(before.executionState);
      expect(await db.select().from(issueComments)).toEqual([]);
      await expectNoRunSideEffects(fixture);
    }

    it("refuses handing the executor's work to a review participant without project access", async () => {
      const fixture = await seedFixture();
      const executionPolicy = policy(stage("review", agentPrincipal(fixture.outsiderAgent.id)));
      const task = await seedIssue(fixture, { projectId: fixture.privateProject.id, status: "in_progress",
        assigneeAgentId: fixture.memberAgent.id, executionPolicy });
      const response = await request(fixture.app).patch(`/api/issues/${task.id}`).send({ status: "in_review" });
      await expectTransitionRolledBack(response, fixture, task);
    }, 30_000);

    it("hands the executor's work to a review participant who is an access member", async () => {
      const fixture = await seedFixture();
      const executor = (await db.insert(agents).values({ companyId: fixture.companyId, name: "Executor agent", role: "engineer",
        status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning())[0]!;
      await db.insert(projectAccessMembers).values({ companyId: fixture.companyId, projectId: fixture.privateProject.id,
        subjectType: "agent", subjectId: executor.id });
      const executionPolicy = policy(stage("review", agentPrincipal(fixture.memberAgent.id)));
      const task = await seedIssue(fixture, { projectId: fixture.privateProject.id, status: "in_progress",
        assigneeAgentId: executor.id, executionPolicy });
      const response = await request(fixture.app).patch(`/api/issues/${task.id}`).send({ status: "in_review" });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ status: "in_review", assigneeAgentId: fixture.memberAgent.id });
      await vi.waitFor(() => expect(heartbeatWakeup).toHaveBeenCalledWith(fixture.memberAgent.id, expect.anything()));
    }, 30_000);

    it("refuses returning requested changes to an executor without project access", async () => {
      const fixture = await seedFixture();
      const review = stage("review", userPrincipal(fixture.ownerId));
      const task = await seedIssue(fixture, { projectId: fixture.privateProject.id, status: "in_review",
        assigneeUserId: fixture.ownerId, executionPolicy: policy(review),
        executionState: pendingState(review, 0, fixture.outsiderAgent.id) });
      const response = await request(fixture.app).patch(`/api/issues/${task.id}`)
        .send({ status: "in_progress", comment: "Please add the missing test." });
      await expectTransitionRolledBack(response, fixture, task);

      // The same decision returns the work when the executor is an access member.
      await db.update(issues).set({ executionState: pendingState(review, 0, fixture.memberAgent.id) }).where(eq(issues.id, task.id));
      const member = await request(fixture.app).patch(`/api/issues/${task.id}`)
        .send({ status: "in_progress", comment: "Please add the missing test." });
      expect(member.status, JSON.stringify(member.body)).toBe(200);
      expect(member.body).toMatchObject({ status: "in_progress", assigneeAgentId: fixture.memberAgent.id });
    }, 30_000);

    it("refuses advancing to a next-stage participant without project access", async () => {
      const fixture = await seedFixture();
      const review = stage("review", userPrincipal(fixture.ownerId));
      const blockedApproval = stage("approval", agentPrincipal(fixture.outsiderAgent.id));
      const task = await seedIssue(fixture, { projectId: fixture.privateProject.id, status: "in_review",
        assigneeUserId: fixture.ownerId, executionPolicy: policy(review, blockedApproval),
        executionState: pendingState(review, 0, fixture.memberAgent.id) });
      const response = await request(fixture.app).patch(`/api/issues/${task.id}`).send({ status: "done", comment: "Looks right." });
      await expectTransitionRolledBack(response, fixture, task);

      // The same approval advances when the next participant is an access member.
      const memberApproval = stage("approval", agentPrincipal(fixture.memberAgent.id));
      const executor = (await db.insert(agents).values({ companyId: fixture.companyId, name: "Executor agent", role: "engineer",
        status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning())[0]!;
      await db.update(issues).set({ executionPolicy: policy(review, memberApproval),
        executionState: pendingState(review, 0, executor.id) }).where(eq(issues.id, task.id));
      const member = await request(fixture.app).patch(`/api/issues/${task.id}`).send({ status: "done", comment: "Looks right." });
      expect(member.status, JSON.stringify(member.body)).toBe(200);
      expect(member.body).toMatchObject({ status: "in_review", assigneeAgentId: fixture.memberAgent.id });
    }, 30_000);
  });

  it("uses the same project access decision as run setup", async () => {
    const fixture = await seedFixture();
    const { assertTaskWorkspaceSourceProjectAccess } = await import("../services/task-workspace-access.js");
    const runActor = (agentId: string) => ({ type: "agent" as const, agentId, companyId: fixture.companyId,
      source: "agent_jwt" as const, runId: randomUUID(), onBehalfOfUserId: fixture.ownerId });
    await expect(assertTaskWorkspaceSourceProjectAccess(db, runActor(fixture.outsiderAgent.id), fixture.companyId,
      fixture.privateProject.id)).rejects.toThrow("Project is private and the actor is not an access member.");
    await expect(assertTaskWorkspaceSourceProjectAccess(db, runActor(fixture.memberAgent.id), fixture.companyId,
      fixture.privateProject.id)).resolves.toBeUndefined();
  }, 30_000);
});
