import { createHmac, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
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
  goals,
  heartbeatRuns,
  issueComments,
  instanceSettings,
  issueInboxArchives,
  issueReadStates,
  issueRelations,
  issueThreadInteractions,
  issues,
  projectWorkspaces,
  projects,
  routineDocuments,
  routineRevisions,
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
import { logger } from "../middleware/logger.ts";
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
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
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

  let routineFireSeq = 100000;
  async function insertRoutineFire(input: {
    companyId: string;
    routineId: string;
    status: string;
    createdAt: Date;
    n: number;
  }) {
    const id = randomUUID();
    const seq = ++routineFireSeq;
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: `routine fire ${input.n}`,
      status: input.status,
      priority: "medium",
      issueNumber: seq,
      identifier: `RT-${id.slice(0, 8)}`,
      originKind: "routine_execution",
      originId: input.routineId,
      createdAt: input.createdAt,
    });
    return id;
  }

  it("cancels a blocked routine fire superseded by a newer fire of an active routine", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const stale = await insertRoutineFire({ companyId, routineId: routine.id, status: "blocked", createdAt: new Date("2026-03-19T00:00:00Z"), n: 1 });
    await insertRoutineFire({ companyId, routineId: routine.id, status: "todo", createdAt: new Date("2026-03-19T01:00:00Z"), n: 2 });

    const result = await svc.cancelSupersededRoutineExecutionIssues();
    expect(result.cancelled).toBe(1);
    expect(result.issueIds).toEqual([stale]);

    const row = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, stale)).then((r) => r[0] ?? null);
    expect(row?.status).toBe("cancelled");
  });

  it("leaves a blocked routine fire that has not been superseded", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const lone = await insertRoutineFire({ companyId, routineId: routine.id, status: "blocked", createdAt: new Date("2026-03-19T00:00:00Z"), n: 1 });

    const result = await svc.cancelSupersededRoutineExecutionIssues();
    expect(result.cancelled).toBe(0);
    const row = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, lone)).then((r) => r[0] ?? null);
    expect(row?.status).toBe("blocked");
  });

  it("rejects a scheduled trigger below the company cadence floor", async () => {
    const { companyId, routine, svc } = await seedFixture();
    await db
      .update(companies)
      .set({ routineGuardConfig: { minimumScheduleIntervalMinutes: 10 } })
      .where(eq(companies.id, companyId));

    await expect(svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "*/5 * * * *",
      timezone: "UTC",
    }, {})).rejects.toThrow("no more often than every 10 minutes");
  });

  it("does not treat a newer blocked fire as a superseding live execution", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const failedFire = await insertRoutineFire({
      companyId,
      routineId: routine.id,
      status: "blocked",
      createdAt: new Date("2026-03-19T00:00:00Z"),
      n: 1,
    });
    const catchUpFire = await insertRoutineFire({
      companyId,
      routineId: routine.id,
      status: "blocked",
      createdAt: new Date("2026-03-19T01:00:00Z"),
      n: 2,
    });

    const result = await svc.cancelSupersededRoutineExecutionIssues();
    expect(result.cancelled).toBe(0);

    const rows = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(inArray(issues.id, [failedFire, catchUpFire]))
      .orderBy(asc(issues.createdAt));
    expect(rows).toEqual([
      { id: failedFire, status: "blocked" },
      { id: catchUpFire, status: "blocked" },
    ]);
  });

  it("leaves a superseded blocked fire that still carries an active first-class blocker", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const stale = await insertRoutineFire({ companyId, routineId: routine.id, status: "blocked", createdAt: new Date("2026-03-19T00:00:00Z"), n: 1 });
    await insertRoutineFire({ companyId, routineId: routine.id, status: "todo", createdAt: new Date("2026-03-19T01:00:00Z"), n: 2 });
    const blocker = await insertRoutineFire({ companyId, routineId: routine.id, status: "in_progress", createdAt: new Date("2026-03-19T00:30:00Z"), n: 3 });
    await db.insert(issueRelations).values({ companyId, issueId: blocker, relatedIssueId: stale, type: "blocks" });

    const result = await svc.cancelSupersededRoutineExecutionIssues();
    expect(result.cancelled).toBe(0);
    const row = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, stale)).then((r) => r[0] ?? null);
    expect(row?.status).toBe("blocked");
  });

  it("leaves a superseded blocked fire when its routine is paused", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const stale = await insertRoutineFire({ companyId, routineId: routine.id, status: "blocked", createdAt: new Date("2026-03-19T00:00:00Z"), n: 1 });
    await insertRoutineFire({ companyId, routineId: routine.id, status: "todo", createdAt: new Date("2026-03-19T01:00:00Z"), n: 2 });
    await db.update(routines).set({ status: "paused" }).where(eq(routines.id, routine.id));

    const result = await svc.cancelSupersededRoutineExecutionIssues();
    expect(result.cancelled).toBe(0);
    const row = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, stale)).then((r) => r[0] ?? null);
    expect(row?.status).toBe("blocked");
  });

  async function armWorktreeExecution(cutoff: Date, instanceId = "worktree-routines-test") {
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: {
        enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: cutoff.toISOString(),
        worktreeRunExecutionActivationInstanceId: instanceId,
      },
    }).onConflictDoUpdate({
      target: instanceSettings.singletonKey,
      set: {
        general: {},
        experimental: {
          enableWorktreeRunExecution: true,
          worktreeRunExecutionActivatedAt: cutoff.toISOString(),
          worktreeRunExecutionActivationInstanceId: instanceId,
        },
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

  // fork law (see "keeps a routine run open when the execution issue is blocked"): a blocked
  // execution issue keeps its routine run ACTIVE (issue_created); blocked is never recorded as
  // a run failure. Upstream's "clears transient routine run failures when execution issues
  // resume" / "moves transient routine run failures into completion context" assumed the run
  // flips to failed on blocked. They are re-pinned here as the inherited-marker form: a run an
  // earlier build (or upstream) marked failed for a blocked issue is cleared — clearedAt
  // stamped on the transientFailure marker — and the marker survives into completion context.
  it("clears an inherited transient routine run failure while the blocked execution issue stays open and resumes", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const runId = randomUUID();
    const executionIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "blocked",
      // fork blocked-gate: a blocked issue needs a sanctioned wait path (blocker relation,
      // externalWait, or a validated unblockDescriptor) — upstream fixtures create it bare.
      unblockDescriptor: { owner: "board", action: "Confirm the routine execution may resume." },
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: runId,
    });

    // What an earlier build wrote when the issue entered blocked: failed + marker.
    await db.insert(routineRuns).values({
      id: runId,
      companyId,
      routineId: routine.id,
      source: "manual",
      status: "failed",
      failureReason: "Execution issue moved to blocked",
      triggeredAt: new Date("2026-07-16T12:00:00.000Z"),
      completedAt: new Date("2026-07-16T12:05:00.000Z"),
      linkedIssueId: executionIssue.id,
      triggerPayload: {
        transientFailure: {
          code: "execution_issue_status",
          status: "blocked",
          reason: "Execution issue moved to blocked",
        },
      },
    });

    // Still blocked: the fork keeps the run active and clears the inherited failure.
    await svc.syncRunStatusForIssue(executionIssue.id);
    const [blockedRun] = await db.select().from(routineRuns).where(eq(routineRuns.id, runId));
    expect(blockedRun).toMatchObject({
      status: "issue_created",
      failureReason: null,
      completedAt: null,
      triggerPayload: {
        transientFailure: {
          code: "execution_issue_status",
          status: "blocked",
          clearedAt: expect.any(String),
        },
      },
    });
    expect(blockedRun?.status).not.toBe("failed");
    const clearedAt = (blockedRun?.triggerPayload as { transientFailure?: { clearedAt?: string } } | null)
      ?.transientFailure?.clearedAt;
    expect(clearedAt).toEqual(expect.any(String));

    // Resuming keeps the run active and does not re-stamp clearedAt.
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, executionIssue.id));
    await svc.syncRunStatusForIssue(executionIssue.id);
    const [run] = await db.select().from(routineRuns).where(eq(routineRuns.id, runId));
    expect(run).toMatchObject({
      status: "issue_created",
      failureReason: null,
      completedAt: null,
      triggerPayload: {
        transientFailure: {
          code: "execution_issue_status",
          status: "blocked",
          clearedAt,
        },
      },
    });

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, executionIssue.id));
    await svc.syncRunStatusForIssue(executionIssue.id);

    const [completedRun] = await db.select().from(routineRuns).where(eq(routineRuns.id, runId));
    expect(completedRun).toMatchObject({
      status: "completed",
      failureReason: null,
      triggerPayload: {
        transientFailure: {
          code: "execution_issue_status",
          status: "blocked",
          clearedAt,
        },
      },
    });
    expect(completedRun?.completedAt).toBeInstanceOf(Date);
  });

  it("moves a legacy transient routine run failure into completion context", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const runId = randomUUID();
    const executionIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "blocked",
      // fork blocked-gate: a blocked issue needs a sanctioned wait path (blocker relation,
      // externalWait, or a validated unblockDescriptor) — upstream fixtures create it bare.
      unblockDescriptor: { owner: "board", action: "Confirm the routine execution may resume." },
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: runId,
    });

    // Legacy form: failed + failureReason only, no transientFailure marker in the payload.
    await db.insert(routineRuns).values({
      id: runId,
      companyId,
      routineId: routine.id,
      source: "manual",
      status: "failed",
      failureReason: "Execution issue moved to blocked",
      triggeredAt: new Date("2026-07-16T12:00:00.000Z"),
      completedAt: new Date("2026-07-16T12:05:00.000Z"),
      linkedIssueId: executionIssue.id,
      triggerPayload: { input: "preserved" },
    });

    // Still blocked: fork keeps the run active; the legacy reason becomes a cleared marker.
    await svc.syncRunStatusForIssue(executionIssue.id);
    const [blockedRun] = await db.select().from(routineRuns).where(eq(routineRuns.id, runId));
    expect(blockedRun).toMatchObject({
      status: "issue_created",
      failureReason: null,
      completedAt: null,
      triggerPayload: {
        input: "preserved",
        transientFailure: {
          code: "execution_issue_status",
          status: "blocked",
          reason: "Execution issue moved to blocked",
          clearedAt: expect.any(String),
        },
      },
    });
    expect(blockedRun?.status).not.toBe("failed");

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, executionIssue.id));
    await svc.syncRunStatusForIssue(executionIssue.id);

    const [run] = await db.select().from(routineRuns).where(eq(routineRuns.id, runId));
    expect(run).toMatchObject({
      status: "completed",
      failureReason: null,
      triggerPayload: {
        input: "preserved",
        transientFailure: {
          code: "execution_issue_status",
          status: "blocked",
          reason: "Execution issue moved to blocked",
        },
      },
    });
    expect(run?.completedAt).toBeInstanceOf(Date);
    expect(run?.triggerPayload).toMatchObject({
      transientFailure: { clearedAt: expect.any(String) },
    });
  });

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

  it("fires for a human comment and ignores inbox bookkeeping activity", async () => {
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
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.inbox_touched",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date(windowStart.getTime() + 3_000),
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
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.inbox_touched",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date(windowStart.getTime() + 3_000),
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

  it.each(["backlog", "todo", "in_progress", "in_review", "blocked"] as const)("coalesces scheduled beats onto an open %s routine instance (TSMC-20875)", async (status) => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status,
      // fork blocked-gate: the blocked variant needs a sanctioned wait path to be creatable.
      ...(status === "blocked"
        ? { unblockDescriptor: { owner: "board", action: "Confirm the routine instance may resume." } }
        : {}),
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

    // An open routine instance is always the concurrency anchor, even when its
    // originating heartbeat has ended. Each scheduled tick must update that
    // instance rather than creating a sibling.
    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue?.id).toBe(previousIssue.id);

    const runs = await Promise.all([
      svc.runRoutine(routine.id, { source: "schedule" }),
      svc.runRoutine(routine.id, { source: "schedule" }),
      svc.runRoutine(routine.id, { source: "schedule" }),
    ]);
    expect(runs).toEqual(
      Array.from({ length: 3 }, () => expect.objectContaining({
        status: "coalesced",
        linkedIssueId: previousIssue.id,
      })),
    );

    const routineIssues = await db
      .select({
        id: issues.id,
        originRunId: issues.originRunId,
      })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(previousIssue.id);

    const notes = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, previousIssue.id));
    expect(notes).toHaveLength(3);
    expect(notes.every((note) => note.body.includes(`remains ${status}`))).toBe(true);
  });

  it("derives the company primary project for a routine created without a project", async () => {
    const { companyId, projectId, svc } = await seedFixture();

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

    expect(routine.projectId).toBe(projectId);
    expect(routine.assigneeAgentId).toBeNull();
    expect(routine.status).toBe("paused");
  });

  it("serializes routine detail with assignee identity but without protected agent configuration", async () => {
    const { agentId, companyId, routine, svc } = await seedFixture();
    const sentinelSecret = "routine-assignee-secret-sentinel";
    await db
      .update(agents)
      .set({
        adapterConfig: {
          env: {
            ROUTINE_ASSIGNEE_SECRET: { type: "plain", value: sentinelSecret },
          },
        },
        runtimeConfig: {
          modelProfiles: {
            cheap: {
              adapterConfig: {
                env: {
                  ROUTINE_ASSIGNEE_RUNTIME_SECRET: { type: "plain", value: sentinelSecret },
                },
              },
            },
          },
        },
      })
      .where(eq(agents.id, agentId));
    const { trigger } = await svc.createTrigger(routine.id, {
      kind: "schedule",
      label: "Daily",
      cronExpression: "0 10 * * *",
      timezone: "UTC",
    }, {});

    const detail = await svc.getDetail(routine.id);

    expect(detail).toMatchObject({
      id: routine.id,
      companyId,
      title: "ascii frog",
      assignee: {
        id: agentId,
        name: "CodexCoder",
        role: "engineer",
        title: null,
        urlKey: "codexcoder",
      },
      triggers: [{
        id: trigger.id,
        kind: "schedule",
        label: "Daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }],
    });
    expect(detail?.assignee).toEqual({
      id: agentId,
      name: "CodexCoder",
      role: "engineer",
      title: null,
      urlKey: "codexcoder",
    });

    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(sentinelSecret);
    expect(serialized).not.toContain("adapterConfig");
    expect(serialized).not.toContain("runtimeConfig");
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
    expect(initialRevisions[0]?.snapshot.routine.activityGatePolicy).toBe("always");
    expect(initialRevisions[0]?.snapshot.routine.activityGateScope).toBe("company");

    const updated = await svc.update(
      routine.id,
      {
        description: "Run the frog routine with logs",
        activityGatePolicy: "require_external_activity",
        activityGateScope: "project",
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
        activityGatePolicy: "require_external_activity",
        activityGateScope: "project",
        baseRevisionId: updated?.latestRevisionId,
      },
      {},
    );
    expect(noOp?.latestRevisionId).toBe(updated?.latestRevisionId);
    expect(noOp?.latestRevisionNumber).toBe(2);

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([2, 1]);
    expect(revisions[0]?.snapshot.routine.description).toBe("Run the frog routine with logs");
    expect(revisions[0]?.snapshot.routine.activityGatePolicy).toBe("require_external_activity");
    expect(revisions[0]?.snapshot.routine.activityGateScope).toBe("project");
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
    const revision2Routine = await svc.update(routine.id, {
      description: "revision 2",
      activityGatePolicy: "require_external_activity",
      activityGateScope: "project",
    }, {});

    const restored = await svc.restoreRevision(routine.id, revision1Id, {});

    expect(restored.restoredFromRevisionId).toBe(revision1Id);
    expect(restored.restoredFromRevisionNumber).toBe(1);
    expect(restored.routine.latestRevisionNumber).toBe(3);
    expect(restored.routine.latestRevisionId).not.toBe(revision2Routine?.latestRevisionId);
    expect(restored.routine.description).toBe("Run the frog routine");
    expect(restored.routine.activityGatePolicy).toBe("always");
    expect(restored.routine.activityGateScope).toBe("company");
    expect(restored.revision.restoredFromRevisionId).toBe(revision1Id);
    expect(restored.revision.snapshot.routine.description).toBe("Run the frog routine");

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([3, 2, 1]);
    await expect(db.select().from(routineRuns).where(eq(routineRuns.id, run.id))).resolves.toHaveLength(1);
  });

  it("defaults activity gates when restoring a legacy routine revision snapshot", async () => {
    const { routine, svc } = await seedFixture();
    const revision1Id = routine.latestRevisionId!;
    const [revision1] = await db.select().from(routineRevisions).where(eq(routineRevisions.id, revision1Id));
    const legacySnapshot = structuredClone(revision1!.snapshot) as { routine: Record<string, unknown> };
    delete legacySnapshot.routine.activityGatePolicy;
    delete legacySnapshot.routine.activityGateScope;
    await db.update(routineRevisions).set({ snapshot: legacySnapshot }).where(eq(routineRevisions.id, revision1Id));
    await svc.update(routine.id, {
      activityGatePolicy: "require_external_activity",
      activityGateScope: "project",
    }, {});

    const restored = await svc.restoreRevision(routine.id, revision1Id, {});

    expect(restored.routine.activityGatePolicy).toBe("always");
    expect(restored.routine.activityGateScope).toBe("company");
    expect(restored.revision.snapshot.routine.activityGatePolicy).toBe("always");
    expect(restored.revision.snapshot.routine.activityGateScope).toBe("company");
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
      expect.objectContaining({
        agentId,
        opts: expect.objectContaining({
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: run.linkedIssueId, mutation: "create" },
          requestedByActorType: undefined,
          requestedByActorId: null,
          contextSnapshot: { issueId: run.linkedIssueId, source: "routine.dispatch" },
        }),
      }),
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
      db.select().from(activityLog).where(eq(activityLog.entityId, previousIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.inbox_touched",
        entityType: "issue",
        entityId: previousIssue.id,
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
      db.select().from(activityLog).where(eq(activityLog.entityId, previousIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.inbox_touched",
        entityType: "issue",
        entityId: previousIssue.id,
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

  it("persists pause reason and paused timestamp when a routine is manually paused", async () => {
    const { routine, svc } = await seedFixture();

    const paused = await svc.update(
      routine.id,
      { status: "paused", pauseReason: "watchdog: routine_failure_rate tripped" },
      {},
    );
    const detail = await svc.getDetail(routine.id);

    expect(paused?.status).toBe("paused");
    expect(paused?.pauseReason).toBe("watchdog: routine_failure_rate tripped");
    expect(paused?.pausedAt).toBeInstanceOf(Date);
    expect(detail?.pauseReason).toBe("watchdog: routine_failure_rate tripped");
    expect(detail?.pausedAt).toBeInstanceOf(Date);

    const resumed = await svc.update(routine.id, { status: "active" }, {});
    expect(resumed?.status).toBe("active");
    expect(resumed?.pauseReason).toBeNull();
    expect(resumed?.pausedAt).toBeNull();
  });

  it("backfills a paused timestamp when a legacy paused routine is paused again with a reason", async () => {
    const { routine, svc } = await seedFixture();

    const initiallyPaused = await svc.update(routine.id, { status: "paused" }, {});
    expect(initiallyPaused?.status).toBe("paused");

    await db
      .update(routines)
      .set({ pauseReason: null, pausedAt: null })
      .where(eq(routines.id, routine.id));

    const repaired = await svc.update(
      routine.id,
      { status: "paused", pauseReason: "watchdog: routine_failure_rate tripped" },
      {},
    );

    expect(repaired?.status).toBe("paused");
    expect(repaired?.pauseReason).toBe("watchdog: routine_failure_rate tripped");
    expect(repaired?.pausedAt).toBeInstanceOf(Date);

    const detail = await svc.getDetail(routine.id);
    expect(detail?.pauseReason).toBe("watchdog: routine_failure_rate tripped");
    expect(detail?.pausedAt).toBeInstanceOf(Date);
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

  it("absorbs handshake and liveness-only courier traffic without creating a destination issue", async () => {
    const { routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(routine.id, { kind: "webhook", signingMode: "none" }, {});

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { kind: "handshake", sourceIssue: "TSMC-18772" },
    });

    expect(run).toMatchObject({ status: "skipped", linkedIssueId: null, deliveryReceipt: null });
    expect(run.failureReason).toBe("machine_handshake");
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.originId, routine.id))).toHaveLength(0);
  });

  it("creates one receipted destination for the Phorest courier retry", async () => {
    const { routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(routine.id, { kind: "webhook", signingMode: "none" }, {});
    const payload = {
      kind: "portfolio_directive",
      ask: "Create the corrected TSR-4927 route.",
      sourceIssue: "TSMC-18772",
    };

    const first = await svc.firePublicTrigger(trigger.publicId!, {
      idempotencyKey: "phorest-TSMC-18772",
      payload,
    });
    const retry = await svc.firePublicTrigger(trigger.publicId!, {
      idempotencyKey: "phorest-TSMC-18772",
      payload,
    });

    expect(first).toMatchObject({ status: "issue_created", linkedIssueId: expect.any(String) });
    expect(first.deliveryReceipt).toMatchObject({
      idempotencyKey: "phorest-TSMC-18772",
      destinationIssueId: first.linkedIssueId,
      createReceipt: { destinationIssueId: first.linkedIssueId },
    });
    expect(retry.deliveryReceipt).toEqual(first.deliveryReceipt);
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.originId, routine.id))).toHaveLength(1);
  });

  it("derives a stable courier key and leaves a failed receipt delivery retryable", async () => {
    const { companyId, routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(routine.id, { kind: "webhook", signingMode: "none" }, {});
    const payload = { kind: "portfolio_directive", ask: "Deliver TSR-4927.", sourceIssue: "TSMC-18772" };

    const first = await svc.firePublicTrigger(trigger.publicId!, { payload });
    const reordered = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { sourceIssue: "TSMC-18772", ask: "Deliver TSR-4927.", kind: "portfolio_directive" },
    });
    expect(first.idempotencyKey).toMatch(/^courier:[0-9a-f]{64}$/);
    expect(reordered.idempotencyKey).toBe(first.idempotencyKey);

    // Give the receipt-return recovery its own destination lifecycle; the
    // preceding derived-key assertion intentionally left its task live.
    await db
      .update(issues)
      .set({ status: "done", executionRunId: null, executionLockedAt: null, completedAt: new Date() })
      .where(eq(issues.id, first.linkedIssueId!));

    const retryKey = "TSR-4927-receipt-retry";
    await db.insert(routineRuns).values({
      companyId,
      routineId: routine.id,
      triggerId: trigger.id,
      source: "webhook",
      status: "failed",
      idempotencyKey: retryKey,
      failureReason: "receipt callback unavailable",
    });
    const recovered = await svc.firePublicTrigger(trigger.publicId!, { idempotencyKey: retryKey, payload });
    expect(recovered).toMatchObject({ status: "issue_created", failureReason: null });
    expect(recovered.deliveryReceipt).toMatchObject({ idempotencyKey: retryKey, destinationIssueId: recovered.linkedIssueId });
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.originId, routine.id))).toHaveLength(2);
  });

  it("rejects an HMAC webhook replay inside the accepted timestamp window", async () => {
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

    const payload = { event: "acceptance" };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestampSeconds = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(`${timestampSeconds}.`)
      .update(rawBody)
      .digest("hex")}`;
    const request = {
      signatureHeader: signature,
      timestampHeader: timestampSeconds,
      rawBody,
      payload,
    };

    await expect(svc.firePublicTrigger(trigger.publicId!, request)).resolves.toMatchObject({
      source: "webhook",
      status: "issue_created",
    });
    await expect(svc.firePublicTrigger(trigger.publicId!, request)).rejects.toThrow(
      "Webhook replay detected",
    );

    const runs = await db
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(eq(routineRuns.triggerId, trigger.id));
    expect(runs).toHaveLength(1);
  });

  it("serializes concurrent HMAC webhook replays", async () => {
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

    const payload = { event: "concurrent" };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestampSeconds = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(`${timestampSeconds}.`)
      .update(rawBody)
      .digest("hex")}`;
    const request = {
      signatureHeader: signature,
      timestampHeader: timestampSeconds,
      rawBody,
      payload,
    };

    const results = await Promise.allSettled([
      svc.firePublicTrigger(trigger.publicId!, request),
      svc.firePublicTrigger(trigger.publicId!, request),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      message: "Webhook replay detected",
    });
    expect(await db.select().from(routineRuns).where(eq(routineRuns.triggerId, trigger.id))).toHaveLength(1);
  });

  it("rejects an HMAC webhook replay when automatic execution is suppressed", async () => {
    const runtimeEnv = { PAPERCLIP_IN_WORKTREE: "yes", PAPERCLIP_INSTANCE_ID: "worktree-routines-test" };
    const { routine, svc } = await seedFixture({ runtimeEnv });
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "hmac_sha256",
        replayWindowSec: 300,
      },
      {},
    );

    const payload = { event: "suppressed" };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestampSeconds = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(`${timestampSeconds}.`)
      .update(rawBody)
      .digest("hex")}`;
    const request = {
      signatureHeader: signature,
      timestampHeader: timestampSeconds,
      rawBody,
      payload,
    };

    await expect(svc.firePublicTrigger(trigger.publicId!, request)).resolves.toMatchObject({
      status: "skipped",
      failureReason: "worktree_execution_cutoff",
    });
    await expect(svc.firePublicTrigger(trigger.publicId!, request)).rejects.toThrow(
      "Webhook replay detected",
    );
    expect(await db.select().from(routineRuns).where(eq(routineRuns.triggerId, trigger.id))).toHaveLength(1);
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

  it("ignores non-actionable probe webhook payloads instead of creating execution issues", async () => {
    const { routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const payload = { type: "binding_probe", probeRunId: "probe-1" };
    const first = await svc.firePublicTrigger(trigger.publicId!, { payload });
    const second = await svc.firePublicTrigger(trigger.publicId!, { payload });

    expect(first).toMatchObject({
      source: "webhook",
      status: "skipped",
      linkedIssueId: null,
      failureReason: "binding_probe",
    });
    expect(second).toMatchObject({
      source: "webhook",
      status: "skipped",
      linkedIssueId: null,
      failureReason: "binding_probe",
    });

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(0);
  });

  it("returns a durable idempotent courier receipt only after one destination issue exists", async () => {
    const { companyId, routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(routine.id, { kind: "webhook", signingMode: "none" }, {});

    const ignored = await svc.firePublicTrigger(trigger.publicId!, {
      idempotencyKey: "phorest-TSMC-18772",
      payload: { kind: "handshake", sourceIssue: "TSMC-18772" },
    });
    expect(ignored).toMatchObject({ status: "skipped", linkedIssueId: null, deliveryReceipt: null });

    const payload = { kind: "portfolio_directive", ask: "Create the corrected TSR-4927 route.", sourceIssue: "TSMC-18772" };
    const first = await svc.firePublicTrigger(trigger.publicId!, {
      idempotencyKey: "phorest-TSMC-18772",
      payload,
    });
    const second = await svc.firePublicTrigger(trigger.publicId!, {
      idempotencyKey: "phorest-TSMC-18772",
      payload,
    });

    expect(first.status).toBe("issue_created");
    expect(first.deliveryReceipt).toMatchObject({
      idempotencyKey: "phorest-TSMC-18772",
      destinationIssueId: first.linkedIssueId,
      createReceipt: { destinationIssueId: first.linkedIssueId },
    });
    expect(second.deliveryReceipt).toEqual(first.deliveryReceipt);

    const destinationIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));
    expect(destinationIssues).toHaveLength(1);
    expect(first.deliveryReceipt).not.toBeNull();
  });

  it("keeps failed courier delivery retryable and never marks an unreceipted courier routed", async () => {
    const { companyId, routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(routine.id, { kind: "webhook", signingMode: "none" }, {});
    const idempotencyKey = "TSR-4927-corrected-route";
    const payload = {
      kind: "portfolio_directive",
      ask: "Deliver corrected route.",
      sourceIssue: "TSMC-18772",
    };

    await db.insert(routineRuns).values({
      companyId,
      routineId: routine.id,
      triggerId: trigger.id,
      source: "webhook",
      status: "failed",
      idempotencyKey,
      failureReason: "receipt callback unavailable",
    });
    const retry = await svc.firePublicTrigger(trigger.publicId!, { idempotencyKey, payload });
    expect(retry).toMatchObject({ status: "issue_created", failureReason: null });
    expect(retry.deliveryReceipt).toMatchObject({ idempotencyKey, destinationIssueId: retry.linkedIssueId });
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.originId, routine.id))).toHaveLength(1);
  });

  it("derives a stable idempotency key for an unkeyed courier so retries fold to one task", async () => {
    const { routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(routine.id, { kind: "webhook", signingMode: "none" }, {});
    const payload = {
      kind: "portfolio_directive",
      ask: "Deliver corrected route.",
      sourceIssue: "TSMC-18772",
    };

    // Requiring the CALLER to supply a key was a breaking wire-contract change:
    // no existing sender sends one, so every actionable portfolio_directive
    // started 422-ing. An unkeyed courier now gets a key derived from its
    // canonical payload instead of being rejected.
    const first = await svc.firePublicTrigger(trigger.publicId!, { payload });
    expect(first.idempotencyKey).toMatch(/^courier:[0-9a-f]{64}$/);

    // Same envelope -> same derived key -> exactly one destination task, which is
    // the TSMC-19355 guarantee the key exists to enforce.
    const repeat = await svc.firePublicTrigger(trigger.publicId!, { payload });
    expect(repeat.idempotencyKey).toBe(first.idempotencyKey);
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.originId, routine.id))).toHaveLength(1);

    // Key order in the payload must not change the hash, or a retry that
    // serialized its JSON differently would duplicate the destination task.
    const reordered = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { sourceIssue: "TSMC-18772", kind: "portfolio_directive", ask: "Deliver corrected route." },
    });
    expect(reordered.idempotencyKey).toBe(first.idempotencyKey);
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.originId, routine.id))).toHaveLength(1);
  });

  it("ignores preflight and handshake webhook payloads instead of creating execution issues", async () => {
    const { routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const preflight = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { kind: "preflight", _preflight: true, probeRunId: "preflight-1" },
    });
    const handshake = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { kind: "handshake", sourceCompany: "TSC", selfCancel: true },
    });

    expect(preflight).toMatchObject({
      source: "webhook",
      status: "skipped",
      linkedIssueId: null,
      failureReason: "preflight",
    });
    expect(handshake).toMatchObject({
      source: "webhook",
      status: "skipped",
      linkedIssueId: null,
      failureReason: "machine_handshake",
    });

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(0);
  });

  it("filters CTO MC inbound triggerPayloads before any CEO handoff", async () => {
    const { agentId, companyId, routine, svc, wakeups } = await seedFixture();
    const ceoId = randomUUID();
    await db.update(agents).set({ role: "cto" }).where(eq(agents.id, agentId));
    await db.insert(agents).values({
      id: ceoId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(routine.id, { kind: "webhook", signingMode: "none" }, {});

    for (const payload of [
      { type: "handshake" },
      { type: "binding_probe" },
      { _binding_probe: true },
      { type: "keepalive" },
    ]) {
      const run = await svc.firePublicTrigger(trigger.publicId!, { payload });
      const executionIssue = await db.select().from(issues).where(eq(issues.id, run.linkedIssueId!)).then((rows) => rows[0]);
      expect(run).toMatchObject({ status: "issue_created", linkedIssueId: expect.any(String) });
      expect(executionIssue?.status).toBe("done");
      expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.parentId, run.linkedIssueId!))).toHaveLength(0);
    }

    const secretUrl = "https://hooks.example.internal/callback?token=never-leak";
    const secretToken = "pc_live_secret_should_never_leak_to_ceo";
    for (const type of ["portfolio_directive", "portfolio_input_request", "approval_request", "escalation", "clarification"]) {
      const run = await svc.firePublicTrigger(trigger.publicId!, {
        payload: {
          type,
          summary: `CEO action: ${type}`,
          callbackUrl: secretUrl,
          bearerToken: secretToken,
        },
      });
      const executionIssue = await db.select().from(issues).where(eq(issues.id, run.linkedIssueId!)).then((rows) => rows[0]);
      const handoffs = await db.select().from(issues).where(eq(issues.parentId, run.linkedIssueId!));
      expect(executionIssue?.status).toBe("done");
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]).toMatchObject({ assigneeAgentId: ceoId, originKind: "mc_inbound_ceo_handoff" });
      expect(handoffs[0]?.description).toContain(executionIssue?.identifier);
      expect(handoffs[0]?.description).not.toContain(secretUrl);
      expect(handoffs[0]?.description).not.toContain(secretToken);
    }

    const unknown = await svc.firePublicTrigger(trigger.publicId!, { payload: { type: "runtime_diagnostic" } });
    const unknownExecution = await db.select().from(issues).where(eq(issues.id, unknown.linkedIssueId!)).then((rows) => rows[0]);
    expect(unknownExecution?.status).toBe("todo");
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.parentId, unknown.linkedIssueId!))).toHaveLength(0);
    expect(wakeups.every((wakeup) => wakeup.agentId === ceoId || wakeup.agentId === agentId)).toBe(true);
  });

  it("ignores receipt-ack traffic and loosely encoded probe flags instead of creating execution issues", async () => {
    const { routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const ack = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { type: "directive_receipt_ack", from: "thiaa-recruitment", revisionId: 5 },
    });
    const stringProbe = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { kind: "portfolio_directive", _binding_probe: "true", probeRunId: "probe-2" },
    });

    expect(ack).toMatchObject({
      source: "webhook",
      status: "skipped",
      linkedIssueId: null,
      failureReason: "directive_receipt_ack",
    });
    expect(stringProbe).toMatchObject({
      source: "webhook",
      status: "skipped",
      linkedIssueId: null,
      failureReason: "binding_probe",
    });

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(0);
  });

  it("ignores empty directive webhook payloads while preserving actionable directives", async () => {
    const { routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const ignored = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { kind: "portfolio_directive", type: "portfolio_directive", context: { sourceCompany: "TSC" } },
    });
    const actionable = await svc.firePublicTrigger(trigger.publicId!, {
      payload: {
        kind: "portfolio_directive",
        type: "portfolio_directive",
        ask: "Patch the review churn guardrail.",
        why: "This is actionable.",
      },
    });

    expect(ignored).toMatchObject({
      source: "webhook",
      status: "skipped",
      linkedIssueId: null,
      failureReason: "empty_directive",
    });
    expect(actionable.status).toBe("issue_created");
    expect(actionable.linkedIssueId).toBeTruthy();
  });

  it("folds duplicate always_enqueue webhook fires that share a dispatch fingerprint", async () => {
    const { routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const payload = { type: "portfolio_status", from: "thiaa-recruitment", summaryId: "status-1" };
    const first = await svc.firePublicTrigger(trigger.publicId!, { payload });
    const second = await svc.firePublicTrigger(trigger.publicId!, { payload });

    expect(first.source).toBe("webhook");
    expect(first.status).toBe("issue_created");
    expect(second.source).toBe("webhook");
    expect(second.status).toBe("coalesced");
    expect(second.linkedIssueId).toBe(first.linkedIssueId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(first.linkedIssueId);
  });

  it("spawns fresh execution issues only for actionable heterogeneous always_enqueue webhook fires (TSMC-10038)", async () => {
    const { routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const first = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { type: "portfolio_status", from: "thiaa-recruitment", summaryId: "status-1" },
    });
    const second = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { type: "portfolio_status", from: "thiaaaaa-kiss", summaryId: "ks-2026-06-15" },
    });
    const third = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { type: "ask_reply", from: "thiaaaa-pod", askId: "fallback-monitor" },
    });

    for (const run of [first, second, third]) {
      expect(run.source).toBe("webhook");
      expect(run.status).toBe("issue_created");
    }
    const linkedIds = new Set([first.linkedIssueId, second.linkedIssueId, third.linkedIssueId]);
    expect(linkedIds.size).toBe(3);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));
    expect(routineIssues).toHaveLength(3);
  });

  it("does not absorb a heterogeneous always_enqueue fire behind a blocked anchor (TSMC-10038)", async () => {
    const { routine, svc } = await seedFixture();
    await svc.update(routine.id, { concurrencyPolicy: "always_enqueue" }, {});
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const anchor = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { type: "portfolio_status", from: "tsd", summaryId: "tsd-halt-9576" },
    });
    expect(anchor.status).toBe("issue_created");
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, anchor.linkedIssueId!));

    const followUp = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { type: "ask_reply", from: "thiaa-recruitment", askId: "revision-8" },
    });

    expect(followUp.status).toBe("issue_created");
    expect(followUp.linkedIssueId).not.toBe(anchor.linkedIssueId);
  });

  it("reopens a routine run when the execution issue returns to an open status", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const issue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      // Entering blocked without a first-class blocker requires an explicit external gate.
      description: `${routine.description}\n\nExternal owner: board operator\nExternal action: fixture gate for blocked routine execution.`,
      status: "blocked",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      executionPolicy: {
        externalWait: {
          owner: "board operator",
          action: "fixture gate for blocked routine execution",
          nextCheckAt: "2026-03-21T12:00:00.000Z",
          monitorOwner: "routine fixture",
        },
      },
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
    });

    await db.insert(routineRuns).values({
      id: issue.originRunId!,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "failed",
      failureReason: "Execution issue moved to blocked",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: issue.id,
      completedAt: new Date("2026-03-20T12:05:00.000Z"),
    });

    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issue.id));
    const synced = await svc.syncRunStatusForIssue(issue.id);

    expect(synced).toMatchObject({
      id: issue.originRunId,
      status: "issue_created",
      failureReason: null,
      completedAt: null,
    });
  });

  it("keeps a routine run open when the execution issue is blocked", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const issue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      // Entering blocked without a first-class blocker requires an explicit external gate.
      description: `${routine.description}\n\nExternal owner: board operator\nExternal action: fixture gate for blocked routine execution.`,
      status: "blocked",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      executionPolicy: {
        externalWait: {
          owner: "board operator",
          action: "fixture gate for blocked routine execution",
          nextCheckAt: "2026-03-21T12:00:00.000Z",
          monitorOwner: "routine fixture",
        },
      },
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
    });

    await db.insert(routineRuns).values({
      id: issue.originRunId!,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      failureReason: null,
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: issue.id,
      completedAt: null,
    });

    const synced = await svc.syncRunStatusForIssue(issue.id);

    expect(synced).toMatchObject({
      id: issue.originRunId,
      status: "issue_created",
      failureReason: null,
      completedAt: null,
    });
  });

  it("clears stale failure metadata when a routine execution issue eventually closes done", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const issue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "done",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
    });

    await db.insert(routineRuns).values({
      id: issue.originRunId!,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "completed",
      failureReason: "Execution issue moved to blocked",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: issue.id,
      completedAt: new Date("2026-03-20T12:05:00.000Z"),
    });

    const synced = await svc.syncRunStatusForIssue(issue.id);

    expect(synced).toMatchObject({
      id: issue.originRunId,
      status: "completed",
      failureReason: null,
    });
    expect(synced?.completedAt).toBeTruthy();
  });

  it("records a cancelled execution issue as a cancelled run, not a failure", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const issue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "cancelled",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
    });

    await db.insert(routineRuns).values({
      id: issue.originRunId!,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "webhook",
      status: "issue_created",
      failureReason: null,
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: issue.id,
      completedAt: null,
    });

    const synced = await svc.syncRunStatusForIssue(issue.id);

    // A superseded/coalesced duplicate is benign churn — it must not pollute the
    // failed-run surfaces with status="failed" + "moved to cancelled".
    expect(synced).toMatchObject({
      id: issue.originRunId,
      status: "cancelled",
      failureReason: null,
    });
    expect(synced?.status).not.toBe("failed");
    expect(synced?.completedAt).toBeTruthy();
  });

  it("leaves an already-synced terminal run untouched (no updatedAt churn)", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const issue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "cancelled",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
    });

    const completedAt = new Date("2026-03-20T12:05:00.000Z");
    await db.insert(routineRuns).values({
      id: issue.originRunId!,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "webhook",
      status: "cancelled",
      failureReason: null,
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: issue.id,
      completedAt,
    });

    const before = await db
      .select({ updatedAt: routineRuns.updatedAt, completedAt: routineRuns.completedAt })
      .from(routineRuns)
      .where(eq(routineRuns.id, issue.originRunId!))
      .then((rows) => rows[0]);

    const synced = await svc.syncRunStatusForIssue(issue.id);

    const after = await db
      .select({ updatedAt: routineRuns.updatedAt, completedAt: routineRuns.completedAt })
      .from(routineRuns)
      .where(eq(routineRuns.id, issue.originRunId!))
      .then((rows) => rows[0]);

    expect(synced?.status).toBe("cancelled");
    // Idempotent: a matching terminal run is not rewritten, so updatedAt and the
    // original completedAt are preserved.
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
    expect(after?.completedAt?.getTime()).toBe(completedAt.getTime());
  });

  it("auto-hides a clean no-op routine execution issue when it closes done", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const issue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "done",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
    });

    await db.insert(routineRuns).values({
      id: issue.originRunId!,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "completed",
      failureReason: null,
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: issue.id,
      completedAt: new Date("2026-03-20T12:05:00.000Z"),
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: issue.id,
      body: "Fallback monitor: no usage-limit failures detected in the last 20m (checked 4 failed runs) and no paused primaries with stranded open issues.",
    });

    const synced = await svc.syncRunStatusForIssue(issue.id);
    expect(synced?.status).toBe("completed");

    const refreshedIssue = await db
      .select({ hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0] ?? null);
    expect(refreshedIssue?.hiddenAt).toBeTruthy();
  });

  it("keeps an actioned routine execution issue visible when it closes done", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const issue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "done",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
    });

    await db.insert(routineRuns).values({
      id: issue.originRunId!,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "completed",
      failureReason: null,
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: issue.id,
      completedAt: new Date("2026-03-20T12:05:00.000Z"),
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: issue.id,
      body: "Fallback monitor: detected usage-limit failures and/or paused primaries and reassigned issues.\n- primary `agent-1` → sisters `agent-2` (session limit) until `2026-03-20T12:30:00.000Z` (runId `run-1`): TSMC-1 → `agent-2`",
    });

    const synced = await svc.syncRunStatusForIssue(issue.id);
    expect(synced?.status).toBe("completed");

    const refreshedIssue = await db
      .select({ hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0] ?? null);
    expect(refreshedIssue?.hiddenAt).toBeNull();
  });

  // THIAAAAAA-203 / THIAAAAAA-2176: a webhook trigger's company_secret_bindings
  // join row can vanish while the secret itself stays live, which 422-rejects
  // OpCo callbacks. The fire handler must self-heal by recreating the binding
  // and retrying once, emitting an audit log line.
  it("self-heals a missing webhook binding on fire and retries successfully", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "bearer",
      },
      {},
    );
    expect(secretMaterial?.webhookSecret).toBeTruthy();

    // The binding exists immediately after trigger creation.
    await expect(
      db
        .select()
        .from(companySecretBindings)
        .where(eq(companySecretBindings.secretId, trigger.secretId!)),
    ).resolves.toHaveLength(1);

    // Simulate the THIAAAAAA-203 drop: delete the join row, leaving the secret live.
    await db.delete(companySecretBindings).where(eq(companySecretBindings.secretId, trigger.secretId!));
    await expect(
      db
        .select()
        .from(companySecretBindings)
        .where(eq(companySecretBindings.secretId, trigger.secretId!)),
    ).resolves.toHaveLength(0);

    const warnSpy = vi.spyOn(logger, "warn");
    try {
      const run = await svc.firePublicTrigger(trigger.publicId!, {
        authorizationHeader: `Bearer ${secretMaterial!.webhookSecret}`,
        payload: { event: "binding.drop.recovered" },
      });

      // The fire succeeds on retry instead of 422-ing.
      expect(run.source).toBe("webhook");
      expect(run.status).toBe("issue_created");

      // An audit log line was emitted for the auto-repair.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: "webhook_binding_auto_repair", secretId: trigger.secretId }),
        expect.stringContaining("self-heal"),
      );
    } finally {
      warnSpy.mockRestore();
    }

    // The binding row was recreated with the canonical config path.
    const restored = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.secretId, trigger.secretId!));
    expect(restored).toHaveLength(1);
    expect(restored[0]?.configPath).toBe(`webhookSecret:${trigger.secretId}`);
    expect(restored[0]?.targetType).toBe("routine");
    expect(restored[0]?.targetId).toBe(routine.id);

    // A subsequent fire reuses the restored binding without crashing on conflict.
    const secondRun = await svc.firePublicTrigger(trigger.publicId!, {
      authorizationHeader: `Bearer ${secretMaterial!.webhookSecret}`,
      payload: { event: "binding.drop.recovered.again" },
    });
    expect(secondRun.source).toBe("webhook");
  });

  it("eagerly reconciles a missing webhook binding without waiting for a fire", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(routine.id, { kind: "webhook", signingMode: "bearer" }, {});
    await db.delete(companySecretBindings).where(eq(companySecretBindings.secretId, trigger.secretId!));
    await expect(
      db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, trigger.secretId!)),
    ).resolves.toHaveLength(0);

    const result = await svc.reconcileWebhookSecretBindings();
    expect(result.repaired).toBe(1);
    expect(result.triggerIds).toEqual([trigger.id]);

    const restored = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.secretId, trigger.secretId!));
    expect(restored).toHaveLength(1);
    expect(restored[0]?.configPath).toBe(`webhookSecret:${trigger.secretId}`);
    expect(restored[0]?.targetType).toBe("routine");
    expect(restored[0]?.targetId).toBe(routine.id);
  });

  it("leaves a missing binding alone when the underlying secret is not active", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(routine.id, { kind: "webhook", signingMode: "bearer" }, {});
    await db.delete(companySecretBindings).where(eq(companySecretBindings.secretId, trigger.secretId!));
    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, trigger.secretId!));

    const result = await svc.reconcileWebhookSecretBindings();
    expect(result.repaired).toBe(0);
    await expect(
      db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, trigger.secretId!)),
    ).resolves.toHaveLength(0);
  });

  it("reconcile is a no-op when all webhook bindings are present", async () => {
    const { routine, svc } = await seedFixture();
    await svc.createTrigger(routine.id, { kind: "webhook", signingMode: "bearer" }, {});
    const result = await svc.reconcileWebhookSecretBindings();
    expect(result.repaired).toBe(0);
  });

  it("reuses a terminal scheduled execution issue when terminal reuse mode is enabled", async () => {
    const { companyId, routine, svc, wakeups } = await seedFixture({ wakeup: async () => null });
    await svc.update(
      routine.id,
      {
        env: {
          PAPERCLIP_ROUTINE_ISSUE_MODE: { type: "plain", value: "reuse_terminal" },
        },
      },
      {},
    );
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

    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));

    const firstResult = await svc.tickScheduledTriggers(new Date());
    expect(firstResult.triggered).toBe(1);

    const [firstIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(firstIssue).toBeTruthy();

    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), executionRunId: null, executionLockedAt: null })
      .where(eq(issues.id, firstIssue!.id));
    await db.insert(issueComments).values({
      companyId,
      issueId: firstIssue!.id,
      body: "Fallback swap-back: no eligible reset-window state found.",
    });
    await svc.syncRunStatusForIssue(firstIssue!.id);

    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));

    const secondResult = await svc.tickScheduledTriggers(new Date());
    expect(secondResult.triggered).toBe(1);

    const routineIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(firstIssue!.id);
    expect(routineIssues[0]?.status).toBe("todo");
    expect(routineIssues[0]?.hiddenAt).toBeNull();

    const runs = (await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id)))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    expect(runs).toHaveLength(2);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[1]?.status).toBe("issue_reused");
    expect(new Set(runs.map((run) => run.linkedIssueId))).toEqual(new Set([firstIssue!.id]));
    expect(wakeups.map((wakeup) => wakeup.opts.payload?.mutation)).toEqual(["create", "update"]);

    const refreshedTrigger = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, trigger.id))
      .then((rows) => rows[0]);
    expect(refreshedTrigger?.lastResult).toMatch(/reused/i);
  });

  it("keeps a cancelled scheduled execution terminal and creates a linked replacement", async () => {
    const { companyId, routine, svc } = await seedFixture({ wakeup: async () => null });
    await svc.update(
      routine.id,
      {
        env: {
          PAPERCLIP_ROUTINE_ISSUE_MODE: { type: "plain", value: "reuse_terminal" },
        },
      },
      {},
    );
    const { trigger } = await svc.createTrigger(
      routine.id,
      { kind: "schedule", label: "daily", cronExpression: "0 0 * * *", timezone: "UTC" },
      {},
    );
    const pastDue = new Date("2020-01-01T00:00:00.000Z");
    await db.update(routineTriggers).set({ nextRunAt: pastDue }).where(eq(routineTriggers.id, trigger.id));
    await svc.tickScheduledTriggers(new Date());

    const [cancelledIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(cancelledIssue).toBeTruthy();
    await db
      .update(issues)
      .set({ status: "cancelled", cancelledAt: new Date(), executionRunId: null, executionLockedAt: null })
      .where(eq(issues.id, cancelledIssue!.id));
    await db.update(routineTriggers).set({ nextRunAt: pastDue }).where(eq(routineTriggers.id, trigger.id));

    await svc.tickScheduledTriggers(new Date());

    const routineIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId))
      .orderBy(issues.createdAt);
    expect(routineIssues).toHaveLength(2);
    expect(routineIssues[0]).toMatchObject({ id: cancelledIssue!.id, status: "cancelled" });
    expect(routineIssues[1]).toMatchObject({ status: "todo" });
    expect(routineIssues[1]?.description).toContain(
      `Replacement for cancelled routine execution ${cancelledIssue!.identifier}.`,
    );

    const latestRun = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id))
      .orderBy(routineRuns.createdAt)
      .then((rows) => rows.at(-1) ?? null);
    expect(latestRun).toMatchObject({ status: "issue_created", linkedIssueId: routineIssues[1]?.id });
  });

  it("coalesces a duplicate fallback-monitor create instead of failing the scheduled run", async () => {
    const { agentId, companyId, issueSvc, projectId, routine, svc } = await seedFixture({ wakeup: async () => null });
    await svc.update(routine.id, {
      title: "fallback-monitor",
      env: { PAPERCLIP_ROUTINE_ISSUE_MODE: { type: "plain", value: "reuse_terminal" } },
    }, {});
    const [fallbackRoutine] = await db.select().from(routines).where(eq(routines.id, routine.id));
    // Pre-seed an open rail under a different origin id so origin-keyed open
    // coalesce misses, forcing the create path. Title-keyed allowDuplicate=false
    // must still fold onto the existing card (TSMC-19799).
    const existing = await issueSvc.create(companyId, {
      projectId,
      title: "fallback-monitor",
      description: "Existing fallback-monitor execution.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: randomUUID(),
      originRunId: randomUUID(),
    });
    const result = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(result).toMatchObject({ status: "coalesced", linkedIssueId: existing.id });
    const routineIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.title, "fallback-monitor")));
    expect(routineIssues).toHaveLength(1);
    expect(fallbackRoutine?.title).toBe("fallback-monitor");
  });

  it("ignores terminal routine parents by default and reuses the terminal execution issue", async () => {
    const { companyId, routine, svc, wakeups } = await seedFixture({ wakeup: async () => null });
    const parentIssueId = randomUUID();
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Completed parent",
      status: "done",
      priority: "medium",
      completedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await svc.update(
      routine.id,
      {
        parentIssueId,
        env: {
          PAPERCLIP_ROUTINE_ISSUE_MODE: { type: "plain", value: "reuse_terminal" },
        },
      },
      {},
    );
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
    const terminalIssueId = randomUUID();
    await db.insert(issues).values({
      id: terminalIssueId,
      companyId,
      projectId: routine.projectId,
      goalId: routine.goalId,
      parentId: parentIssueId,
      title: routine.title,
      description: routine.description,
      status: "done",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
      originFingerprint: "default",
      completedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    await db
      .update(routineTriggers)
      .set({ nextRunAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(routineTriggers.id, trigger.id));

    const result = await svc.tickScheduledTriggers(new Date());
    expect(result.triggered).toBe(1);

    const routineIssue = await db
      .select({
        status: issues.status,
        originRunId: issues.originRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, terminalIssueId))
      .then((rows) => rows[0] ?? null);
    expect(routineIssue).toMatchObject({
      status: "todo",
      executionRunId: null,
    });
    expect(routineIssue?.originRunId).toBeTruthy();

    const latestRun = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id))
      .orderBy(routineRuns.createdAt)
      .then((rows) => rows.at(-1) ?? null);
    expect(latestRun).toMatchObject({
      status: "issue_reused",
      linkedIssueId: terminalIssueId,
      failureReason: null,
    });
    expect(routineIssue?.originRunId).toBe(latestRun?.id);
    expect(wakeups).toHaveLength(1);
  });

  it("reuses the terminal execution issue by default even when its parent is already done", async () => {
    const { companyId, routine, svc, wakeups } = await seedFixture({ wakeup: async () => null });
    const parentIssueId = randomUUID();
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Completed parent",
      status: "done",
      priority: "medium",
      completedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await svc.update(
      routine.id,
      {
        env: {
          PAPERCLIP_ROUTINE_ISSUE_MODE: { type: "plain", value: "reuse_terminal" },
        },
      },
      {},
    );
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
    const terminalIssueId = randomUUID();
    await db.insert(issues).values({
      id: terminalIssueId,
      companyId,
      projectId: routine.projectId,
      goalId: routine.goalId,
      parentId: parentIssueId,
      title: routine.title,
      description: routine.description,
      status: "done",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: randomUUID(),
      originFingerprint: "default",
      completedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    await db
      .update(routineTriggers)
      .set({ nextRunAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(routineTriggers.id, trigger.id));

    const result = await svc.tickScheduledTriggers(new Date());
    expect(result.triggered).toBe(1);

    const routineIssue = await db
      .select({
        status: issues.status,
        originRunId: issues.originRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, terminalIssueId))
      .then((rows) => rows[0] ?? null);
    expect(routineIssue).toMatchObject({
      status: "todo",
      executionRunId: null,
    });
    expect(routineIssue?.originRunId).toBeTruthy();

    const latestRun = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id))
      .orderBy(routineRuns.createdAt)
      .then((rows) => rows.at(-1) ?? null);
    expect(latestRun).toMatchObject({
      status: "issue_reused",
      linkedIssueId: terminalIssueId,
      failureReason: null,
    });
    expect(wakeups).toHaveLength(1);
  });

  it("escalates consecutive parent-terminal dead fires onto a routine-health issue when lifecycle binding is enabled", async () => {
    const { companyId, routine, svc, wakeups } = await seedFixture({ wakeup: async () => null });
    const parentIssueId = randomUUID();
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Completed parent",
      status: "done",
      priority: "medium",
      completedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await svc.update(
      routine.id,
      {
        parentIssueId,
        env: {
          PAPERCLIP_ROUTINE_PARENT_LIFECYCLE_BINDING: { type: "plain", value: "true" },
        },
      },
      {},
    );
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

    for (const day of ["2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z", "2020-01-03T00:00:00.000Z"]) {
      await db
        .update(routineTriggers)
        .set({ nextRunAt: new Date(day) })
        .where(eq(routineTriggers.id, trigger.id));
      const result = await svc.tickScheduledTriggers(new Date("2026-01-04T00:00:00.000Z"));
      expect(result.triggered).toBe(1);
    }

    const runs = await db
      .select({
        status: routineRuns.status,
        failureReason: routineRuns.failureReason,
      })
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id))
      .orderBy(routineRuns.createdAt);
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.status === "skipped" && run.failureReason === "parent_issue_terminal_done")).toBe(true);

    const healthIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "routine_health"))
      .then((rows) => rows[0] ?? null);
    expect(healthIssue).toMatchObject({
      originId: routine.id,
      status: "in_review",
    });
    expect(healthIssue?.title).toContain("BOARD ACTION REQUIRED:");

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, healthIssue!.id));
    expect(comments.at(-1)?.body).toContain("scheduled streak 3/3");
    expect(comments.at(-1)?.body).toContain("parent_issue_terminal_done");

    const interactions = await db
      .select({
        kind: issueThreadInteractions.kind,
        status: issueThreadInteractions.status,
        summary: issueThreadInteractions.summary,
      })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, healthIssue!.id));
    expect(interactions).toContainEqual(expect.objectContaining({
      kind: "request_confirmation",
      status: "pending",
    }));
    expect(interactions[0]?.summary).toContain("three consecutive scheduled fires died");
    expect(wakeups).toHaveLength(1);
  });

  it("creates a scheduled execution issue when the project goal pointer is stale", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture({ wakeup: async () => null });
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
    const staleGoalId = randomUUID();

    await db.insert(goals).values({
      id: staleGoalId,
      companyId,
      title: "Replacement project goal",
      level: "task",
      status: "active",
    });

    await db
      .update(projects)
      .set({ goalId: staleGoalId })
      .where(eq(projects.id, projectId));
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));

    const result = await svc.tickScheduledTriggers(new Date());
    expect(result.triggered).toBe(1);

    const run = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id))
      .orderBy(routineRuns.createdAt)
      .then((rows) => rows.at(-1) ?? null);
    expect(run?.status).toBe("issue_created");
    expect(run?.failureReason).toBeNull();

    const routineIssue = await db
      .select({
        goalId: issues.goalId,
        originRunId: issues.originRunId,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    expect(routineIssue).toBeTruthy();
    expect(routineIssue?.goalId).toBe(staleGoalId);
    expect(routineIssue?.originRunId).toBe(run?.id ?? null);
  });

  it("keeps a reused terminal issue committed when the assignment wakeup hits issue-lock contention", async () => {
    let failReuseWakeup = false;
    const { companyId, routine, svc } = await seedFixture({
      wakeup: async (_agentId, wakeupOpts) => {
        if (failReuseWakeup && wakeupOpts.payload?.mutation === "update") {
          throw new Error("Failed query: select id from issues where id = $1 and company_id = $2 for update");
        }
        return null;
      },
    });
    await svc.update(
      routine.id,
      {
        env: {
          PAPERCLIP_ROUTINE_ISSUE_MODE: { type: "plain", value: "reuse_terminal" },
        },
      },
      {},
    );
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

    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));

    const firstResult = await svc.tickScheduledTriggers(new Date());
    expect(firstResult.triggered).toBe(1);

    const [firstIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(firstIssue).toBeTruthy();

    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), executionRunId: null, executionLockedAt: null })
      .where(eq(issues.id, firstIssue!.id));
    await svc.syncRunStatusForIssue(firstIssue!.id);

    failReuseWakeup = true;
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));

    const secondResult = await svc.tickScheduledTriggers(new Date());
    expect(secondResult.triggered).toBe(1);

    const routineIssues = await db
      .select({
        id: issues.id,
        status: issues.status,
        originRunId: issues.originRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
        completedAt: issues.completedAt,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]).toMatchObject({
      id: firstIssue!.id,
      status: "todo",
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(routineIssues[0]?.originRunId).not.toBe(firstIssue!.originRunId);
    expect(routineIssues[0]?.completedAt).toBeNull();

    const runs = (await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id)))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    expect(runs).toHaveLength(2);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[1]?.status).toBe("issue_reused");
    expect(runs[1]?.linkedIssueId).toBe(firstIssue!.id);
    expect(runs[1]?.failureReason).toBeNull();
  });

  it("dispatches the scheduled reuse wake after commit so the wakeup sees the reused issue as todo", async () => {
    let observedReuseWakeStatus: string | null = null;
    const { companyId, routine, svc } = await seedFixture({
      wakeup: async (_agentId, wakeupOpts) => {
        if (wakeupOpts.payload?.mutation !== "update") {
          return null;
        }
        const issueId = typeof wakeupOpts.payload?.issueId === "string" ? wakeupOpts.payload.issueId : null;
        expect(issueId).toBeTruthy();
        const issue = await db
          .select({ status: issues.status })
          .from(issues)
          .where(eq(issues.id, issueId!))
          .then((rows) => rows[0] ?? null);
        observedReuseWakeStatus = issue?.status ?? null;
        if (observedReuseWakeStatus !== "todo") {
          throw new Error(`expected reused issue status todo during wake, saw ${observedReuseWakeStatus ?? "missing"}`);
        }
        return null;
      },
    });
    await svc.update(
      routine.id,
      {
        env: {
          PAPERCLIP_ROUTINE_ISSUE_MODE: { type: "plain", value: "reuse_terminal" },
        },
      },
      {},
    );
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

    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));
    expect((await svc.tickScheduledTriggers(new Date())).triggered).toBe(1);

    const [firstIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(firstIssue).toBeTruthy();

    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), executionRunId: null, executionLockedAt: null })
      .where(eq(issues.id, firstIssue!.id));
    await svc.syncRunStatusForIssue(firstIssue!.id);

    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));
    expect((await svc.tickScheduledTriggers(new Date())).triggered).toBe(1);

    expect(observedReuseWakeStatus).toBe("todo");
    const runs = (await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id)))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    expect(runs[1]?.status).toBe("issue_reused");
    expect(runs[1]?.failureReason).toBeNull();
  });

  it("creates a fresh execution issue when a stranded non-terminal issue has no live heartbeat run", async () => {
    const { companyId, routine, svc } = await seedFixture();
    await svc.update(
      routine.id,
      {
        concurrencyPolicy: "skip_if_active",
        env: {
          PAPERCLIP_ROUTINE_ISSUE_MODE: { type: "plain", value: "reuse_terminal" },
        },
      },
      {},
    );
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "schedule",
        label: "half-hourly",
        cronExpression: "*/30 * * * *",
        timezone: "UTC",
      },
      {},
    );
    const pastDue = new Date("2020-01-01T00:00:00.000Z");

    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));
    expect((await svc.tickScheduledTriggers(new Date())).triggered).toBe(1);

    const firstIssue = await db
      .select({
        id: issues.id,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    expect(firstIssue?.executionRunId).toBeTruthy();

    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: new Date("2026-07-20T15:13:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, firstIssue!.executionRunId!));
    await db
      .update(issues)
      .set({
        status: "blocked",
        checkoutRunId: null,
        executionRunId: null,
        executionLockedAt: null,
      })
      .where(eq(issues.id, firstIssue!.id));

    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));
    expect((await svc.tickScheduledTriggers(new Date())).triggered).toBe(1);

    const routineIssues = await db
      .select({
        id: issues.id,
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId))
      .orderBy(asc(issues.createdAt));
    expect(routineIssues).toHaveLength(2);
    expect(routineIssues[0]).toMatchObject({
      id: firstIssue!.id,
      status: "blocked",
    });
    expect(routineIssues[1]?.id).not.toBe(firstIssue!.id);
    expect(routineIssues[1]?.status).toBe("todo");

    const runs = await db
      .select({
        status: routineRuns.status,
        linkedIssueId: routineRuns.linkedIssueId,
      })
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id))
      .orderBy(asc(routineRuns.createdAt));
    expect(runs).toHaveLength(2);
    expect(runs[0]?.status).toBe("issue_created");
    expect(runs[1]).toMatchObject({
      status: "issue_created",
      linkedIssueId: routineIssues[1]?.id,
    });
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

  it("records failed scheduled dispatches after a trigger is claimed", async () => {
    const { companyId, routine, svc } = await seedFixture();
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

    await db
      .update(routines)
      .set({ assigneeAgentId: null })
      .where(eq(routines.id, routine.id));
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));

    const result = await svc.tickScheduledTriggers(new Date());
    expect(result.triggered).toBe(0);

    const createdIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(createdIssues).toHaveLength(0);

    const runs = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.source).toBe("schedule");
    expect(runs[0]?.failureReason).toMatch(/Default agent required/);
    expect(runs[0]?.linkedIssueId).toBeNull();

    const refreshedTrigger = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, trigger.id))
      .then((rows) => rows[0]);
    expect(refreshedTrigger?.nextRunAt).not.toBeNull();
    expect(refreshedTrigger!.nextRunAt!.getTime()).toBeGreaterThan(pastDue.getTime());
    expect(refreshedTrigger?.lastResult).toBe("Execution failed; retry scheduled");
  });

  it("skips a gated scheduled tick when quiet without advancing the activity window", async () => {
    const { companyId, routine, svc } = await seedFixture();
    await db
      .update(companies)
      .set({ routineGuardConfig: { minimumScheduleIntervalMinutes: 1 } })
      .where(eq(companies.id, companyId));
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
});
