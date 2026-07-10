import { createHmac, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueInboxArchives,
  issueReadStates,
  issues,
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
import { issueService } from "../services/issues.ts";
import { agentService } from "../services/agents.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import * as providerRegistry from "../secrets/provider-registry.ts";
import { routineService } from "../services/routines.ts";

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
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
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
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          wakeups.push({ agentId: wakeupAgentId, opts: wakeupOpts });
          if (opts?.wakeup) return opts.wakeup(wakeupAgentId, wakeupOpts);
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

  async function waitForBlockedAgentRowLock(timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await db.execute(sql`
        select count(*)::int as waiting
        from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query ilike '%agents%'
          and query ilike '%for update%'
      `) as unknown as Array<{ waiting: number }>;
      if (Number(rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for the routine mutation to block on the assignee row lock");
  }

  async function waitForBlockedDispatchAgentLock(timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await db.execute(sql`
        select count(*)::int as waiting
        from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query ilike '%agents%'
          and query ilike '%for share%'
      `) as unknown as Array<{ waiting: number }>;
      if (Number(rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for routine dispatch to block on the assignee lifecycle lock");
  }

  async function waitForBlockedDispatchTriggerLock(timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await db.execute(sql`
        select count(*)::int as waiting
        from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query ilike '%routine_triggers%'
          and query ilike '%for update%'
      `) as unknown as Array<{ waiting: number }>;
      if (Number(rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for routine dispatch to revalidate its trigger lock");
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

  it("serializes routine creation with termination and revalidates the assignee after unlock", async () => {
    const { agentId, companyId, projectId, svc } = await seedFixture();
    let releaseTermination!: () => void;
    let markTerminationStaged!: () => void;
    const releaseTerminationPromise = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const terminationStaged = new Promise<void>((resolve) => {
      markTerminationStaged = resolve;
    });
    const terminationTransaction = db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({ status: "terminated" })
        .where(eq(agents.id, agentId));
      markTerminationStaged();
      await releaseTerminationPromise;
    });
    await terminationStaged;

    const createRoutine = svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "termination race routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );
    try {
      await waitForBlockedAgentRowLock();
    } finally {
      releaseTermination();
      await terminationTransaction;
    }

    await expect(createRoutine).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign routines to terminated agents",
    });
    await expect(db.select().from(routines).where(eq(routines.title, "termination race routine")))
      .resolves.toHaveLength(0);
  });

  it("does not create a routine issue when termination wins an in-flight dispatch", async () => {
    const { agentId, routine, svc } = await seedFixture();
    let releaseTermination!: () => void;
    let markTerminationStaged!: () => void;
    const releaseTerminationPromise = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const terminationStaged = new Promise<void>((resolve) => {
      markTerminationStaged = resolve;
    });
    const terminationTransaction = db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({ status: "terminated" })
        .where(eq(agents.id, agentId));
      markTerminationStaged();
      await releaseTerminationPromise;
    });
    await terminationStaged;

    const dispatch = svc.runRoutine(routine.id, { source: "manual" });
    try {
      await waitForBlockedDispatchAgentLock();
    } finally {
      releaseTermination();
      await terminationTransaction;
    }

    await expect(dispatch).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign routines to terminated agents",
    });
    await expect(db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id)))
      .resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.originId, routine.id)))
      .resolves.toHaveLength(0);
  });

  it("does not dispatch after its trigger is disabled concurrently", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      enabled: true,
    }, {});
    let releaseDisable!: () => void;
    let markDisableStaged!: () => void;
    const disableReleased = new Promise<void>((resolve) => {
      releaseDisable = resolve;
    });
    const disableStaged = new Promise<void>((resolve) => {
      markDisableStaged = resolve;
    });
    const disableTransaction = db.transaction(async (tx) => {
      await tx
        .update(routineTriggers)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(routineTriggers.id, created.trigger.id));
      markDisableStaged();
      await disableReleased;
    });
    await disableStaged;

    const dispatch = svc.runRoutine(routine.id, {
      source: "manual",
      triggerId: created.trigger.id,
    });
    try {
      await waitForBlockedDispatchTriggerLock();
    } finally {
      releaseDisable();
      await disableTransaction;
    }

    await expect(dispatch).rejects.toMatchObject({
      status: 409,
      message: "Routine trigger is not active",
    });
    await expect(db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id)))
      .resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.originId, routine.id)))
      .resolves.toHaveLength(0);
  });

  it("does not dispatch after its trigger is deleted concurrently", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      enabled: true,
    }, {});
    let releaseDelete!: () => void;
    let markDeleteStaged!: () => void;
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteStaged = new Promise<void>((resolve) => {
      markDeleteStaged = resolve;
    });
    const deleteTransaction = db.transaction(async (tx) => {
      await tx.delete(routineTriggers).where(eq(routineTriggers.id, created.trigger.id));
      markDeleteStaged();
      await deleteReleased;
    });
    await deleteStaged;

    const dispatch = svc.runRoutine(routine.id, {
      source: "manual",
      triggerId: created.trigger.id,
    });
    try {
      await waitForBlockedDispatchTriggerLock();
    } finally {
      releaseDelete();
      await deleteTransaction;
    }

    await expect(dispatch).rejects.toMatchObject({
      status: 409,
      message: "Routine trigger is not active",
    });
    await expect(db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id)))
      .resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.originId, routine.id)))
      .resolves.toHaveLength(0);
  });

  it("serializes routine reassignment with termination and preserves the original assignee", async () => {
    const { companyId, agentId, routine, svc } = await seedFixture();
    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId,
      name: "TerminatingTarget",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    let releaseTermination!: () => void;
    let markTerminationStaged!: () => void;
    const releaseTerminationPromise = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const terminationStaged = new Promise<void>((resolve) => {
      markTerminationStaged = resolve;
    });
    const terminationTransaction = db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({ status: "terminated" })
        .where(eq(agents.id, targetAgentId));
      markTerminationStaged();
      await releaseTerminationPromise;
    });
    await terminationStaged;

    const updateRoutine = svc.update(routine.id, { assigneeAgentId: targetAgentId }, {});
    try {
      await waitForBlockedAgentRowLock();
    } finally {
      releaseTermination();
      await terminationTransaction;
    }

    await expect(updateRoutine).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign routines to terminated agents",
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      assigneeAgentId: agentId,
      status: "active",
    });
  });

  it("serializes routine activation with termination and leaves the routine paused", async () => {
    const { agentId, routine, svc } = await seedFixture();
    const paused = await svc.update(routine.id, { status: "paused" }, {});
    let releaseTermination!: () => void;
    let markTerminationStaged!: () => void;
    const releaseTerminationPromise = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const terminationStaged = new Promise<void>((resolve) => {
      markTerminationStaged = resolve;
    });
    const terminationTransaction = db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({ status: "terminated" })
        .where(eq(agents.id, agentId));
      markTerminationStaged();
      await releaseTerminationPromise;
    });
    await terminationStaged;

    const activateRoutine = svc.update(
      routine.id,
      { status: "active", baseRevisionId: paused?.latestRevisionId },
      {},
    );
    try {
      await waitForBlockedAgentRowLock();
    } finally {
      releaseTermination();
      await terminationTransaction;
    }

    await expect(activateRoutine).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign routines to terminated agents",
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      status: "paused",
      latestRevisionId: paused?.latestRevisionId,
    });
  });

  it("aborts activation without reversing lock order when the assignee drifts", async () => {
    const { agentId, companyId, routine, svc } = await seedFixture();
    await svc.update(routine.id, { status: "paused" }, {});
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "ConcurrentReplacement",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    let releaseOriginalAgent!: () => void;
    let markOriginalAgentLocked!: () => void;
    const releaseOriginalAgentPromise = new Promise<void>((resolve) => {
      releaseOriginalAgent = resolve;
    });
    const originalAgentLocked = new Promise<void>((resolve) => {
      markOriginalAgentLocked = resolve;
    });
    const agentLock = db.transaction(async (tx) => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for("update");
      markOriginalAgentLocked();
      await releaseOriginalAgentPromise;
    });
    await originalAgentLocked;

    const activateRoutine = svc.update(routine.id, { status: "active" }, {});
    await waitForBlockedAgentRowLock();
    await db
      .update(routines)
      .set({ assigneeAgentId: replacementAgentId, status: "paused" })
      .where(eq(routines.id, routine.id));
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, replacementAgentId));
    releaseOriginalAgent();
    await agentLock;

    await expect(activateRoutine).rejects.toMatchObject({
      status: 409,
      message: "Routine assignee changed while waiting for the lifecycle lock; retry the update",
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      assigneeAgentId: replacementAgentId,
      status: "paused",
    });
  });

  it("does not create an enabled trigger after the assignee terminates", async () => {
    const { agentId, routine, svc } = await seedFixture();
    let releaseTermination!: () => void;
    let markTerminationStaged!: () => void;
    const releaseTerminationPromise = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const terminationStaged = new Promise<void>((resolve) => {
      markTerminationStaged = resolve;
    });
    const terminationTransaction = db.transaction(async (tx) => {
      await tx.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));
      markTerminationStaged();
      await releaseTerminationPromise;
    });
    await terminationStaged;

    const createTrigger = svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      enabled: true,
    }, {});
    try {
      await waitForBlockedAgentRowLock();
    } finally {
      releaseTermination();
      await terminationTransaction;
    }

    await expect(createTrigger).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign routines to terminated agents",
    });
    await expect(db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine.id)))
      .resolves.toHaveLength(0);
  });

  it("does not re-enable a trigger after the assignee terminates", async () => {
    const { agentId, routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      enabled: false,
    }, {});
    let releaseTermination!: () => void;
    let markTerminationStaged!: () => void;
    const releaseTerminationPromise = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const terminationStaged = new Promise<void>((resolve) => {
      markTerminationStaged = resolve;
    });
    const terminationTransaction = db.transaction(async (tx) => {
      await tx.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));
      markTerminationStaged();
      await releaseTerminationPromise;
    });
    await terminationStaged;

    const enableTrigger = svc.updateTrigger(created.trigger.id, { enabled: true }, {});
    try {
      await waitForBlockedAgentRowLock();
    } finally {
      releaseTermination();
      await terminationTransaction;
    }

    await expect(enableTrigger).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign routines to terminated agents",
    });
    await expect(svc.getTrigger(created.trigger.id)).resolves.toMatchObject({ enabled: false });
  });

  it("does not disable a trigger that was transferred before the former assignee terminated", async () => {
    const { agentId, companyId, routine, svc } = await seedFixture();
    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId,
      name: "ReplacementOwner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const created = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      enabled: true,
    }, {});

    let releaseTransfer!: () => void;
    let markTransferStaged!: () => void;
    const releaseTransferPromise = new Promise<void>((resolve) => {
      releaseTransfer = resolve;
    });
    const transferStaged = new Promise<void>((resolve) => {
      markTransferStaged = resolve;
    });
    const transferTransaction = db.transaction(async (tx) => {
      const txSvc = routineService(tx as unknown as typeof db);
      const updated = await txSvc.update(routine.id, { assigneeAgentId: targetAgentId }, {});
      markTransferStaged();
      await releaseTransferPromise;
      return updated;
    });
    await transferStaged;

    const terminateFormerOwner = agentService(db).terminate(agentId, {
      actorType: "system",
      actorId: "test",
      source: "concurrency_test",
    });
    try {
      await waitForBlockedAgentRowLock();
    } finally {
      releaseTransfer();
      await transferTransaction;
    }
    await terminateFormerOwner;

    await expect(svc.get(routine.id)).resolves.toMatchObject({
      assigneeAgentId: targetAgentId,
      status: "active",
    });
    await expect(svc.getTrigger(created.trigger.id)).resolves.toMatchObject({ enabled: true });
    await expect(db.select().from(agents).where(eq(agents.id, agentId)))
      .resolves.toEqual([expect.objectContaining({ status: "terminated" })]);
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
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      description: "revision 2",
      latestRevisionNumber: 2,
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
          payload: { issueId: run.linkedIssueId, mutation: "create", assignmentHandoff: true },
          requestedByActorType: undefined,
          requestedByActorId: null,
          contextSnapshot: {
            issueId: run.linkedIssueId,
            source: "routine.dispatch",
            assignmentHandoff: true,
          },
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
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));
    expect(createdIssue).toMatchObject({
      id: run.linkedIssueId,
      assigneeAgentId: agentId,
      createdByUserId: userId,
    });

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
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

  it("dispatches a claimed scheduled trigger after its runtime timestamps advance", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "* * * * *",
      timezone: "UTC",
      enabled: true,
    }, {});
    const now = new Date("2026-07-11T12:00:30.000Z");
    await db
      .update(routineTriggers)
      .set({ nextRunAt: new Date("2026-07-11T12:00:00.000Z") })
      .where(eq(routineTriggers.id, created.trigger.id));

    await expect(svc.tickScheduledTriggers(now)).resolves.toEqual({ triggered: 1 });
    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      triggerId: created.trigger.id,
      source: "schedule",
      status: "issue_created",
    });
  });

  it("allows concurrent webhook deliveries to serialize without stale-trigger rejection", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "none",
    }, {});

    const [first, second] = await Promise.all([
      svc.firePublicTrigger(trigger.publicId!, { payload: { delivery: "same-event" } }),
      svc.firePublicTrigger(trigger.publicId!, { payload: { delivery: "same-event" } }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["coalesced", "issue_created"]);
    expect(first.linkedIssueId).toBe(second.linkedIssueId);
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

  it("does not hold lifecycle locks during webhook provider I/O and compensates a rejected create", async () => {
    process.env.PAPERCLIP_SECRETS_PROVIDER = "aws_secrets_manager";
    let releaseProviderWrite!: () => void;
    let markProviderWriteStarted!: () => void;
    const providerWriteRelease = new Promise<void>((resolve) => {
      releaseProviderWrite = resolve;
    });
    const providerWriteStarted = new Promise<void>((resolve) => {
      markProviderWriteStarted = resolve;
    });
    const deleteOrArchive = vi.fn(async () => undefined);
    const originalGetSecretProvider = providerRegistry.getSecretProvider;
    const getSecretProviderSpy = vi.spyOn(providerRegistry, "getSecretProvider").mockImplementation((provider) => {
      if (provider !== "aws_secrets_manager") return originalGetSecretProvider(provider);
      return {
        id: "aws_secrets_manager",
        descriptor: () => ({
          id: "aws_secrets_manager",
          label: "AWS Secrets Manager",
          supportsManaged: true,
          supportsExternalReference: true,
        }),
        validateConfig: async () => ({ ok: true, warnings: [] }),
        createSecret: async ({ value }) => {
          markProviderWriteStarted();
          await providerWriteRelease;
          return {
            material: { source: "managed", secretId: "arn:aws:secretsmanager:prepared", versionId: "v1" },
            valueSha256: `sha:${value}`,
            fingerprintSha256: `sha:${value}`,
            externalRef: "arn:aws:secretsmanager:prepared",
            providerVersionRef: "v1",
          };
        },
        createVersion: async ({ value }) => ({
          material: { source: "managed", secretId: "arn:aws:secretsmanager:prepared", versionId: "v2" },
          valueSha256: `sha:${value}`,
          fingerprintSha256: `sha:${value}`,
          externalRef: "arn:aws:secretsmanager:prepared",
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
        deleteOrArchive,
        healthCheck: async () => ({
          provider: "aws_secrets_manager",
          status: "ok",
          message: "stubbed",
        }),
      };
    });

    try {
      const { agentId, routine, svc } = await seedFixture();
      const createTrigger = svc.createTrigger(routine.id, {
        kind: "webhook",
        signingMode: "hmac_sha256",
        replayWindowSec: 300,
      }, {});
      void createTrigger.catch(() => undefined);
      await providerWriteStarted;

      const termination = agentService(db).terminate(agentId, {
        actorType: "system",
        actorId: "test",
        source: "provider_delay_test",
      });
      await expect(Promise.race([
        termination,
        new Promise((_, reject) => setTimeout(() => reject(new Error("termination waited on provider I/O")), 1_000)),
      ])).resolves.toMatchObject({ status: "terminated" });

      releaseProviderWrite();
      await expect(createTrigger).rejects.toMatchObject({
        status: 409,
        message: "Cannot assign routines to terminated agents",
      });
      expect(deleteOrArchive).toHaveBeenCalledTimes(1);
      await expect(db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine.id)))
        .resolves.toHaveLength(0);
      await expect(db.select().from(companySecrets)).resolves.toHaveLength(0);
    } finally {
      releaseProviderWrite?.();
      getSecretProviderSpy.mockRestore();
    }
  });

  it("attempts every prepared webhook cleanup when a multi-secret restore rolls back", async () => {
    const { routine, svc } = await seedFixture();
    const first = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    const second = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    const targetRevisionId = second.revision.id;
    await svc.deleteTrigger(first.trigger.id, {});
    await svc.deleteTrigger(second.trigger.id, {});

    process.env.PAPERCLIP_SECRETS_PROVIDER = "aws_secrets_manager";
    let createCount = 0;
    const deleteOrArchive = vi.fn(async () => {
      if (deleteOrArchive.mock.calls.length === 1) {
        throw new Error("first provider cleanup failed");
      }
    });
    const originalGetSecretProvider = providerRegistry.getSecretProvider;
    const getSecretProviderSpy = vi.spyOn(providerRegistry, "getSecretProvider").mockImplementation((provider) => {
      if (provider !== "aws_secrets_manager") return originalGetSecretProvider(provider);
      return {
        id: "aws_secrets_manager",
        descriptor: () => ({
          id: "aws_secrets_manager",
          label: "AWS Secrets Manager",
          supportsManaged: true,
          supportsExternalReference: true,
        }),
        validateConfig: async () => ({ ok: true, warnings: [] }),
        createSecret: async ({ value }) => {
          createCount += 1;
          if (createCount === 2) {
            await svc.update(routine.id, { description: "Concurrent restore mutation" }, {});
          }
          return {
            material: {
              source: "managed",
              secretId: `arn:aws:secretsmanager:restore-${createCount}`,
              versionId: "v1",
            },
            valueSha256: `sha:${value}`,
            fingerprintSha256: `sha:${value}`,
            externalRef: `arn:aws:secretsmanager:restore-${createCount}`,
            providerVersionRef: "v1",
          };
        },
        createVersion: async ({ value }) => ({
          material: { source: "managed", secretId: "arn:aws:secretsmanager:version", versionId: "v2" },
          valueSha256: `sha:${value}`,
          fingerprintSha256: `sha:${value}`,
          externalRef: "arn:aws:secretsmanager:version",
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
        deleteOrArchive,
        healthCheck: async () => ({
          provider: "aws_secrets_manager",
          status: "ok",
          message: "stubbed",
        }),
      };
    });

    try {
      await expect(svc.restoreRevision(routine.id, targetRevisionId, {})).rejects.toMatchObject({
        name: "AggregateError",
      });
      expect(createCount).toBe(2);
      expect(deleteOrArchive).toHaveBeenCalledTimes(2);
      const remainingAwsSecrets = await db
        .select({ status: companySecrets.status })
        .from(companySecrets)
        .where(eq(companySecrets.provider, "aws_secrets_manager"));
      expect(remainingAwsSecrets).toEqual([{ status: "deleted" }]);
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
});
