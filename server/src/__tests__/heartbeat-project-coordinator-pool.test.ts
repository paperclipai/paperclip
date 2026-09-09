import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import type { Db, EmbeddedPostgresTestDatabase } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

interface MockExecutionInput {
  runId: string;
  runtime: {
    sessionId: string | null;
    taskKey: string | null;
  };
}

const executionHarness = vi.hoisted(() => {
  let holding = true;
  const releases = new Map<string, () => void>();
  const startedRunIds = new Set<string>();
  const startWaiters = new Map<number, () => void>();
  const PromiseWithResolvers = Promise as PromiseConstructor & {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value?: T | PromiseLike<T>) => void;
    };
  };
  const notifyStarted = (runId: string) => {
    startedRunIds.add(runId);
    for (const [count, resolve] of startWaiters) {
      if (startedRunIds.size < count) continue;
      startWaiters.delete(count);
      resolve();
    }
  };
  const execute = vi.fn(async (input: MockExecutionInput) => {
    let waitForRelease: Promise<void> | null = null;
    if (holding) {
      const gate = PromiseWithResolvers.withResolvers<void>();
      releases.set(input.runId, gate.resolve);
      waitForRelease = gate.promise;
    }
    notifyStarted(input.runId);
    if (waitForRelease) {
      await waitForRelease;
      releases.delete(input.runId);
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: `Coordinator task ${input.runId} complete.`,
      provider: "test",
      model: "test-model",
      sessionId: input.runId,
      sessionParams: { sessionId: input.runId },
    };
  });
  return {
    execute,
    waitForStarts(count: number) {
      if (startedRunIds.size >= count) return Promise.resolve();
      const pending = PromiseWithResolvers.withResolvers<void>();
      startWaiters.set(count, pending.resolve);
      return pending.promise;
    },
    release(runId: string) {
      releases.get(runId)?.();
    },
    releaseAll() {
      for (const release of releases.values()) release();
    },
    setHolding(value: boolean) {
      holding = value;
    },
    reset() {
      holding = true;
      releases.clear();
      startedRunIds.clear();
      for (const resolve of startWaiters.values()) resolve();
      startWaiters.clear();
      execute.mockClear();
    },
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: executionHarness.execute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres coordinator pool tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("project coordinator shared task admission pool", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  const drains: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-project-coordinator-pool-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    executionHarness.setHolding(false);
    executionHarness.releaseAll();
    await Promise.allSettled(drains.map((drain) => drain()));
    drains.length = 0;
    runningProcesses.clear();

    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    // Auto-installed company skills retain their company until the private DB is disposed.
    executionHarness.reset();
  }, 40_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    return db
      .insert(companies)
      .values({
        name,
        issuePrefix: `CP${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedProject(companyId: string, name: string) {
    return db
      .insert(projects)
      .values({ companyId, name, status: "in_progress" })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedCoordinator(
    companyId: string,
    projectId: string,
    name: string,
  ) {
    return db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "project_coordinator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        },
        permissions: {},
        metadata: {
          projectCoordinator: {
            projectId,
            templateAgentId: "astra-template",
          },
        },
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedQueuedTask(input: {
    companyId: string;
    agentId: string;
    taskKey: string;
    createdAt: Date;
    continuationAttempt?: number;
    issueId?: string;
  }) {
    return db
      .insert(heartbeatRuns)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        continuationAttempt: input.continuationAttempt ?? 0,
        contextSnapshot: {
          taskKey: input.taskKey,
          ...(input.issueId
            ? { issueId: input.issueId, skipIssueComment: true }
            : {}),
          wakeReason:
            (input.continuationAttempt ?? 0) > 0
              ? "issue_continuation_needed"
              : "issue_assigned",
        },
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  function createHeartbeat(poolCapacity = 3) {
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {
        ...process.env,
        PAPERCLIP_PROJECT_COORDINATOR_POOL_CAPACITY: String(poolCapacity),
        PAPERCLIP_PROJECT_COORDINATOR_POOL_FAIR_CAP: "2",
      },
    });
    drains.push(heartbeat.drainActiveRunExecutions);
    return heartbeat;
  }

  it("overlaps distinct issue tasks for one project, excludes a duplicate task, and resumes its continuation with the task session", async () => {
    const company = await seedCompany("Same-project concurrency");
    const project = await seedProject(company.id, "One project");
    const coordinator = await seedCoordinator(
      company.id,
      project.id,
      "Astra One",
    );
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    const thirdIssueId = randomUUID();
    const fourthIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: firstIssueId,
        companyId: company.id,
        projectId: project.id,
        title: "First independent task",
        status: "todo",
        assigneeAgentId: coordinator.id,
        responsibleUserId: "responsible-user",
      },
      {
        id: secondIssueId,
        companyId: company.id,
        projectId: project.id,
        title: "Second independent task",
        status: "todo",
        assigneeAgentId: coordinator.id,
        responsibleUserId: "responsible-user",
      },
      {
        id: thirdIssueId,
        companyId: company.id,
        projectId: project.id,
        title: "Third independent task",
        status: "todo",
        assigneeAgentId: coordinator.id,
        responsibleUserId: "responsible-user",
      },
      {
        id: fourthIssueId,
        companyId: company.id,
        projectId: project.id,
        title: "Fourth independent task",
        status: "todo",
        assigneeAgentId: coordinator.id,
        responsibleUserId: "responsible-user",
      },
    ]);
    const base = Date.now() - 10_000;
    const first = await seedQueuedTask({
      companyId: company.id,
      agentId: coordinator.id,
      taskKey: firstIssueId,
      issueId: firstIssueId,
      createdAt: new Date(base),
    });
    const second = await seedQueuedTask({
      companyId: company.id,
      agentId: coordinator.id,
      taskKey: secondIssueId,
      issueId: secondIssueId,
      createdAt: new Date(base + 2),
    });
    const heartbeat = createHeartbeat();
    const concurrentService = createHeartbeat();

    await Promise.all([
      heartbeat.resumeQueuedRuns(),
      concurrentService.resumeQueuedRuns(),
    ]);
    await executionHarness.waitForStarts(2);

    const duplicateContinuation = await seedQueuedTask({
      companyId: company.id,
      agentId: coordinator.id,
      taskKey: firstIssueId,
      issueId: firstIssueId,
      continuationAttempt: 1,
      createdAt: new Date(base + 1),
    });
    const third = await seedQueuedTask({
      companyId: company.id,
      agentId: coordinator.id,
      taskKey: thirdIssueId,
      issueId: thirdIssueId,
      createdAt: new Date(base + 3),
    });
    const fourth = await seedQueuedTask({
      companyId: company.id,
      agentId: coordinator.id,
      taskKey: fourthIssueId,
      issueId: fourthIssueId,
      createdAt: new Date(base + 4),
    });
    await Promise.all([
      heartbeat.resumeQueuedRuns(),
      concurrentService.resumeQueuedRuns(),
    ]);
    await executionHarness.waitForStarts(3);

    const initialRows = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(
        inArray(heartbeatRuns.id, [
          first.id,
          duplicateContinuation.id,
          second.id,
          third.id,
          fourth.id,
        ]),
      );
    expect(
      initialRows
        .filter((run) => run.status === "running")
        .map((run) => run.id)
        .sort(),
    ).toEqual([first.id, second.id, third.id].sort());
    expect(
      initialRows
        .filter((run) => run.status === "queued")
        .map((run) => run.id)
        .sort(),
    ).toEqual([duplicateContinuation.id, fourth.id].sort());

    const initialInputs = executionHarness.execute.mock.calls.map(
      ([input]) => input,
    );
    expect(initialInputs.map((input) => input.runtime.taskKey).sort()).toEqual(
      [firstIssueId, secondIssueId, thirdIssueId].sort(),
    );
    expect(initialInputs.every((input) => input.runtime.sessionId === null)).toBe(
      true,
    );

    executionHarness.release(first.id);
    await executionHarness.waitForStarts(4);
    const [continuedRun, stillQueuedRun] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, duplicateContinuation.id))
        .then((rows) => rows[0]),
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, fourth.id))
        .then((rows) => rows[0]),
    ]);
    expect(continuedRun?.status).toBe("running");
    expect(stillQueuedRun?.status).toBe("queued");

    const [taskSession] = await db
      .select({
        taskKey: agentTaskSessions.taskKey,
        sessionParamsJson: agentTaskSessions.sessionParamsJson,
      })
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, company.id),
          eq(agentTaskSessions.agentId, coordinator.id),
          eq(agentTaskSessions.taskKey, firstIssueId),
        ),
      );
    expect(taskSession).toMatchObject({
      taskKey: firstIssueId,
      sessionParamsJson: expect.objectContaining({ sessionId: first.id }),
    });

    const continuationInput = executionHarness.execute.mock.calls
      .map(([input]) => input)
      .find((input) => input.runId === duplicateContinuation.id);
    expect(continuationInput?.runtime).toMatchObject({
      taskKey: firstIssueId,
      sessionId: first.id,
    });
    const activeRows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    expect(activeRows).toHaveLength(3);
  }, 40_000);

  it("atomically fills a configured ten-slot pool while preserving each competing project's fair share", async () => {
    const company = await seedCompany("Concurrent pool admission");
    const projectA = await seedProject(company.id, "Project A");
    const projectB = await seedProject(company.id, "Project B");
    const coordinatorA = await seedCoordinator(
      company.id,
      projectA.id,
      "Astra A",
    );
    const coordinatorB = await seedCoordinator(
      company.id,
      projectB.id,
      "Astra B",
    );
    const base = Date.now() - 20_000;
    for (let index = 0; index < 12; index += 1) {
      await seedQueuedTask({
        companyId: company.id,
        agentId: coordinatorA.id,
        taskKey: `project-a-${index}`,
        createdAt: new Date(base + index),
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await seedQueuedTask({
        companyId: company.id,
        agentId: coordinatorB.id,
        taskKey: `project-b-${index}`,
        createdAt: new Date(base + 100 + index),
      });
    }
    const firstService = createHeartbeat(10);
    const secondService = createHeartbeat(10);

    await Promise.all([
      firstService.resumeQueuedRuns(),
      secondService.resumeQueuedRuns(),
    ]);
    await executionHarness.waitForStarts(10);

    const running = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    expect(running).toHaveLength(10);
    expect(
      running.filter((run) => run.agentId === coordinatorA.id),
    ).toHaveLength(8);
    expect(
      running.filter((run) => run.agentId === coordinatorB.id),
    ).toHaveLength(2);
    expect(executionHarness.execute).toHaveBeenCalledTimes(10);
  }, 40_000);

  it("borrows the third slot when the only competing project is dependency-blocked", async () => {
    const company = await seedCompany("Borrow idle capacity");
    const projectA = await seedProject(company.id, "Ready project");
    const projectB = await seedProject(company.id, "Blocked project");
    const coordinatorA = await seedCoordinator(
      company.id,
      projectA.id,
      "Astra Ready",
    );
    const coordinatorB = await seedCoordinator(
      company.id,
      projectB.id,
      "Astra Blocked",
    );
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId: company.id,
        projectId: projectB.id,
        title: "Unfinished prerequisite",
        status: "todo",
        priority: "high",
        responsibleUserId: "responsible-user",
      },
      {
        id: blockedIssueId,
        companyId: company.id,
        projectId: projectB.id,
        title: "Blocked coordinator task",
        status: "todo",
        priority: "critical",
        assigneeAgentId: coordinatorB.id,
        responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId: company.id,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    const base = Date.now() - 30_000;
    const blockedRun = await seedQueuedTask({
      companyId: company.id,
      agentId: coordinatorB.id,
      taskKey: blockedIssueId,
      issueId: blockedIssueId,
      createdAt: new Date(base),
    });
    for (let index = 0; index < 3; index += 1) {
      await seedQueuedTask({
        companyId: company.id,
        agentId: coordinatorA.id,
        taskKey: `ready-${index}`,
        createdAt: new Date(base + 100 + index),
      });
    }
    const heartbeat = createHeartbeat();

    await heartbeat.resumeQueuedRuns();
    await executionHarness.waitForStarts(3);
    const running = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    const [blocked] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, blockedRun.id));
    expect(running).toHaveLength(3);
    expect(running.every((run) => run.agentId === coordinatorA.id)).toBe(true);
    expect(blocked?.status).toBe("cancelled");

    const [persistedBlockedRun] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, blockedRun.id));
    expect(persistedBlockedRun).toMatchObject({
      status: "cancelled",
      errorCode: "issue_dependencies_blocked",
    });
    expect(executionHarness.execute).toHaveBeenCalledTimes(3);
  }, 40_000);
});
