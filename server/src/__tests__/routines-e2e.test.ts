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
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
  principalPermissionGrants,
  projectWorkspaces,
  projects,
  routineDocuments,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";

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
    await db.delete(documentAnnotationAnchorSnapshots);
    await db.delete(documentAnnotationComments);
    await db.delete(documentAnnotationThreads);
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
    await db.delete(routineDocuments);
    await db.delete(routines);
    await db.delete(documentRevisions);
    await db.delete(documents);
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
        activityGatePolicy: "require_external_activity",
        activityGateScope: "project",
      });

    expect([200, 201]).toContain(createRes.status);
    expect(createRes.body.title).toBe("Daily standup prep");
    expect(createRes.body.assigneeAgentId).toBe(agentId);
    expect(createRes.body.activityGatePolicy).toBe("require_external_activity");
    expect(createRes.body.activityGateScope).toBe("project");

    const routineId = createRes.body.id as string;

    const updateRes = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        activityGatePolicy: "always",
        activityGateScope: "company",
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.activityGatePolicy).toBe("always");
    expect(updateRes.body.activityGateScope).toBe("company");

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
    expect(listed.activityGatePolicy).toBe("always");
    expect(listed.activityGateScope).toBe("company");
    expect(listed.triggers).toHaveLength(1);
    expect(listed.triggers[0].cronExpression).toBe("0 10 * * 1-5");
    expect(listed.triggers[0].timezone).toBe("UTC");

    const detailRes = await request(app).get(`/api/routines/${routineId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.activityGatePolicy).toBe("always");
    expect(detailRes.body.activityGateScope).toBe("company");
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

  it("defaults activity gates and rejects invalid activity gate values", async () => {
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
        title: "Default activity gate",
        assigneeAgentId: agentId,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.activityGatePolicy).toBe("always");
    expect(createRes.body.activityGateScope).toBe("company");

    const invalidCreateRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Invalid activity gate",
        assigneeAgentId: agentId,
        activityGatePolicy: "when_busy",
      });

    expect(invalidCreateRes.status).toBe(400);

    const invalidPatchRes = await request(app)
      .patch(`/api/routines/${createRes.body.id}`)
      .send({ activityGateScope: "agent" });

    expect(invalidPatchRes.status).toBe(400);
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

  // NET-6057 — regression coverage for the cascade that fired every cron tick
  // while a stranded `blocked` execution was invisible to `skip_if_active`.
  // The blocked issue keeps `hidden_at IS NULL` (still in OPEN_ISSUE_STATUSES)
  // and the heartbeat run is no longer live (acpx_turn_failed path clears
  // `execution_run_id` and terminates the run).
  it("treats a stranded blocked execution as active for skip_if_active (NET-6057)", async () => {
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
        title: "Auto-restore A-record",
        description: "Restore research-gateway.netquirk.com A-record if missing",
        assigneeAgentId: agentId,
        concurrencyPolicy: "skip_if_active",
        catchUpPolicy: "skip_missed",
      });
    expect([200, 201]).toContain(createRes.status);
    const routineId = createRes.body.id as string;

    const firstRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(firstRun.status).toBe(202);
    expect(firstRun.body.status).toBe("issue_created");
    const linkedIssueId = firstRun.body.linkedIssueId as string;
    expect(linkedIssueId).toBeTruthy();

    // Simulate acpx_turn_failed: terminate the heartbeat run, transition the
    // issue to `blocked`, and clear `execution_run_id` exactly as the harness
    // does on the failing path.
    const [boundHeartbeat] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .innerJoin(issues, eq(issues.executionRunId, heartbeatRuns.id));
    expect(boundHeartbeat?.id).toBeTruthy();
    await db
      .update(heartbeatRuns)
      .set({ status: "failed" })
      .where(eq(heartbeatRuns.id, boundHeartbeat!.id));
    await db
      .update(issues)
      .set({ status: "blocked", executionRunId: null })
      .where(eq(issues.id, linkedIssueId));

    const secondRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(secondRun.status).toBe(202);
    expect(secondRun.body.status).toBe("skipped");
    expect(secondRun.body.linkedIssueId).toBe(linkedIssueId);
    expect(secondRun.body.coalescedIntoRunId).toBeTruthy();
    expect(secondRun.body.coalescedIntoRunId).not.toBe(secondRun.body.id);

    // Only the original blocked issue should remain; no duplicate root created.
    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routineId));
    expect(routineIssues.map((row) => row.id)).toEqual([linkedIssueId]);
  });

  it("treats a stranded blocked execution as active for coalesce_if_active (NET-6057)", async () => {
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
        title: "Coalesce auto-restore A-record",
        description: "Restore research-gateway.netquirk.com A-record if missing",
        assigneeAgentId: agentId,
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      });
    expect([200, 201]).toContain(createRes.status);
    const routineId = createRes.body.id as string;

    const firstRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(firstRun.status).toBe(202);
    expect(firstRun.body.status).toBe("issue_created");
    const linkedIssueId = firstRun.body.linkedIssueId as string;

    const [boundHeartbeat] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .innerJoin(issues, eq(issues.executionRunId, heartbeatRuns.id));
    await db
      .update(heartbeatRuns)
      .set({ status: "failed" })
      .where(eq(heartbeatRuns.id, boundHeartbeat!.id));
    await db
      .update(issues)
      .set({ status: "blocked", executionRunId: null })
      .where(eq(issues.id, linkedIssueId));

    const secondRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(secondRun.status).toBe(202);
    expect(secondRun.body.status).toBe("coalesced");
    expect(secondRun.body.linkedIssueId).toBe(linkedIssueId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routineId));
    expect(routineIssues.map((row) => row.id)).toEqual([linkedIssueId]);
  });

  it("creates a fresh issue once a prior execution reaches done (NET-6057)", async () => {
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
        title: "Auto-restore A-record (regression)",
        description: "Restore research-gateway.netquirk.com A-record if missing",
        assigneeAgentId: agentId,
        concurrencyPolicy: "skip_if_active",
        catchUpPolicy: "skip_missed",
      });
    expect([200, 201]).toContain(createRes.status);
    const routineId = createRes.body.id as string;

    const firstRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(firstRun.status).toBe(202);
    const firstIssueId = firstRun.body.linkedIssueId as string;

    // Closure path: previous execution succeeded → status=done, no live run,
    // and executionRunId already cleared.
    const [boundHeartbeat] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .innerJoin(issues, eq(issues.executionRunId, heartbeatRuns.id));
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, boundHeartbeat!.id));
    await db
      .update(issues)
      .set({ status: "done", executionRunId: null })
      .where(eq(issues.id, firstIssueId));

    const secondRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(secondRun.status).toBe(202);
    expect(secondRun.body.status).toBe("issue_created");
    expect(secondRun.body.linkedIssueId).not.toBe(firstIssueId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routineId));
    expect(routineIssues.map((row) => row.id).sort()).toEqual(
      [firstIssueId, secondRun.body.linkedIssueId].sort(),
    );
  });

  it("keeps skip_if_active skipping while a live heartbeat is bound (NET-6057)", async () => {
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
        title: "Skip while live",
        description: "Restore research-gateway.netquirk.com A-record if missing",
        assigneeAgentId: agentId,
        concurrencyPolicy: "skip_if_active",
        catchUpPolicy: "skip_missed",
      });
    expect([200, 201]).toContain(createRes.status);
    const routineId = createRes.body.id as string;

    const firstRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(firstRun.body.status).toBe("issue_created");
    const linkedIssueId = firstRun.body.linkedIssueId as string;

    // The mock heartbeat leaves the run in `queued` (live). Issue still in
    // todo/in_progress — the original skip path must continue to fire.
    await db
      .update(issues)
      .set({ status: "in_progress" })
      .where(eq(issues.id, linkedIssueId));

    const secondRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(secondRun.body.status).toBe("skipped");
    expect(secondRun.body.linkedIssueId).toBe(linkedIssueId);
  });

  it("does not suppress new issues for always_enqueue (NET-6057)", async () => {
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
        title: "Always enqueue A-record",
        description: "Restore research-gateway.netquirk.com A-record if missing",
        assigneeAgentId: agentId,
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "skip_missed",
      });
    expect([200, 201]).toContain(createRes.status);
    const routineId = createRes.body.id as string;

    const firstRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(firstRun.body.status).toBe("issue_created");
    const firstIssueId = firstRun.body.linkedIssueId as string;

    const [boundHeartbeat] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .innerJoin(issues, eq(issues.executionRunId, heartbeatRuns.id));
    await db
      .update(heartbeatRuns)
      .set({ status: "failed" })
      .where(eq(heartbeatRuns.id, boundHeartbeat!.id));
    await db
      .update(issues)
      .set({ status: "blocked", executionRunId: null })
      .where(eq(issues.id, firstIssueId));

    const secondRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    // always_enqueue creates a fresh issue even when a prior execution is blocked.
    expect(secondRun.body.status).toBe("issue_created");
    expect(secondRun.body.linkedIssueId).not.toBe(firstIssueId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routineId));
    expect(routineIssues.map((row) => row.id).sort()).toEqual(
      [firstIssueId, secondRun.body.linkedIssueId].sort(),
    );
  });

  // NET-6788 / NET-6789: per-fire origin_fingerprint.
  //
  // Regression coverage for the bug where two cron ticks of the same routine
  // hashed to the same fingerprint and the partial unique index
  // `issues_open_routine_execution_uq` wedged the second fire's UPDATE on
  // `execution_run_id`. After the fix:
  //   - Each fire mints a fresh occurrenceId and writes it to
  //     `routine_runs.dispatch_occurrence_id` and the corresponding issue's
  //     `origin_fingerprint`.
  //   - `coalesce_if_active` still coalesces the second fire to the first
  //     because the live heartbeat run bound to Issue #1 is still active.
  //   - The fingerprints on `routine_runs` differ; both fires successfully
  //     bind an `execution_run_id` (no 23505).
  it("two consecutive cron ticks coalesce under coalesce_if_active and use distinct fingerprints (NET-6788)", async () => {
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
        title: "Backlog-router tick (per-fire fingerprint)",
        description: "Same routine revision, two cron ticks in the same OPEN window.",
        assigneeAgentId: agentId,
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      });
    expect([200, 201]).toContain(createRes.status);
    const routineId = createRes.body.id as string;

    const firstRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(firstRun.status).toBe(202);
    expect(firstRun.body.status).toBe("issue_created");
    const firstIssueId = firstRun.body.linkedIssueId as string;
    expect(firstIssueId).toBeTruthy();

    // Mock heartbeat left Issue #1 in OPEN_ISSUE_STATUSES with a queued run —
    // exactly the cron-tick-burst scenario the regression covers.
    const [boundHeartbeat] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .innerJoin(issues, eq(issues.executionRunId, heartbeatRuns.id));
    expect(boundHeartbeat?.id).toBeTruthy();

    const secondRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(secondRun.status).toBe(202);
    // Heartbeat bound to Issue #1 is still live → second tick coalesces.
    expect(secondRun.body.status).toBe("coalesced");
    expect(secondRun.body.linkedIssueId).toBe(firstIssueId);
    expect(secondRun.body.coalescedIntoRunId).toBeTruthy();

    // Only the original issue should exist (no duplicate wedged in).
    const routineIssues = await db
      .select({
        id: issues.id,
        fingerprint: issues.originFingerprint,
      })
      .from(issues)
      .where(eq(issues.originKind, "routine_execution"));
    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0].id).toBe(firstIssueId);
    expect(routineIssues[0].fingerprint).not.toBe("default");

    // Both runs recorded distinct fingerprints + distinct occurrenceIds.
    const runRows = await db
      .select({
        id: routineRuns.id,
        fingerprint: routineRuns.dispatchFingerprint,
        occurrenceId: routineRuns.dispatchOccurrenceId,
      })
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routineId))
      .orderBy(routineRuns.createdAt);
    expect(runRows).toHaveLength(2);
    expect(runRows[0].fingerprint).toBeTruthy();
    expect(runRows[1].fingerprint).toBeTruthy();
    expect(runRows[0].fingerprint).not.toBe(runRows[1].fingerprint);
    expect(runRows[0].occurrenceId).toBeTruthy();
    expect(runRows[1].occurrenceId).toBeTruthy();
    expect(runRows[0].occurrenceId).not.toBe(runRows[1].occurrenceId);
  }, 30_000);

  // NET-6788 / NET-6789: skip_if_active with two back-to-back ticks must NOT
  // raise 23505. After the fix, the partial unique index is no longer the
  // de-facto coalesce gate (it can't be, because each fingerprint is now
  // distinct). Coalescing happens via the heartbeat-bound lookup in
  // findLiveExecutionIssue, so two open issues never appear.
  it("two consecutive cron ticks under skip_if_active do not wedge on the unique index (NET-6788)", async () => {
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
        title: "Skip-if-active per-fire fingerprint regression",
        description: "Same routine revision, two cron ticks; second must skip cleanly.",
        assigneeAgentId: agentId,
        concurrencyPolicy: "skip_if_active",
        catchUpPolicy: "skip_missed",
      });
    expect([200, 201]).toContain(createRes.status);
    const routineId = createRes.body.id as string;

    const firstRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(firstRun.body.status).toBe("issue_created");
    const firstIssueId = firstRun.body.linkedIssueId as string;

    const secondRun = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "cron" },
    });
    expect(secondRun.status).toBe(202);
    expect(secondRun.body.status).toBe("skipped");
    expect(secondRun.body.linkedIssueId).toBe(firstIssueId);

    // The critical regression assertion: only one open issue exists, and it
    // carries a non-default, per-fire fingerprint.
    const routineIssues = await db
      .select({
        id: issues.id,
        fingerprint: issues.originFingerprint,
      })
      .from(issues)
      .where(eq(issues.originKind, "routine_execution"));
    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0].id).toBe(firstIssueId);
    expect(routineIssues[0].fingerprint).not.toBe("default");
  }, 15_000);
});
