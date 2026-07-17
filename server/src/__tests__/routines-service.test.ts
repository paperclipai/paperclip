import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  folders,
  heartbeatRuns,
  instanceSettings,
  issueInboxArchives,
  issueReadStates,
  issues,
  projectWorkspaces,
  projects,
  routineDocuments,
  routineRuns,
  routines,
  routineTriggers,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import * as providerRegistry from "../secrets/provider-registry.ts";
import { routineService } from "../services/routines.ts";
import { secretService } from "../services/secrets.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const originalSecretsProviderEnv = process.env.PAPERCLIP_SECRETS_PROVIDER;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routines service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine service live-execution coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalSecretsProviderEnv === undefined) {
      delete process.env.PAPERCLIP_SECRETS_PROVIDER;
    } else {
      process.env.PAPERCLIP_SECRETS_PROVIDER = originalSecretsProviderEnv;
    }
    await db.delete(activityLog);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(folders);
    await db.delete(routineDocuments);
    await db.delete(documents);
    await db.delete(documentRevisions);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(opts?: {
    runtimeEnv?: Record<string, string | undefined>;
    wakeup?: (
      agentId: string,
      wakeupOpts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      },
    ) => Promise<unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const defaultResponsibleUserId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const wakeups: Array<{
      agentId: string;
      opts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      };
    }> = [];

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId,
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
      name: "Routines",
      status: "in_progress",
    });

    const svc = routineService(db, {
      runtimeEnv: opts?.runtimeEnv,
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          wakeups.push({ agentId: wakeupAgentId, opts: wakeupOpts });
          if (opts?.wakeup) return opts.wakeup(wakeupAgentId, wakeupOpts);
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const issue = await db
            .select({ responsibleUserId: issues.responsibleUserId })
            .from(issues)
            .where(eq(issues.id, issueId))
            .then((rows) => rows[0] ?? null);
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            responsibleUserId: issue?.responsibleUserId ?? defaultResponsibleUserId,
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
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
    });
    const issueSvc = issueService(db);
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ascii frog",
        description: "Run the frog routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { companyId, agentId, issueSvc, projectId, routine, svc, wakeups };
  }

  async function armWorktreeExecution(cutoff: Date, instanceId = "worktree-routines-test") {
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: {
        enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: cutoff.toISOString(),
        worktreeRunExecutionActivationInstanceId: instanceId,
      },
    });
  }

  async function insertDispatchedRun(input: {
    companyId: string;
    routineId: string;
    triggeredAt: Date;
    source?: "schedule" | "manual" | "api" | "webhook";
  }) {
    return db
      .insert(routineRuns)
      .values({
        companyId: input.companyId,
        routineId: input.routineId,
        source: input.source ?? "schedule",
        status: "completed",
        triggeredAt: input.triggeredAt,
        completedAt: input.triggeredAt,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("filters listed routines by project", async () => {
    const { companyId, agentId, projectId, routine, svc } = await seedFixture();
    const otherProjectId = randomUUID();
    await db.insert(projects).values({
      id: otherProjectId,
      companyId,
      name: "Other routines",
      status: "in_progress",
    });
    const otherRoutine = await svc.create(
      companyId,
      {
        projectId: otherProjectId,
        goalId: null,
        parentIssueId: null,
        title: "other project routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const projectRoutines = await svc.list(companyId, { projectId });
    const allRoutines = await svc.list(companyId);

    expect(projectRoutines.map((entry) => entry.id)).toEqual([routine.id]);
    expect(allRoutines.map((entry) => entry.id)).toEqual(expect.arrayContaining([routine.id, otherRoutine.id]));
  });

  it("does not reveal folders owned by another company", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other company",
      issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    const [otherFolder] = await db.insert(folders).values({
      companyId: otherCompanyId,
      kind: "routine",
      name: "Private folder",
      slug: "private-folder",
      position: 0,
    }).returning();

    await expect(svc.create(companyId, {
      projectId,
      folderId: otherFolder!.id,
      goalId: null,
      parentIssueId: null,
      title: "cross-company folder probe",
      description: null,
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    }, {})).rejects.toMatchObject({ status: 404, message: "Folder not found" });
  });

  it("defaults activity gates to always at company scope", async () => {
    const { routine } = await seedFixture();

    expect(routine.activityGatePolicy).toBe("always");
    expect(routine.activityGateScope).toBe("company");
  });

  it("fires an activity gate for a routine that has never dispatched", async () => {
    const { routine, svc } = await seedFixture();

    await expect(svc.evaluateActivityGate(routine, new Date())).resolves.toEqual({
      fire: true,
      windowStart: null,
      matchedActivity: null,
    });
  });

  it("excludes activity from heartbeat runs executing the routine's own issue", async () => {
    const { agentId, companyId, projectId, routine, svc } = await seedFixture();
    const windowStart = new Date(Date.now() - 60_000);
    const now = new Date();
    await insertDispatchedRun({ companyId, routineId: routine.id, triggeredAt: windowStart });
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Routine execution",
      originKind: "routine_execution",
      originId: routine.id,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "completed",
      contextSnapshot: { issueId },
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(windowStart.getTime() + 1_000),
    });

    await expect(svc.evaluateActivityGate(routine, now)).resolves.toMatchObject({
      fire: false,
      windowStart,
      matchedActivity: null,
    });
  });

  it("fires for another agent running a child of the routine issue", async () => {
    const { agentId, companyId, projectId, routine, svc } = await seedFixture();
    const windowStart = new Date(Date.now() - 60_000);
    const now = new Date();
    await insertDispatchedRun({ companyId, routineId: routine.id, triggeredAt: windowStart });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const routineIssueId = randomUUID();
    const childIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: routineIssueId,
        companyId,
        projectId,
        title: "Routine execution",
        originKind: "routine_execution",
        originId: routine.id,
      },
      {
        id: childIssueId,
        companyId,
        projectId,
        parentId: routineIssueId,
        title: "Delegated child",
      },
    ]);
    const childRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: childRunId,
      companyId,
      agentId: otherAgentId,
      status: "running",
      contextSnapshot: { issueId: childIssueId },
    });
    const [activity] = await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: otherAgentId,
      agentId: otherAgentId,
      runId: childRunId,
      action: "issue.checkout",
      entityType: "issue",
      entityId: childIssueId,
      createdAt: new Date(windowStart.getTime() + 1_000),
    }).returning();

    await expect(svc.evaluateActivityGate(routine, now)).resolves.toMatchObject({
      fire: true,
      windowStart,
      matchedActivity: { id: activity!.id },
    });
    expect(agentId).not.toBe(otherAgentId);
  });

  it("fires for a human comment and ignores pure-read activity", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture();
    const windowStart = new Date(Date.now() - 60_000);
    const now = new Date();
    await insertDispatchedRun({ companyId, routineId: routine.id, triggeredAt: windowStart });
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Board task" });
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.read_marked",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date(windowStart.getTime() + 1_000),
      },
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date(windowStart.getTime() + 2_000),
      },
    ]);

    await expect(svc.evaluateActivityGate(routine, now)).resolves.toMatchObject({
      fire: true,
      matchedActivity: { action: "issue.comment_added" },
    });

    await db.delete(activityLog);
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.read_marked",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date(windowStart.getTime() + 1_000),
      },
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.inbox_archived",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date(windowStart.getTime() + 2_000),
      },
    ]);

    await expect(svc.evaluateActivityGate(routine, now)).resolves.toMatchObject({ fire: false });
  });

  it("limits project-scoped gates to activity in the routine project", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture();
    const otherProjectId = randomUUID();
    await db.insert(projects).values({ id: otherProjectId, companyId, name: "Other", status: "in_progress" });
    const windowStart = new Date(Date.now() - 60_000);
    const now = new Date();
    await insertDispatchedRun({ companyId, routineId: routine.id, triggeredAt: windowStart });
    const [otherIssue, ownIssue] = [randomUUID(), randomUUID()];
    await db.insert(issues).values([
      { id: otherIssue, companyId, projectId: otherProjectId, title: "Other project" },
      { id: ownIssue, companyId, projectId, title: "Routine project" },
    ]);
    const projectRoutine = { ...routine, activityGateScope: "project" };
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: otherIssue,
      createdAt: new Date(windowStart.getTime() + 1_000),
    });

    await expect(svc.evaluateActivityGate(projectRoutine, now)).resolves.toMatchObject({ fire: false });

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: ownIssue,
      createdAt: new Date(windowStart.getTime() + 2_000),
    });
    await expect(svc.evaluateActivityGate(projectRoutine, now)).resolves.toMatchObject({ fire: true });
  });

  it("creates a fresh execution issue when the previous routine issue is open but idle", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue).toBeNull();

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);

    const routineIssues = await db
      .select({
        id: issues.id,
        originRunId: issues.originRunId,
      })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(2);
    expect(routineIssues.map((issue) => issue.id)).toContain(previousIssue.id);
    expect(routineIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("creates draft routines without a project or default assignee", async () => {
    const { companyId, svc } = await seedFixture();

    const routine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft routine",
        description: "No defaults yet",
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    expect(routine.projectId).toBeNull();
    expect(routine.assigneeAgentId).toBeNull();
    expect(routine.status).toBe("paused");
  });

  it("creates revision 1 on routine create and appends revisions for real updates only", async () => {
    const { routine, svc } = await seedFixture();

    const initialRevisions = await svc.listRevisions(routine.id);
    expect(initialRevisions).toHaveLength(1);
    expect(initialRevisions[0]).toMatchObject({
      id: routine.latestRevisionId,
      revisionNumber: 1,
      title: "ascii frog",
      changeSummary: "Created routine",
    });
    expect(initialRevisions[0]?.snapshot.routine.description).toBe("Run the frog routine");

    const updated = await svc.update(
      routine.id,
      {
        description: "Run the frog routine with logs",
        baseRevisionId: routine.latestRevisionId,
      },
      {},
    );
    expect(updated?.latestRevisionNumber).toBe(2);
    expect(updated?.latestRevisionId).not.toBe(routine.latestRevisionId);

    const noOp = await svc.update(
      routine.id,
      {
        description: "Run the frog routine with logs",
        baseRevisionId: updated?.latestRevisionId,
      },
      {},
    );
    expect(noOp?.latestRevisionId).toBe(updated?.latestRevisionId);
    expect(noOp?.latestRevisionNumber).toBe(2);

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([2, 1]);
    expect(revisions[0]?.snapshot.routine.description).toBe("Run the frog routine with logs");
    expect(revisions[1]?.snapshot.routine.description).toBe("Run the frog routine");
  });

  it("stores routine env in revisions, syncs routine secret bindings, and stamps runs with the dispatch revision", async () => {
    const { agentId, companyId, projectId, svc } = await seedFixture();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `routine-api-${randomUUID()}`,
      provider: "local_encrypted",
      value: "secret-value",
    });

    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "secret routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "skip_missed",
        env: {
          ROUTINE_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
          ROUTINE_PLAIN: { type: "plain", value: "plain-value" },
        },
      },
      {},
    );

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, routine.id));
    expect(bindings).toMatchObject([
      {
        companyId,
        secretId: secret.id,
        targetType: "routine",
        configPath: "env.ROUTINE_API_KEY",
      },
    ]);

    const [initialRevision] = await svc.listRevisions(routine.id);
    expect(initialRevision?.snapshot.routine.env).toEqual(routine.env);

    await db.delete(companySecretBindings).where(eq(companySecretBindings.targetId, routine.id));
    const repaired = await svc.update(routine.id, { env: routine.env }, {});
    expect(repaired).not.toBeNull();
    const repairedBindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, routine.id));
    expect(repairedBindings).toMatchObject([
      {
        companyId,
        secretId: secret.id,
        targetType: "routine",
        configPath: "env.ROUTINE_API_KEY",
      },
    ]);

    const currentRoutine = repaired ?? routine;
    const runBefore = await svc.runRoutine(routine.id, { source: "manual" });
    expect(runBefore.routineRevisionId).toBe(currentRoutine.latestRevisionId);

    const updated = await svc.update(
      routine.id,
      {
        env: {
          ROUTINE_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
          ROUTINE_PLAIN: { type: "plain", value: "changed" },
        },
      },
      {},
    );
    expect(updated?.latestRevisionNumber).toBe(currentRoutine.latestRevisionNumber + 1);

    const runAfter = await svc.runRoutine(routine.id, { source: "manual" });
    expect(runAfter.routineRevisionId).toBe(updated?.latestRevisionId);
    expect(runAfter.dispatchFingerprint).not.toBe(runBefore.dispatchFingerprint);
  });

  it("rejects stale routine baseRevisionId updates", async () => {
    const { routine, svc } = await seedFixture();
    const updated = await svc.update(routine.id, { description: "new description" }, {});
    await expect(
      svc.update(routine.id, {
        title: "stale update",
        baseRevisionId: routine.latestRevisionId,
      }, {}),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        currentRevisionId: updated?.latestRevisionId,
      },
    });
  });

  it("restores an older routine revision append-only and preserves run history", async () => {
    const { routine, svc } = await seedFixture();
    const revision1Id = routine.latestRevisionId!;
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const revision2Routine = await svc.update(routine.id, { description: "revision 2" }, {});

    const restored = await svc.restoreRevision(routine.id, revision1Id, {});

    expect(restored.restoredFromRevisionId).toBe(revision1Id);
    expect(restored.restoredFromRevisionNumber).toBe(1);
    expect(restored.routine.latestRevisionNumber).toBe(3);
    expect(restored.routine.latestRevisionId).not.toBe(revision2Routine?.latestRevisionId);
    expect(restored.routine.description).toBe("Run the frog routine");
    expect(restored.revision.restoredFromRevisionId).toBe(revision1Id);
    expect(restored.revision.snapshot.routine.description).toBe("Run the frog routine");

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([3, 2, 1]);
    await expect(db.select().from(routineRuns).where(eq(routineRuns.id, run.id))).resolves.toHaveLength(1);
  });

  it("rejects restoring the current latest routine revision", async () => {
    const { routine, svc } = await seedFixture();

    await expect(
      svc.restoreRevision(routine.id, routine.latestRevisionId!, {}),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        currentRevisionId: routine.latestRevisionId,
      },
    });
  });

  it("recreates deleted webhook trigger secrets when restoring a historical revision", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    await svc.deleteTrigger(created.trigger.id, {});
    await expect(db.select().from(companySecrets).where(eq(companySecrets.id, created.trigger.secretId!))).resolves.toHaveLength(0);
    await expect(db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, created.trigger.secretId!))).resolves.toHaveLength(0);

    const restored = await svc.restoreRevision(routine.id, created.revision.id, {});

    expect(restored.secretMaterials).toHaveLength(1);
    expect(restored.secretMaterials[0]).toMatchObject({
      triggerId: created.trigger.id,
    });
    expect(restored.secretMaterials[0]?.webhookSecret).toBeTruthy();
    expect(restored.secretMaterials[0]?.webhookUrl).toContain("/api/routine-triggers/public/");

    const restoredTrigger = await svc.getTrigger(created.trigger.id);
    expect(restoredTrigger?.secretId).toBeTruthy();
    expect(restoredTrigger?.publicId).toBeTruthy();
    expect(restoredTrigger?.publicId).not.toBe(created.trigger.publicId);
  });

  it("persists custom schedule cron expressions exactly", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const cronExpression = "0 8-18/2 * * 1-5";

    const created = await svc.createTrigger(routine.id, {
      kind: "schedule",
      label: "Business hours",
      cronExpression,
      timezone: "UTC",
    }, {});

    expect(created.trigger.cronExpression).toBe(cronExpression);

    const storedTrigger = await svc.getTrigger(created.trigger.id);
    expect(storedTrigger?.cronExpression).toBe(cronExpression);

    const [listed] = await svc.list(companyId);
    expect(listed?.triggers[0]?.cronExpression).toBe(cronExpression);
  });

  it("blocks agents from restoring routine revisions assigned to another agent", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const revision1Id = routine.latestRevisionId!;

    await svc.update(routine.id, { assigneeAgentId: otherAgentId }, {});

    await expect(
      svc.restoreRevision(routine.id, revision1Id, { agentId: otherAgentId }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Agents can only restore routine revisions assigned to themselves",
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      assigneeAgentId: otherAgentId,
      latestRevisionNumber: 2,
    });
  });

  it("blocks restoring routine revisions assigned to agents that are no longer assignable", async () => {
    const { agentId, routine, svc } = await seedFixture();
    const revision1Id = routine.latestRevisionId!;
    await svc.update(routine.id, { description: "revision 2" }, {});
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, agentId));

    await expect(
      svc.restoreRevision(routine.id, revision1Id, { userId: "board-user" }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign routines to terminated agents",
      details: {
        code: "agent_not_assignable",
        reason: "assignee_terminated",
        assigneeAgentId: agentId,
      },
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      description: "revision 2",
      latestRevisionNumber: 2,
    });
  });

  it("blocks routine reassignment to agents under terminated managers", async () => {
    const { agentId, companyId, routine, svc } = await seedFixture();
    const terminatedManagerId = randomUUID();
    const blockedAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: terminatedManagerId,
        companyId,
        name: "TerminatedManager",
        role: "manager",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAgentId,
        companyId,
        name: "BlockedRoutineCoder",
        role: "engineer",
        status: "active",
        reportsTo: terminatedManagerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await expect(svc.update(routine.id, {
      assigneeAgentId: blockedAgentId,
    }, { userId: "board-user" })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_not_assignable",
        reason: "ancestor_terminated",
        assigneeAgentId: blockedAgentId,
        invalidAncestorAgentId: terminatedManagerId,
      },
    });

    await expect(svc.get(routine.id)).resolves.toMatchObject({
      assigneeAgentId: agentId,
    });
  });

  it("blocks manual routine runs when the persisted assignee is no longer assignable", async () => {
    const { agentId, routine, svc } = await seedFixture();
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, agentId));

    await expect(svc.runRoutine(routine.id, {
      source: "manual",
      payload: null,
      variables: null,
    }, { userId: "board-user" })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_not_assignable",
        reason: "assignee_terminated",
        assigneeAgentId: agentId,
      },
    });
  });

  it("appends safe trigger metadata revisions without leaking webhook secrets", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    expect(created.revision.revisionNumber).toBe(2);
    expect(created.secretMaterial?.webhookSecret).toBeTruthy();

    const updated = await svc.updateTrigger(created.trigger.id, { label: "deploy hook" }, {});
    expect(updated?.revision.revisionNumber).toBe(3);

    const rotated = await svc.rotateTriggerSecret(created.trigger.id, {});
    expect(rotated.revision.revisionNumber).toBe(4);
    expect(rotated.secretMaterial.webhookSecret).toBeTruthy();

    const deleted = await svc.deleteTrigger(created.trigger.id, {});
    expect(deleted.revision?.revisionNumber).toBe(5);
    await expect(db.select().from(companySecrets).where(eq(companySecrets.id, created.trigger.secretId!))).resolves.toHaveLength(0);
    await expect(db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, created.trigger.secretId!))).resolves.toHaveLength(0);

    const revisions = await svc.listRevisions(routine.id);
    const serialized = JSON.stringify(revisions.map((revision) => revision.snapshot));
    expect(serialized).toContain(created.trigger.publicId!);
    expect(serialized).not.toContain(created.secretMaterial!.webhookSecret);
    expect(serialized).not.toContain(rotated.secretMaterial.webhookSecret);
    expect(serialized).not.toContain(created.trigger.secretId!);
    expect(revisions[0]?.snapshot.triggers).toHaveLength(0);
  });

  it("wakes the assignee when a routine creates a fresh execution issue", async () => {
    const { agentId, routine, svc, wakeups } = await seedFixture();

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    expect(wakeups).toEqual([
      {
        agentId,
        opts: {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: run.linkedIssueId, mutation: "create" },
          requestedByActorType: undefined,
          requestedByActorId: null,
          contextSnapshot: { issueId: run.linkedIssueId, source: "routine.dispatch" },
        },
      },
    ]);
  });

  it("records the manual board runner on fresh routine issues so they appear in that user's inbox", async () => {
    const { companyId, agentId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    const [createdIssue] = await db
      .select({
        id: issues.id,
        assigneeAgentId: issues.assigneeAgentId,
        createdByUserId: issues.createdByUserId,
        responsibleUserId: issues.responsibleUserId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));
    expect(createdIssue).toMatchObject({
      id: run.linkedIssueId,
      assigneeAgentId: agentId,
      createdByUserId: userId,
      responsibleUserId: userId,
    });

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("uses the routine revision responsible-user snapshot for automatic runs", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const responsibleUserId = randomUUID();
    const driftUserId = randomUUID();
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "snapshotted owner routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      { userId: responsibleUserId },
    );

    await db
      .update(routines)
      .set({ responsibleUserId: driftUserId, updatedAt: new Date() })
      .where(eq(routines.id, routine.id));

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.responsibleUserId).toBe(responsibleUserId);
    const [createdIssue] = await db
      .select({
        responsibleUserId: issues.responsibleUserId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));
    expect(createdIssue?.responsibleUserId).toBe(responsibleUserId);
  });

  it("waits for the assignee wakeup to be queued before returning the routine run", async () => {
    let wakeupResolved = false;
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        wakeupResolved = true;
        return null;
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(wakeupResolved).toBe(true);
  });

  it("coalesces only when the existing routine issue has a live execution run", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue?.id).toBe(previousIssue.id);

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(previousIssue.id);
  });

  it("touches a coalesced routine issue for the manual runner's inbox", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });
    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });
    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: previousIssue.id,
      userId,
      archivedAt: new Date("2026-03-20T12:02:00.000Z"),
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueReadStates).where(eq(issueReadStates.issueId, previousIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        companyId,
        issueId: previousIssue.id,
        userId,
      }),
    ]);

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(previousIssue.id);
  });

  it("touches a skipped active routine issue for the manual runner's inbox", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();

    await db
      .update(routines)
      .set({ concurrencyPolicy: "skip_if_active" })
      .where(eq(routines.id, routine.id));

    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });
    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });
    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: previousIssue.id,
      userId,
      archivedAt: new Date("2026-03-20T12:02:00.000Z"),
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("skipped");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueReadStates).where(eq(issueReadStates.issueId, previousIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        companyId,
        issueId: previousIssue.id,
        userId,
      }),
    ]);

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(previousIssue.id);
  });

  it("does not coalesce live routine runs with different resolved variables", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "pre-pr for {{branch}}",
        description: "Create a pre-PR from {{branch}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "branch", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    const first = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { branch: "feature/a" },
    });
    const second = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { branch: "feature/b" },
    });

    expect(first.status).toBe("issue_created");
    expect(second.status).toBe("issue_created");
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).not.toBe(second.linkedIssueId);

    const routineIssues = await db
      .select({
        id: issues.id,
        title: issues.title,
        originFingerprint: issues.originFingerprint,
      })
      .from(issues)
      .where(eq(issues.originId, variableRoutine.id));

    expect(routineIssues).toHaveLength(2);
    expect(routineIssues.map((issue) => issue.title).sort()).toEqual([
      "pre-pr for feature/a",
      "pre-pr for feature/b",
    ]);
    expect(new Set(routineIssues.map((issue) => issue.originFingerprint)).size).toBe(2);
  });

  it("interpolates routine variables into the execution issue and stores resolved values", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "repo triage for {{repo}}",
        description: "Review {{repo}} for {{priority}} bugs",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
          { name: "priority", label: null, type: "select", defaultValue: "high", required: true, options: ["high", "low"] },
        ],
      },
      {},
    );
    expect(variableRoutine.variables.map((variable) => variable.name)).toEqual(["repo", "priority"]);

    const run = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { repo: "paperclip" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toBe("repo triage for paperclip");
    expect(storedIssue?.description).toBe("Review paperclip for high bugs");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        repo: "paperclip",
        priority: "high",
      },
    });
  });

  it("infers capital-Date variables, preserves builtin date, and validates submitted date values", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const dateRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "date check {{startDate}} on {{date}}",
        description: "Range {{startDate}} to {{endDate}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    expect(dateRoutine.variables).toEqual([
      { name: "startDate", label: null, type: "date", defaultValue: null, required: true, options: [] },
      { name: "endDate", label: null, type: "date", defaultValue: null, required: true, options: [] },
    ]);

    await expect(
      svc.runRoutine(dateRoutine.id, {
        source: "manual",
        variables: { startDate: "2024-02-30", endDate: "2024-03-01" },
      }),
    ).rejects.toThrow(/valid YYYY-MM-DD date/i);

    const run = await svc.runRoutine(dateRoutine.id, {
      source: "manual",
      variables: { startDate: "2024-02-29", endDate: "2024-03-01" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toMatch(/^date check 2024-02-29 on \d{4}-\d{2}-\d{2}$/);
    expect(storedIssue?.description).toBe("Range 2024-02-29 to 2024-03-01");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        startDate: "2024-02-29",
        endDate: "2024-03-01",
      },
    });
  });

  it("attaches the selected execution workspace to manually triggered routine issues", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
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

    const run = await svc.runRoutine(routine.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const storedIssue = await db
      .select({
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue).toEqual({
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  it("auto-populates workspaceBranch from a reused isolated workspace", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
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
      branchName: "pap-1634-routine-branch",
    });

    const branchRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Review {{workspaceBranch}}",
        description: "Use branch {{workspaceBranch}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "workspaceBranch", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    const run = await svc.runRoutine(branchRoutine.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toBe("Review pap-1634-routine-branch");
    expect(storedIssue?.description).toBe("Use branch pap-1634-routine-branch");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        workspaceBranch: "pap-1634-routine-branch",
      },
    });
  });

  it("runs draft routines with one-off agent and project overrides", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const draftRoutine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft dispatch",
        description: "Pick defaults at run time",
        assigneeAgentId: null,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const run = await svc.runRoutine(draftRoutine.id, {
      source: "manual",
      projectId,
      assigneeAgentId: agentId,
    });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    const storedIssue = await db
      .select({
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue).toEqual({
      projectId,
      assigneeAgentId: agentId,
    });
  });

  it("rejects enabling automation for routines without a default agent", async () => {
    const { companyId, svc } = await seedFixture();
    const draftRoutine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft routine",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    await expect(
      svc.update(draftRoutine.id, { status: "active" }, {}),
    ).rejects.toThrow(/default agent required/i);
  });

  it("blocks schedule triggers when required variables do not have defaults", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "repo triage",
        description: "Review {{repo}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    await expect(
      svc.createTrigger(variableRoutine.id, {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }, {}),
    ).rejects.toThrow(/require defaults for required variables/i);
  });

  it("treats malformed stored defaults as missing when validating schedule triggers", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ship check",
        description: "Review {{approved}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "approved", label: null, type: "boolean", defaultValue: true, required: true, options: [] },
        ],
      },
      {},
    );

    await db
      .update(routines)
      .set({
        variables: [
          {
            name: "approved",
            label: null,
            type: "boolean",
            defaultValue: "definitely",
            required: true,
            options: [],
          },
        ],
      })
      .where(eq(routines.id, variableRoutine.id));

    await expect(
      svc.createTrigger(variableRoutine.id, {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }, {}),
    ).rejects.toThrow(/require defaults for required variables/i);
  });

  it("rejects invalid date defaults before persisting routine variables", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();

    await expect(
      svc.create(
        companyId,
        {
          projectId,
          goalId: null,
          parentIssueId: null,
          title: "date check {{startDate}}",
          description: null,
          assigneeAgentId: agentId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          variables: [
            { name: "startDate", label: null, type: "date", defaultValue: "2024-02-30", required: true, options: [] },
          ],
        },
        {},
      ),
    ).rejects.toThrow(/valid YYYY-MM-DD date/i);
  });

  it("serializes concurrent dispatches until the first execution issue is linked to a queued run", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async (wakeupAgentId, wakeupOpts) => {
        const issueId =
          (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
          (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
          null;
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (!issueId) return null;
        const queuedRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: queuedRunId,
          companyId: routine.companyId,
          agentId: wakeupAgentId,
          invocationSource: wakeupOpts.source ?? "assignment",
          triggerDetail: wakeupOpts.triggerDetail ?? null,
          status: "queued",
          contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
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
    });

    const [first, second] = await Promise.all([
      svc.runRoutine(routine.id, { source: "manual" }),
      svc.runRoutine(routine.id, { source: "manual" }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["coalesced", "issue_created"]);
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).toBe(second.linkedIssueId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
  });

  it("fails the run and cleans up the execution issue when wakeup queueing fails", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        throw new Error("queue unavailable");
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("failed");
    expect(run.failureReason).toContain("queue unavailable");
    expect(run.linkedIssueId).toBeNull();

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(0);
  });

  it("accepts standard second-precision webhook timestamps for HMAC triggers", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "hmac_sha256",
        replayWindowSec: 300,
      },
      {},
    );

    expect(trigger.publicId).toBeTruthy();
    expect(secretMaterial?.webhookSecret).toBeTruthy();

    const payload = { ok: true };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestampSeconds = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(`${timestampSeconds}.`)
      .update(rawBody)
      .digest("hex")}`;

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      signatureHeader: signature,
      timestampHeader: timestampSeconds,
      rawBody,
      payload,
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
  });

  it("uses the configured provider for generated webhook trigger secrets", async () => {
    process.env.PAPERCLIP_SECRETS_PROVIDER = "aws_secrets_manager";
    const originalGetSecretProvider = providerRegistry.getSecretProvider;
    const getSecretProviderSpy = vi.spyOn(providerRegistry, "getSecretProvider").mockImplementation((provider) => {
      if (provider !== "aws_secrets_manager") {
        return originalGetSecretProvider(provider);
      }
      return {
        id: "aws_secrets_manager",
        descriptor: () => ({
          id: "aws_secrets_manager",
          label: "AWS Secrets Manager",
          supportsManaged: true,
          supportsExternalReference: true,
        }),
        validateConfig: async () => ({ ok: true, warnings: [] }),
        createSecret: async ({ value }) => ({
          material: { source: "managed", secretId: "arn:aws:secretsmanager:stub", versionId: "v1" },
          valueSha256: `sha:${value}`,
          fingerprintSha256: `sha:${value}`,
          externalRef: "arn:aws:secretsmanager:stub",
          providerVersionRef: "v1",
        }),
        createVersion: async ({ value }) => ({
          material: { source: "managed", secretId: "arn:aws:secretsmanager:stub", versionId: "v2" },
          valueSha256: `sha:${value}`,
          fingerprintSha256: `sha:${value}`,
          externalRef: "arn:aws:secretsmanager:stub",
          providerVersionRef: "v2",
        }),
        linkExternalSecret: async ({ externalRef, providerVersionRef }) => ({
          material: { source: "external", secretId: externalRef, versionId: providerVersionRef ?? null },
          valueSha256: "external",
          fingerprintSha256: "external",
          externalRef,
          providerVersionRef: providerVersionRef ?? null,
        }),
        resolveVersion: async () => "resolved-secret",
        deleteOrArchive: async () => undefined,
        healthCheck: async () => ({
          provider: "aws_secrets_manager",
          status: "ok",
          message: "stubbed",
        }),
      };
    });

    try {
      const { routine, svc } = await seedFixture();
      const { trigger } = await svc.createTrigger(
        routine.id,
        {
          kind: "webhook",
          signingMode: "hmac_sha256",
          replayWindowSec: 300,
        },
        {},
      );

      const [secret] = await db
        .select({
          id: companySecrets.id,
          provider: companySecrets.provider,
        })
        .from(companySecrets)
        .where(eq(companySecrets.id, trigger.secretId!));

      expect(secret).toMatchObject({
        id: trigger.secretId,
        provider: "aws_secrets_manager",
      });
    } finally {
      getSecretProviderSpy.mockRestore();
    }
  });

  it("accepts GitHub-style X-Hub-Signature-256 with github_hmac signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "github_hmac",
      },
      {},
    );

    const payload = { action: "opened", pull_request: { number: 1 } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(rawBody)
      .digest("hex")}`;

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      hubSignatureHeader: signature,
      rawBody,
      payload,
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
  });

  it("rejects invalid signature for github_hmac signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "github_hmac",
      },
      {},
    );

    const rawBody = Buffer.from(JSON.stringify({ ok: true }));

    await expect(
      svc.firePublicTrigger(trigger.publicId!, {
        hubSignatureHeader: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        rawBody,
        payload: { ok: true },
      }),
    ).rejects.toThrow();
  });

  it("accepts any request with none signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { event: "error.created" },
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
  });

  it("records suppressed automatic runs when worktree execution is disabled while allowing manual runs", async () => {
    const runtimeEnv = { PAPERCLIP_IN_WORKTREE: "yes", PAPERCLIP_INSTANCE_ID: "worktree-routines-test" };
    const { companyId, routine, svc } = await seedFixture({ runtimeEnv });
    const { trigger: scheduleTrigger } = await svc.createTrigger(
      routine.id,
      { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" },
      {},
    );
    const { trigger: webhookTrigger } = await svc.createTrigger(
      routine.id,
      { kind: "webhook", signingMode: "none" },
      {},
    );
    const pastDue = new Date("2020-01-01T00:00:00.000Z");
    await db.update(routineTriggers).set({ nextRunAt: pastDue }).where(eq(routineTriggers.id, scheduleTrigger.id));

    expect(await svc.tickScheduledTriggers(new Date())).toEqual({ triggered: 0 });
    const webhookRun = await svc.firePublicTrigger(webhookTrigger.publicId!, { payload: { event: "created" } });
    expect(webhookRun).toMatchObject({ source: "webhook", status: "skipped", failureReason: "worktree_execution_cutoff" });

    const manualRun = await svc.runRoutine(routine.id, { source: "manual" });
    expect(manualRun.status).toBe("issue_created");

    const automatedRuns = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    expect(automatedRuns.filter((run) => run.failureReason === "worktree_execution_cutoff")).toHaveLength(2);
    expect(automatedRuns.filter((run) => run.linkedIssueId)).toHaveLength(1);
    const scheduleAfter = await db.select().from(routineTriggers).where(eq(routineTriggers.id, scheduleTrigger.id)).then((rows) => rows[0]);
    expect(scheduleAfter!.nextRunAt!.getTime()).toBeGreaterThan(pastDue.getTime());
    expect((await db.select().from(issues).where(eq(issues.companyId, companyId))).filter((issue) => issue.originKind === "routine_execution")).toHaveLength(1);
  });

  it("dispatches only post-cutoff scheduled routines in an armed worktree", async () => {
    const runtimeEnv = { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "worktree-routines-test" };
    const { companyId, agentId, projectId, routine: oldRoutine, svc } = await seedFixture({ runtimeEnv });
    const cutoff = new Date("2025-01-01T00:00:00.000Z");
    await armWorktreeExecution(cutoff);
    const newRoutine = await svc.create(companyId, {
      projectId,
      goalId: null,
      parentIssueId: null,
      title: "new routine",
      description: null,
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    }, {});
    await db.update(routines).set({ createdAt: new Date("2024-12-31T23:59:59.000Z") }).where(eq(routines.id, oldRoutine.id));
    await db.update(routines).set({ createdAt: new Date("2025-01-01T00:00:01.000Z") }).where(eq(routines.id, newRoutine.id));
    const { trigger: oldTrigger } = await svc.createTrigger(oldRoutine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
    const { trigger: newTrigger } = await svc.createTrigger(newRoutine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
    await db.update(routineTriggers).set({ nextRunAt: new Date("2020-01-01T00:00:00.000Z") }).where(eq(routineTriggers.id, oldTrigger.id));
    await db.update(routineTriggers).set({ nextRunAt: new Date("2020-01-01T00:00:00.000Z") }).where(eq(routineTriggers.id, newTrigger.id));

    expect(await svc.tickScheduledTriggers(new Date())).toEqual({ triggered: 1 });
    const oldRuns = await db.select().from(routineRuns).where(eq(routineRuns.routineId, oldRoutine.id));
    expect(oldRuns).toMatchObject([{ status: "skipped", failureReason: "worktree_execution_cutoff", linkedIssueId: null }]);
    const newRuns = await db.select().from(routineRuns).where(eq(routineRuns.routineId, newRoutine.id));
    expect(newRuns).toMatchObject([{ status: "issue_created" }]);
  });

  it("coalesces multiple missed sub-hourly ticks into one catch-up run", async () => {
    const { routine, svc } = await seedFixture();
    await db.update(routines).set({
      catchUpPolicy: "enqueue_missed_with_cap",
    }).where(eq(routines.id, routine.id));
    const { trigger } = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "*/10 * * * *",
      timezone: "UTC",
    }, {});
    await db.update(routineTriggers).set({
      nextRunAt: new Date("2026-07-16T00:00:00.000Z"),
    }).where(eq(routineTriggers.id, trigger.id));

    expect(await svc.tickScheduledTriggers(new Date("2026-07-16T01:05:00.000Z"))).toEqual({ triggered: 1 });

    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("issue_created");
    const updatedTrigger = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id)).then((rows) => rows[0]);
    expect(updatedTrigger?.nextRunAt).toEqual(new Date("2026-07-16T01:10:00.000Z"));
  });

  it("continues replaying each missed hourly tick", async () => {
    const { routine, svc } = await seedFixture();
    await db.update(routines).set({
      catchUpPolicy: "enqueue_missed_with_cap",
    }).where(eq(routines.id, routine.id));
    const { trigger } = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
    }, {});
    await db.update(routineTriggers).set({
      nextRunAt: new Date("2026-07-16T00:00:00.000Z"),
    }).where(eq(routineTriggers.id, trigger.id));

    expect(await svc.tickScheduledTriggers(new Date("2026-07-16T02:30:00.000Z"))).toEqual({ triggered: 3 });

    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    expect(runs).toHaveLength(3);
    expect(runs.filter((run) => run.status === "issue_created")).toHaveLength(1);
    expect(runs.filter((run) => run.status === "coalesced")).toHaveLength(2);
    const updatedTrigger = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id)).then((rows) => rows[0]);
    expect(updatedTrigger?.nextRunAt).toEqual(new Date("2026-07-16T03:00:00.000Z"));
  });

  it("continues replaying missed ticks for daily schedules with multiple minute values", async () => {
    const { routine, svc } = await seedFixture();
    await db.update(routines).set({
      catchUpPolicy: "enqueue_missed_with_cap",
    }).where(eq(routines.id, routine.id));
    const { trigger } = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0,30 9 * * *",
      timezone: "UTC",
    }, {});
    await db.update(routineTriggers).set({
      nextRunAt: new Date("2026-07-14T09:00:00.000Z"),
    }).where(eq(routineTriggers.id, trigger.id));

    expect(await svc.tickScheduledTriggers(new Date("2026-07-15T10:00:00.000Z"))).toEqual({ triggered: 4 });

    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    expect(runs).toHaveLength(4);
    expect(runs.filter((run) => run.status === "issue_created")).toHaveLength(1);
    expect(runs.filter((run) => run.status === "coalesced")).toHaveLength(3);
    const updatedTrigger = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id)).then((rows) => rows[0]);
    expect(updatedTrigger?.nextRunAt).toEqual(new Date("2026-07-16T09:00:00.000Z"));
  });

  it("coalesces sub-hourly schedules restricted to weekdays", async () => {
    const { routine, svc } = await seedFixture();
    await db.update(routines).set({
      catchUpPolicy: "enqueue_missed_with_cap",
    }).where(eq(routines.id, routine.id));
    const { trigger } = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "*/10 * * * 1-5",
      timezone: "UTC",
    }, {});
    await db.update(routineTriggers).set({
      nextRunAt: new Date("2026-07-13T00:00:00.000Z"),
    }).where(eq(routineTriggers.id, trigger.id));

    expect(await svc.tickScheduledTriggers(new Date("2026-07-13T01:05:00.000Z"))).toEqual({ triggered: 1 });

    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("issue_created");
    const updatedTrigger = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id)).then((rows) => rows[0]);
    expect(updatedTrigger?.nextRunAt).toEqual(new Date("2026-07-13T01:10:00.000Z"));
  });

  it("applies the armed cutoff to webhook dispatch but not manual API runs", async () => {
    const runtimeEnv = { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "worktree-routines-test" };
    const { routine, svc } = await seedFixture({ runtimeEnv });
    await armWorktreeExecution(new Date("2025-01-01T00:00:00.000Z"));
    await db.update(routines).set({ createdAt: new Date("2024-12-31T23:59:59.000Z") }).where(eq(routines.id, routine.id));
    const { trigger } = await svc.createTrigger(routine.id, { kind: "webhook", signingMode: "none" }, {});

    const webhookRun = await svc.firePublicTrigger(trigger.publicId!, { payload: { event: "created" } });
    expect(webhookRun).toMatchObject({ status: "skipped", failureReason: "worktree_execution_cutoff", linkedIssueId: null });
    expect((await svc.runRoutine(routine.id, { source: "api" })).status).toBe("issue_created");
  });

  it("suppresses scheduled ticks while the routine project is paused, then resumes when unpaused", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 0 * * *",
        timezone: "UTC",
      },
      {},
    );

    const pastDue = new Date("2020-01-01T00:00:00.000Z");

    // Pause the project and make the schedule trigger due.
    await db
      .update(projects)
      .set({ pausedAt: new Date(), pauseReason: "manual pause" })
      .where(eq(projects.id, projectId));
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));

    const pausedResult = await svc.tickScheduledTriggers(new Date());
    expect(pausedResult.triggered).toBe(0);

    // No execution issue should be created while paused.
    const issuesWhilePaused = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(issuesWhilePaused).toHaveLength(0);

    // One skipped routine run with pause-specific reason and no linked issue.
    const skippedRuns = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id));
    expect(skippedRuns).toHaveLength(1);
    expect(skippedRuns[0]?.status).toBe("skipped");
    expect(skippedRuns[0]?.source).toBe("schedule");
    expect(skippedRuns[0]?.failureReason).toBe("paused");
    expect(skippedRuns[0]?.linkedIssueId).toBeNull();
    expect(skippedRuns[0]?.completedAt).not.toBeNull();

    // Trigger advanced past the paused firing and audit reflects the pause skip.
    const pausedTrigger = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, trigger.id))
      .then((rows) => rows[0]);
    expect(pausedTrigger?.nextRunAt).not.toBeNull();
    expect(pausedTrigger!.nextRunAt!.getTime()).toBeGreaterThan(pastDue.getTime());
    expect(pausedTrigger?.lastResult).toMatch(/paused/i);

    // Unpause and make the trigger due again; a normal tick now creates an issue.
    await db
      .update(projects)
      .set({ pausedAt: null, pauseReason: null })
      .where(eq(projects.id, projectId));
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));

    const resumedResult = await svc.tickScheduledTriggers(new Date());
    expect(resumedResult.triggered).toBe(1);

    const issuesAfterResume = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(issuesAfterResume).toHaveLength(1);

    const runsAfterResume = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id));
    expect(runsAfterResume).toHaveLength(2);
    expect(runsAfterResume.some((run) => run.status === "issue_created")).toBe(true);
  });

  it("skips a gated scheduled tick when quiet without advancing the activity window", async () => {
    const { companyId, routine, svc } = await seedFixture();
    await db.update(routines).set({
      activityGatePolicy: "require_external_activity",
    }).where(eq(routines.id, routine.id));
    const gatedRoutine = { ...routine, activityGatePolicy: "require_external_activity" };
    const { trigger } = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "* * * * *",
      timezone: "UTC",
    }, {});
    const firstTick = new Date();
    await db.update(routineTriggers).set({ nextRunAt: new Date(firstTick.getTime() - 1_000) }).where(eq(routineTriggers.id, trigger.id));

    expect(await svc.tickScheduledTriggers(firstTick)).toEqual({ triggered: 1 });
    const [firstRun] = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    expect(firstRun?.status).toBe("issue_created");

    const quietTick = new Date(firstTick.getTime() + 60_000);
    await db.update(routineTriggers).set({ nextRunAt: new Date(quietTick.getTime() - 1_000) }).where(eq(routineTriggers.id, trigger.id));
    expect(await svc.tickScheduledTriggers(quietTick)).toEqual({ triggered: 0 });

    const runsAfterQuietTick = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    const quietRun = runsAfterQuietTick.find((run) => run.failureReason === "no_external_activity");
    expect(quietRun).toMatchObject({
      status: "skipped",
      source: "schedule",
      linkedIssueId: null,
      triggerPayload: {
        activityGate: {
          verdict: "quiet",
          windowStart: firstRun!.triggeredAt.toISOString(),
          matchedActivityId: null,
        },
      },
    });

    const activityAt = new Date(firstRun!.triggeredAt.getTime() + 30_000);
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: firstRun!.linkedIssueId!,
      createdAt: activityAt,
    });
    await db.update(issues).set({ status: "done", completedAt: activityAt }).where(eq(issues.id, firstRun!.linkedIssueId!));
    const resumedTick = new Date(quietTick.getTime() + 60_000);
    await db.update(routineTriggers).set({ nextRunAt: new Date(resumedTick.getTime() - 1_000) }).where(eq(routineTriggers.id, trigger.id));

    await expect(svc.evaluateActivityGate(gatedRoutine, resumedTick)).resolves.toMatchObject({
      fire: true,
      windowStart: firstRun!.triggeredAt,
    });
    expect(await svc.tickScheduledTriggers(resumedTick)).toEqual({ triggered: 1 });
  });

  it("bypasses the activity gate for webhook dispatches", async () => {
    const { routine, svc } = await seedFixture();
    await db.update(routines).set({ activityGatePolicy: "require_external_activity" }).where(eq(routines.id, routine.id));
    const { trigger } = await svc.createTrigger(routine.id, { kind: "webhook", signingMode: "none" }, {});

    const run = await svc.firePublicTrigger(trigger.publicId!, { payload: { source: "test" } });

    expect(run).toMatchObject({ source: "webhook", status: "issue_created" });
  });

  async function seedSecondRoutineInSameCompany(
    companyId: string,
    projectId: string,
    svc: Awaited<ReturnType<typeof seedFixture>>["svc"],
    label: string,
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: label,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: `${label} routine`,
        description: `Run the ${label} routine`,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );
    return { agentId, routine };
  }

  it("keeps ticking the rest of a single-company batch, only after an earlier dispatch failure is durably recorded", async () => {
    // Causal check (not incidental createdAt ordering): the healthy routine's own wakeup
    // fires synchronously mid-dispatch, inside the same for-loop iteration that processes the
    // whole due batch. If a future change ever parallelized that loop, the broken routine's
    // failed run would not yet be committed when this fires, and the assertion below would
    // catch it — a timestamp-only check after the tick completes could not.
    let causalCheckRan = false;
    let causalCheckPassed = false;

    const { companyId, agentId, projectId, routine, svc } = await seedFixture({
      wakeup: async (wakeupAgentId, wakeupOpts) => {
        causalCheckRan = true;
        const brokenFailedRuns = await db
          .select()
          .from(routineRuns)
          .where(and(eq(routineRuns.routineId, routine.id), eq(routineRuns.status, "failed")));
        causalCheckPassed = brokenFailedRuns.length === 1;

        const issueId =
          (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
          (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
          null;
        if (!issueId) return null;
        const queuedRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: queuedRunId,
          companyId,
          agentId: wakeupAgentId,
          invocationSource: wakeupOpts.source ?? "assignment",
          triggerDetail: wakeupOpts.triggerDetail ?? null,
          status: "queued",
          contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
        });
        await db
          .update(issues)
          .set({ executionRunId: queuedRunId, executionLockedAt: new Date() })
          .where(eq(issues.id, issueId));
        return { id: queuedRunId };
      },
    });

    const { routine: healthyRoutine } = await seedSecondRoutineInSameCompany(companyId, projectId, svc, "healthy");

    const { trigger: brokenTrigger } = await svc.createTrigger(
      routine.id,
      { kind: "schedule", label: "daily", cronExpression: "0 0 * * *", timezone: "UTC" },
      {},
    );
    const { trigger: healthyTrigger } = await svc.createTrigger(
      healthyRoutine.id,
      { kind: "schedule", label: "daily", cronExpression: "0 0 * * *", timezone: "UTC" },
      {},
    );

    // Make the first routine's assignee unassignable so dispatchRoutineRun throws
    // synchronously (assertAssignableAgent), before any routineRuns row is created.
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));

    const pastDue = new Date("2020-01-01T00:00:00.000Z");
    // Order matters: the broken trigger must be claimed/dispatched before the healthy one
    // in the same tick to prove a throw doesn't abort the remaining batch.
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue, createdAt: new Date("2019-12-31T00:00:00.000Z") })
      .where(eq(routineTriggers.id, brokenTrigger.id));
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue, createdAt: new Date("2019-12-31T00:00:01.000Z") })
      .where(eq(routineTriggers.id, healthyTrigger.id));

    const result = await svc.tickScheduledTriggers(new Date());

    // Only the healthy routine actually dispatched; the broken one is recorded as failed, not counted.
    expect(result.triggered).toBe(1);
    expect(causalCheckRan).toBe(true);
    expect(causalCheckPassed).toBe(true);

    // The broken routine's schedule is still claimed/advanced (no tight retry loop), but the
    // failure is recorded observably instead of vanishing.
    const brokenRuns = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id));
    expect(brokenRuns).toHaveLength(1);
    expect(brokenRuns[0]?.status).toBe("failed");
    expect(brokenRuns[0]?.source).toBe("schedule");
    expect(brokenRuns[0]?.linkedIssueId).toBeNull();
    expect(brokenRuns[0]?.failureReason).toMatch(/terminated/i);
    expect(brokenRuns[0]?.completedAt).not.toBeNull();

    const brokenTriggerAfter = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, brokenTrigger.id))
      .then((rows) => rows[0]);
    expect(brokenTriggerAfter?.nextRunAt).not.toBeNull();
    expect(brokenTriggerAfter!.nextRunAt!.getTime()).toBeGreaterThan(pastDue.getTime());
    expect(brokenTriggerAfter?.lastResult).toMatch(/failed/i);

    // The second, healthy routine in the same tick must not be skipped by the first one's throw.
    const healthyRuns = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, healthyRoutine.id));
    expect(healthyRuns).toHaveLength(1);
    expect(healthyRuns[0]?.status).toBe("issue_created");

    const healthyIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(healthyIssues).toHaveLength(1);
  });

  it("records one failed run per claimed catch-up firing, capped at MAX_CATCH_UP_RUNS, without aborting the tick", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();

    // A routine with enqueue_missed_with_cap so a long-overdue trigger computes runCount > 1
    // (capped at MAX_CATCH_UP_RUNS) inside a single tick.
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "catch-up frog",
        description: "Run the catch-up frog routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "enqueue_missed_with_cap",
      },
      {},
    );
    const { trigger } = await svc.createTrigger(
      routine.id,
      // Hourly, not sub-hourly: an every-minute cron would hit the scheduler's own
      // sub-hourly catch-up guard (isSubHourlyCronExpression) and collapse to a single
      // firing instead of the multi-firing batch this test needs.
      { kind: "schedule", label: "hourly", cronExpression: "0 * * * *", timezone: "UTC" },
      {},
    );

    // Make the assignee unassignable so every catch-up iteration's dispatch throws identically.
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));

    // Far enough in the past that the capped catch-up loop computes runCount === MAX_CATCH_UP_RUNS.
    const longOverdue = new Date("2020-01-01T00:00:00.000Z");
    await db
      .update(routineTriggers)
      .set({ nextRunAt: longOverdue })
      .where(eq(routineTriggers.id, trigger.id));

    const result = await svc.tickScheduledTriggers(new Date());
    expect(result.triggered).toBe(0);

    // The CAS already advanced nextRunAt past every one of the MAX_CATCH_UP_RUNS claimed
    // firings before dispatch, so each claimed firing must get its own recorded outcome —
    // no claimed firing silently vanishes, and the batch is not aborted midway.
    const runs = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id));
    // Mirrors the unexported MAX_CATCH_UP_RUNS in ../services/routines.ts.
    const MAX_CATCH_UP_RUNS = 25;
    expect(runs).toHaveLength(MAX_CATCH_UP_RUNS);
    expect(runs.every((run) => run.status === "failed")).toBe(true);
    expect(runs.every((run) => (run.failureReason ?? "").match(/terminated/i))).toBe(true);
  });

  it("keeps dispatching later routines in the batch when the failure recorder's own transaction throws", async () => {
    const { companyId, agentId, projectId, routine, svc } = await seedFixture();
    const { routine: healthyRoutine } = await seedSecondRoutineInSameCompany(companyId, projectId, svc, "healthy");

    const { trigger: brokenTrigger } = await svc.createTrigger(
      routine.id,
      { kind: "schedule", label: "daily", cronExpression: "0 0 * * *", timezone: "UTC" },
      {},
    );
    const { trigger: healthyTrigger } = await svc.createTrigger(
      healthyRoutine.id,
      { kind: "schedule", label: "daily", cronExpression: "0 0 * * *", timezone: "UTC" },
      {},
    );

    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));

    const pastDue = new Date("2020-01-01T00:00:00.000Z");
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue, createdAt: new Date("2019-12-31T00:00:00.000Z") })
      .where(eq(routineTriggers.id, brokenTrigger.id));
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue, createdAt: new Date("2019-12-31T00:00:01.000Z") })
      .where(eq(routineTriggers.id, healthyTrigger.id));

    // Simulate a DB blip on the very first db.transaction call in this tick, which is
    // recordFailedScheduleRun's own transaction for the broken routine (dispatchRoutineRun's
    // early assignee-eligibility throw happens before it ever opens a transaction, so no
    // other db.transaction call precedes it). vi.spyOn keeps the pass-through default for
    // every call after the queued one-shot override.
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockImplementationOnce(() => Promise.reject(new Error("simulated recorder db blip")));

    try {
      const result = await svc.tickScheduledTriggers(new Date());

      // The broken routine's own failure couldn't be durably recorded (its recorder's
      // transaction rejected, caught by the recorder guard), but the batch must still reach
      // the healthy routine rather than aborting the whole tick.
      expect(result.triggered).toBe(1);

      const brokenRuns = await db
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.routineId, routine.id));
      expect(brokenRuns).toHaveLength(0);

      const healthyRuns = await db
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.routineId, healthyRoutine.id));
      expect(healthyRuns).toHaveLength(1);
      expect(healthyRuns[0]?.status).toBe("issue_created");
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("does not record a compensating failed run when dispatch's transaction durably commits but the caller sees it reject", async () => {
    // The assignee stays healthy here: this reproduces an "ambiguous commit" — the DB driver
    // actually commits dispatchRoutineRun's transaction, but the promise the scheduler is
    // awaiting rejects anyway (a real class of failure: connection drop between COMMIT and
    // acknowledgment, etc). That is a genuinely different failure mode than an assignee
    // rejection, and it is the one the reconciliation check exists for.
    const { companyId, projectId, routine, svc } = await seedFixture();
    const { routine: healthyRoutine } = await seedSecondRoutineInSameCompany(
      companyId,
      projectId,
      svc,
      "healthy-after-ambiguous",
    );

    const { trigger: ambiguousTrigger } = await svc.createTrigger(
      routine.id,
      { kind: "schedule", label: "daily", cronExpression: "0 0 * * *", timezone: "UTC" },
      {},
    );
    const { trigger: healthyTrigger } = await svc.createTrigger(
      healthyRoutine.id,
      { kind: "schedule", label: "daily", cronExpression: "0 0 * * *", timezone: "UTC" },
      {},
    );

    const pastDue = new Date("2020-01-01T00:00:00.000Z");
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue, createdAt: new Date("2019-12-31T00:00:00.000Z") })
      .where(eq(routineTriggers.id, ambiguousTrigger.id));
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue, createdAt: new Date("2019-12-31T00:00:01.000Z") })
      .where(eq(routineTriggers.id, healthyTrigger.id));

    // Let the very first db.transaction call in this tick (dispatchRoutineRun's own, for the
    // "ambiguous" routine — it is processed first by due-order) actually run to completion
    // via the real implementation, so the run row genuinely commits, then reject the promise
    // the caller is awaiting anyway. Every later db.transaction call (including the healthy
    // routine's own dispatch) falls through to the untouched real implementation.
    const originalTransaction = db.transaction.bind(db) as typeof db.transaction;
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockImplementationOnce(async (...args: Parameters<typeof db.transaction>) => {
        await originalTransaction(...args);
        throw new Error("simulated ambiguous commit failure — driver reported failure after a real commit");
      });

    try {
      const result = await svc.tickScheduledTriggers(new Date());

      // The healthy routine's dispatch resolves cleanly and is counted; the "ambiguous"
      // routine's own dispatch call appears (from the scheduler's point of view) to throw,
      // so it is not counted here even though it truly committed.
      expect(result.triggered).toBe(1);

      // Exactly one run for the ambiguous routine — the real, durably committed one — and it
      // reflects the actual dispatch outcome, not a compensating "failed" row next to it.
      const ambiguousRuns = await db
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.routineId, routine.id));
      expect(ambiguousRuns).toHaveLength(1);
      expect(ambiguousRuns[0]?.status).toBe("issue_created");
      expect(ambiguousRuns[0]?.linkedIssueId).not.toBeNull();
      // Reconciliation matched on the deterministic per-attempt idempotency key, not on a
      // clock/time-window comparison — assert the mechanism directly, not just the outcome.
      expect(ambiguousRuns[0]?.idempotencyKey).toMatch(new RegExp(`^schedule:${ambiguousTrigger.id}:`));

      // The later, healthy routine in the same tick still dispatched normally.
      const healthyRuns = await db
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.routineId, healthyRoutine.id));
      expect(healthyRuns).toHaveLength(1);
      expect(healthyRuns[0]?.status).toBe("issue_created");
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("does not let one catch-up firing's success suppress the next firing's genuine failure (distinct idempotency keys)", async () => {
    // This is the direct regression for the timestamp-based design's zero-row hole: a
    // same-tick catch-up iteration N that succeeds must not cause iteration N+1's own,
    // genuinely different failure to be swallowed. A time-window reconciliation could mistake
    // iteration N's just-committed success for iteration N+1's outcome if the two landed
    // within the same createdAt-resolution window. Forcing that specific race deterministically
    // against embedded Postgres's real async I/O (both rows must land in the exact same
    // millisecond) is not practical to do reliably — vi.useFakeTimers stalls the driver's own
    // I/O, and sub-millisecond timing races are inherently flaky to force from outside. So
    // this test instead proves the mechanism directly: iteration 0 dispatches successfully,
    // iteration 1's own dispatch call is made to fail (via a one-shot db.transaction
    // rejection, exactly the same technique the ambiguous-commit test above uses — no
    // assignability toggling required), and we assert each iteration produced its own outcome
    // row under its own distinct, index-suffixed idempotency key. Because the reconciliation
    // lookup matches on that exact key, iteration 0's row is structurally unable to satisfy
    // iteration 1's lookup regardless of how close together in time they land — this is true
    // by construction, not by getting lucky on timing, which is what makes the exact-key
    // design correct where the time-window design was not.
    const { companyId, agentId, projectId, routine, svc } = await seedFixture();

    const routineWithCatchUp = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "flaky catch-up frog",
        description: "Run the flaky catch-up frog routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "enqueue_missed_with_cap",
      },
      {},
    );
    const { trigger } = await svc.createTrigger(
      routineWithCatchUp.id,
      // Hourly, not sub-hourly: an every-minute cron would hit the scheduler's own
      // sub-hourly catch-up guard (isSubHourlyCronExpression) and collapse to a single
      // firing instead of the two-firing batch this test needs.
      { kind: "schedule", label: "hourly", cronExpression: "0 * * * *", timezone: "UTC" },
      {},
    );

    // Exactly two missed firings, one hour apart, so runCount === 2.
    const firstFiring = new Date("2020-01-01T00:00:00.000Z");
    await db
      .update(routineTriggers)
      .set({ nextRunAt: firstFiring })
      .where(eq(routineTriggers.id, trigger.id));
    const now = new Date("2020-01-01T01:01:00.000Z");

    // Let the first *top-level* db.transaction call in this tick (iteration 0's own dispatch)
    // commit for real. Reject the second top-level call (iteration 1's own dispatch) outright,
    // without calling through — a genuine, non-durable failure for that attempt specifically:
    // no row is created for it at all, so recordFailedScheduleRun must be the one to create it.
    // Nesting depth must be tracked explicitly: issueSvc.create opens its own nested
    // db.transaction (a savepoint) from inside dispatchRoutineRun's already-open transaction,
    // so a flat call counter can't tell an iteration boundary apart from that nested call.
    const originalTransaction = db.transaction.bind(db) as typeof db.transaction;
    let depth = 0;
    let topLevelCallCount = 0;
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation(
      async (...args: Parameters<typeof db.transaction>) => {
        const isTopLevel = depth === 0;
        if (isTopLevel) {
          topLevelCallCount += 1;
          if (topLevelCallCount === 2) {
            throw new Error("simulated genuine failure for the second catch-up iteration");
          }
        }
        depth += 1;
        try {
          return await originalTransaction(...args);
        } finally {
          depth -= 1;
        }
      },
    );

    try {
      const result = await svc.tickScheduledTriggers(now);

      // Iteration 0 dispatched successfully and is counted; iteration 1 failed.
      expect(result.triggered).toBe(1);

      const runs = await db
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.routineId, routineWithCatchUp.id));
      expect(runs).toHaveLength(2);

      const successRun = runs.find((run) => run.status !== "failed");
      const failedRun = runs.find((run) => run.status === "failed");
      expect(successRun).toBeDefined();
      expect(failedRun).toBeDefined();
      expect(failedRun?.failureReason).toMatch(/simulated genuine failure/);

      // The two runs used distinct, index-suffixed idempotency keys — the mechanism that
      // makes iteration 0's success structurally unable to satisfy iteration 1's
      // reconciliation lookup, regardless of how close together in time they land.
      expect(successRun?.idempotencyKey).toMatch(/:0$/);
      expect(failedRun?.idempotencyKey).toMatch(/:1$/);
      expect(failedRun?.idempotencyKey).not.toBe(successRun?.idempotencyKey);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("does not duplicate a run that dispatchRoutineRun already recorded as failed internally, even under an ambiguous commit", async () => {
    // dispatchRoutineRun has its own internal try/catch (around issue creation and wakeup
    // queueing) that, on failure, finalizes the run with status "failed" and commits that
    // within the SAME transaction as the run's own creation — a durable, real failed row that
    // predates and is independent of the scheduler's compensating-insert logic entirely. If
    // the outer db.transaction call *also* appears to throw afterward (the same ambiguous
    // commit scenario as above), the scheduler's reconciliation must recognize the row that
    // already exists under this attempt's idempotency key — regardless of its status — and
    // must not insert a second "failed" row next to it.
    const failure = new Error("simulated wakeup queueing failure");
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        throw failure;
      },
    });

    const { trigger } = await svc.createTrigger(
      routine.id,
      { kind: "schedule", label: "daily", cronExpression: "0 0 * * *", timezone: "UTC" },
      {},
    );
    await db
      .update(routineTriggers)
      .set({ nextRunAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(routineTriggers.id, trigger.id));

    // Let the real transaction run to completion (issue creation fails internally via the
    // throwing wakeup above, dispatchRoutineRun's own catch commits a real "failed" row), then
    // reject the promise the scheduler is awaiting anyway.
    const originalTransaction = db.transaction.bind(db) as typeof db.transaction;
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockImplementationOnce(async (...args: Parameters<typeof db.transaction>) => {
        await originalTransaction(...args);
        throw new Error("simulated ambiguous commit failure — driver reported failure after a real commit");
      });

    try {
      await svc.tickScheduledTriggers(new Date());

      // Exactly one failed run — the one dispatchRoutineRun itself durably committed — not a
      // second, compensating one from the scheduler's catch.
      const runs = await db
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.routineId, routine.id));
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("failed");
      expect(runs[0]?.failureReason).toMatch(/simulated wakeup queueing failure/);
    } finally {
      transactionSpy.mockRestore();
    }
  });
});
