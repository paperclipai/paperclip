import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueRecoveryActions,
  issues,
  principalPermissionGrants,
  projectWorkspaces,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";

function registerRoutineServiceMock() {
  vi.doMock("../services/routines.js", async () => {
    const actual = await vi.importActual<typeof import("../services/routines.js")>("../services/routines.js");

    return {
      ...actual,
      routineService: (db: any) =>
        actual.routineService(db, {
          heartbeat: {
            wakeup: async (agentId: string, wakeupOpts: any) => {
              const issueId =
                (typeof wakeupOpts?.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
                (typeof wakeupOpts?.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
                null;
              if (!issueId) return null;

              const issue = await db
                .select({ companyId: issues.companyId })
                .from(issues)
                .where(eq(issues.id, issueId))
                .then((rows: Array<{ companyId: string }>) => rows[0] ?? null);
              if (!issue) return null;

              const queuedRunId = randomUUID();
              await db.insert(heartbeatRuns).values({
                id: queuedRunId,
                companyId: issue.companyId,
                agentId,
                invocationSource: wakeupOpts?.source ?? "assignment",
                triggerDetail: wakeupOpts?.triggerDetail ?? null,
                status: "queued",
                contextSnapshot: { ...(wakeupOpts?.contextSnapshot ?? {}), issueId },
              });
              await db
                .update(issues)
                .set({
                  executionRunId: queuedRunId,
                  executionLockedAt: new Date(),
                })
                .where(eq(issues.id, issueId));
              return { id: queuedRunId };
            },
          },
        }),
    };
  });
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine routes end-to-end", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-e2e-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/companies.js");
    vi.doUnmock("../services/projects.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/assets.js");
    vi.doUnmock("../services/agent-instructions.js");
    vi.doUnmock("../services/workspace-runtime.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../routes/routines.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRoutineServiceMock();
    vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
    vi.clearAllMocks();
  });

  async function createApp(actor: Record<string, unknown>) {
    const [{ routineRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/routines.js"),
      import("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", routineRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function postRoutineRun(
    app: express.Express,
    routineId: string,
    body: Record<string, unknown>,
  ) {
    let response = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send(body);
    if (response.status === 500) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      response = await request(app)
        .post(`/api/routines/${routineId}/run`)
        .send(body);
    }
    return response;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
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
      name: "Routine Project",
      status: "in_progress",
    });

    const access = accessService(db);
    const membership = await access.ensureMembership(companyId, "user", userId, "owner", "active");
    await access.setMemberPermissions(
      companyId,
      membership.id,
      [{ permissionKey: "tasks:assign" }],
      userId,
    );

    return { companyId, agentId, projectId, userId };
  }

  it("supports creating, scheduling, and manually running a routine through the API", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily standup prep",
        description: "Summarize blockers and open PRs",
        assigneeAgentId: agentId,
        priority: "high",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      });

    expect([200, 201]).toContain(createRes.status);
    expect(createRes.body.title).toBe("Daily standup prep");
    expect(createRes.body.assigneeAgentId).toBe(agentId);

    const routineId = createRes.body.id as string;

    const triggerRes = await request(app)
      .post(`/api/routines/${routineId}/triggers`)
      .send({
        kind: "schedule",
        label: "Weekday morning",
        cronExpression: "0 10 * * 1-5",
        timezone: "UTC",
      });

    expect([200, 201], JSON.stringify(triggerRes.body)).toContain(triggerRes.status);
    const createdTrigger = triggerRes.body.trigger ?? triggerRes.body;
    expect(createdTrigger.kind).toBe("schedule");
    expect(createdTrigger.enabled).toBe(true);
    expect(triggerRes.body.secretMaterial).toBeNull();

    const runRes = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "e2e-test" },
    });

    expect(runRes.status).toBe(202);
    expect(runRes.body.status).toBe("issue_created");
    expect(runRes.body.source).toBe("manual");
    expect(runRes.body.linkedIssueId).toBeTruthy();

    const listRes = await request(app).get(`/api/companies/${companyId}/routines`);
    expect(listRes.status).toBe(200);
    const listed = listRes.body.find((r: { id: string }) => r.id === routineId);
    expect(listed).toBeDefined();
    expect(listed.triggers).toHaveLength(1);
    expect(listed.triggers[0].cronExpression).toBe("0 10 * * 1-5");
    expect(listed.triggers[0].timezone).toBe("UTC");

    const detailRes = await request(app).get(`/api/routines/${routineId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.triggers).toHaveLength(1);
    expect(detailRes.body.triggers[0]?.id).toBe(createdTrigger.id);
    expect(detailRes.body.recentRuns).toHaveLength(1);
    expect(detailRes.body.recentRuns[0]?.id).toBe(runRes.body.id);
    expect(detailRes.body.activeIssue?.id).toBe(runRes.body.linkedIssueId);

    const runsRes = await request(app).get(`/api/routines/${routineId}/runs?limit=10`);
    expect(runsRes.status).toBe(200);
    const [persistedRun] = await db
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(eq(routineRuns.id, runRes.body.id));
    expect(persistedRun?.id).toBe(runRes.body.id);

    const [issue] = await db
      .select({
        id: issues.id,
        originId: issues.originId,
        originKind: issues.originKind,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toMatchObject({
      id: runRes.body.linkedIssueId,
      originId: routineId,
      originKind: "routine_execution",
    });
    expect(issue?.executionRunId).toBeTruthy();

    const actions = await db
      .select({
        action: activityLog.action,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    expect(actions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "routine.created",
        "routine.trigger_created",
        "routine.run_triggered",
      ]),
    );
  }, 15_000);

  it("runs routines with variable inputs and interpolates the execution issue description", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Repository triage",
        description: "Review {{repo}} for {{priority}} bugs",
        assigneeAgentId: agentId,
        variables: [
          { name: "repo", type: "text", required: true },
          { name: "priority", type: "select", required: true, defaultValue: "high", options: ["high", "low"] },
        ],
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);

    const runRes = await postRoutineRun(app, createRes.body.id, {
      source: "manual",
      variables: { repo: "paperclip" },
    });

    expect(runRes.status).toBe(202);
    expect(runRes.body.triggerPayload).toEqual({
      variables: {
        repo: "paperclip",
        priority: "high",
      },
    });

    const [issue] = await db
      .select({ description: issues.description })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue?.description).toBe("Review paperclip for high bugs");
  });

  it("allows drafting a routine without defaults and running it with one-off overrides", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        title: "Draft routine",
        description: "No saved defaults",
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);
    expect(createRes.body.projectId ?? null).toBeNull();
    expect(createRes.body.assigneeAgentId ?? null).toBeNull();
    expect(createRes.body.status).toBe("paused");

    const runRes = await postRoutineRun(app, createRes.body.id, {
      source: "manual",
      projectId,
      assigneeAgentId: agentId,
    });

    expect(runRes.status).toBe(202);
    expect(runRes.body.status).toBe("issue_created");

    const [issue] = await db
      .select({
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toEqual({
      projectId,
      assigneeAgentId: agentId,
    });
  });

  it("persists execution workspace selections from manual routine runs", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
    });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(instanceSettings).values({
      experimental: { enableIsolatedWorkspaces: true },
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Workspace-aware routine",
        assigneeAgentId: agentId,
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);

    const runRes = await postRoutineRun(app, createRes.body.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    expect(runRes.status).toBe(202);

    const [issue] = await db
      .select({
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toEqual({
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  it("lets a terminated-owner recovery run self-accept only listed routines with the exact recovery context", async () => {
    const { companyId, agentId: recoveryOwnerId, projectId, userId } = await seedFixture();
    const terminatedAgentId = randomUUID();
    await db.insert(agents).values({
      id: terminatedAgentId,
      companyId,
      name: "Terminated Automation Owner",
      role: "engineer",
      status: "idle",
      reportsTo: recoveryOwnerId,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const boardApp = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });
    const createRoutine = async (title: string) => {
      const response = await request(boardApp)
        .post(`/api/companies/${companyId}/routines`)
        .send({
          projectId,
          title,
          assigneeAgentId: terminatedAgentId,
          status: "paused",
        });
      expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
      return response.body as { id: string };
    };
    const allowedRoutine = await createRoutine("Allowed recovery routine");
    const unlistedRoutine = await createRoutine("Unlisted recovery routine");
    const wrongContextRoutine = await createRoutine("Wrong-context recovery routine");
    const recoveryOwnerRevision = await request(boardApp)
      .patch(`/api/routines/${allowedRoutine.id}`)
      .send({ assigneeAgentId: recoveryOwnerId })
      .expect(200);
    await request(boardApp)
      .patch(`/api/routines/${allowedRoutine.id}`)
      .send({ assigneeAgentId: terminatedAgentId })
      .expect(200);
    const typedTriggerResponse = await request(boardApp)
      .post(`/api/routines/${allowedRoutine.id}/triggers`)
      .send({
        kind: "schedule",
        label: "Typed recovery schedule",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        enabled: false,
      })
      .expect(201);
    const typedTriggerId = typedTriggerResponse.body.trigger.id as string;
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, terminatedAgentId));

    const recoveryIssueId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Disposition terminated owner's routines",
      status: "blocked",
      priority: "high",
      assigneeAgentId: recoveryOwnerId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
      originKind: "harness_liveness_escalation",
      originId: `agent_termination_routine_handoff:${terminatedAgentId}`,
      originFingerprint: `agent_termination_routine_handoff:${terminatedAgentId}:test`,
      executionContract: {
        schemaVersion: 1,
        contractType: "routine_termination_handoff",
        routineRecovery: {
          terminatedAgentId,
          routines: [{ id: allowedRoutine.id }, { id: wrongContextRoutine.id }],
          triggers: [{ id: typedTriggerId }],
        },
      },
    });
    const recoveryAction = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId: recoveryIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: recoveryOwnerId,
      previousOwnerAgentId: terminatedAgentId,
      cause: "terminated_routine_owner",
      fingerprint: `terminated-routine-owner:${terminatedAgentId}`,
      nextAction: "Explicitly accept or archive every paused routine.",
      wakePolicy: { type: "wake_owner" },
    });
    const validRunId = randomUUID();
    const wrongContextRunId = randomUUID();
    const baseContext = {
      issueId: recoveryIssueId,
      sourceIssueId: recoveryIssueId,
      source: "issue_recovery_action",
      wakeReason: "source_scoped_recovery_action",
      recoveryCause: "terminated_routine_owner",
      recoveryActionId: recoveryAction.id,
      recoveryAttempt: recoveryAction.attemptCount,
      routineRecoveryIssueId: recoveryIssueId,
      terminatedAgentId,
      routineIds: [allowedRoutine.id, wrongContextRoutine.id],
    };
    await db.insert(heartbeatRuns).values([
      {
        id: validRunId,
        companyId,
        agentId: recoveryOwnerId,
        invocationSource: "assignment",
        status: "running",
        startedAt: new Date(),
        contextSnapshot: baseContext,
      },
      {
        id: wrongContextRunId,
        companyId,
        agentId: recoveryOwnerId,
        invocationSource: "assignment",
        status: "running",
        startedAt: new Date(),
        contextSnapshot: {
          ...baseContext,
          terminatedAgentId: randomUUID(),
        },
      },
    ]);
    const validRecoveryApp = await createApp({
      type: "agent",
      agentId: recoveryOwnerId,
      companyId,
      runId: validRunId,
      source: "agent_jwt",
    });
    const wrongContextApp = await createApp({
      type: "agent",
      agentId: recoveryOwnerId,
      companyId,
      runId: wrongContextRunId,
      source: "agent_jwt",
    });

    await request(validRecoveryApp)
      .patch(`/api/routines/${unlistedRoutine.id}`)
      .send({ description: "Must not be accepted" })
      .expect(403);
    await request(wrongContextApp)
      .patch(`/api/routines/${wrongContextRoutine.id}`)
      .send({ description: "Must not be accepted" })
      .expect(403);
    const deleteTypedTrigger = await request(validRecoveryApp)
      .delete(`/api/routine-triggers/${typedTriggerId}`);
    expect(deleteTypedTrigger.status).toBe(409);
    expect(deleteTypedTrigger.body.error).toContain("Typed recovery triggers cannot be deleted");
    const restoreWithoutTypedTrigger = await request(validRecoveryApp)
      .post(`/api/routines/${allowedRoutine.id}/revisions/${recoveryOwnerRevision.body.latestRevisionId}/restore`);
    expect(restoreWithoutTypedTrigger.status).toBe(409);
    expect(restoreWithoutTypedTrigger.body.error).toContain("removes typed trigger inventory");
    await expect(db.select().from(routineTriggers).where(eq(routineTriggers.id, typedTriggerId)))
      .resolves.toHaveLength(1);

    const accepted = await request(validRecoveryApp)
      .patch(`/api/routines/${allowedRoutine.id}`)
      .send({
        assigneeAgentId: recoveryOwnerId,
        description: "Accepted by the bounded routine recovery lane.",
      })
      .expect(200);

    expect(accepted.body).toMatchObject({
      id: allowedRoutine.id,
      assigneeAgentId: recoveryOwnerId,
      description: "Accepted by the bounded routine recovery lane.",
      status: "paused",
    });

    const ordinaryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: ordinaryRunId,
      companyId,
      agentId: recoveryOwnerId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {
        source: "manual",
        wakeReason: "manual",
      },
    });
    const ordinaryOwnerApp = await createApp({
      type: "agent",
      agentId: recoveryOwnerId,
      companyId,
      runId: ordinaryRunId,
      source: "agent_jwt",
    });
    const ordinaryDelete = await request(ordinaryOwnerApp)
      .delete(`/api/routine-triggers/${typedTriggerId}`);
    expect(ordinaryDelete.status).toBe(409);
    expect(ordinaryDelete.body.error).toContain("Typed recovery triggers cannot be deleted");
    const ordinaryRestore = await request(ordinaryOwnerApp)
      .post(`/api/routines/${allowedRoutine.id}/revisions/${recoveryOwnerRevision.body.latestRevisionId}/restore`);
    expect(ordinaryRestore.status).toBe(409);
    expect(ordinaryRestore.body.error).toContain("removes typed trigger inventory");
    await expect(db.select().from(routineTriggers).where(eq(routineTriggers.id, typedTriggerId)))
      .resolves.toHaveLength(1);

    const persisted = await db
      .select({
        id: routines.id,
        assigneeAgentId: routines.assigneeAgentId,
        description: routines.description,
      })
      .from(routines);
    expect(persisted).toEqual(expect.arrayContaining([
      {
        id: allowedRoutine.id,
        assigneeAgentId: recoveryOwnerId,
        description: "Accepted by the bounded routine recovery lane.",
      },
      expect.objectContaining({
        id: unlistedRoutine.id,
        assigneeAgentId: terminatedAgentId,
      }),
      expect.objectContaining({
        id: wrongContextRoutine.id,
        assigneeAgentId: terminatedAgentId,
      }),
    ]));
  });
});
