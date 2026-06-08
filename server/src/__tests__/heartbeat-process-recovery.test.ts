import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  costEvents,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issuePlanDecompositions,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn<
    (ctx: { runId: string }) => Promise<{
      exitCode: number;
      signal: string | null;
      timedOut: boolean;
      errorCode?: string;
      errorFamily?: string;
      errorMessage: string | null;
      summary?: string;
      provider: string;
      model: string;
      resultJson?: Record<string, unknown>;
    }>
  >(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Recovered stranded heartbeat work.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

const mockListLiveAgentJobRunIds = vi.hoisted(() =>
  vi.fn<() => Promise<Set<string> | null>>(async () => null),
);
const mockDeleteAgentJobsForRun = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<number | null>>(async () => 1),
);
const mockListAgentJobRunStatuses = vi.hoisted(() =>
  vi.fn<
    () => Promise<
      Map<
        string,
        {
          phase: "active" | "succeeded" | "failed";
          reason?: string | null;
          message?: string | null;
          name?: string | null;
        }
      > | null
    >
  >(async () => null),
);
vi.mock("../services/k8s-job-liveness.ts", () => ({
  listLiveAgentJobRunIds: mockListLiveAgentJobRunIds,
  listAgentJobRunStatuses: mockListAgentJobRunStatuses,
  deleteAgentJobsForRun: mockDeleteAgentJobsForRun,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.js";
import { setPluginEventBus, setPluginEventOutboxDb } from "../services/activity-log.js";
import { pollOnce as drainPluginEventOutbox } from "../services/plugin-event-outbox.js";
import type { PluginEventBus, ScopedPluginEventBus } from "../services/plugin-event-bus.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForValue<T>(
  read: () => Promise<T | null | undefined>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest: T | null | undefined = null;
  while (Date.now() < deadline) {
    latest = await read();
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest ?? null;
}

async function spawnOrphanedProcessGroup() {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid));",
        "setTimeout(() => process.exit(0), 25);",
      ].join(" "),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  let stdout = "";
  leader.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    leader.once("error", reject);
    leader.once("exit", () => resolve());
  });

  const descendantPid = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
    throw new Error(`Failed to capture orphaned descendant pid from detached process group: ${stdout}`);
  }

  return {
    processPid: leader.pid ?? null,
    processGroupId: leader.pid ?? null,
    descendantPid,
  };
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let emittedPluginEvents: PluginEvent[] = [];
  let fakeEventBus!: PluginEventBus;
  const drainOutbox = async () => {
    // publishPluginDomainEvent enqueues to the outbox; drain it through the
    // fake bus so emittedPluginEvents reflects what plugins would receive.
    while ((await drainPluginEventOutbox(db, fakeEventBus)) > 0) {
      /* keep draining */
    }
  };
  const childProcesses = new Set<ChildProcess>();
  const cleanupPids = new Set<number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    const noopScopedBus: ScopedPluginEventBus = {
      subscribe: vi.fn(),
      emit: vi.fn(async () => ({ errors: [] })),
      clear: vi.fn(),
    };
    fakeEventBus = {
      emit: vi.fn(async (event: PluginEvent) => {
        emittedPluginEvents.push(event);
        return { errors: [] };
      }),
      forPlugin: vi.fn(() => noopScopedBus),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn(() => 0),
    } satisfies PluginEventBus;
    setPluginEventBus(fakeEventBus);
    // Plugin domain events are now enqueued to the outbox; the worker-tier
    // poller is the sole emitter. Wire the outbox db so publishPluginDomainEvent
    // persists, and drain via pollOnce() before asserting emitted events.
    setPluginEventOutboxDb(db);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    emittedPluginEvents = [];
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Recovered stranded heartbeat work.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    await cleanupHeartbeatTestState(db, heartbeat);
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processGroupId?: number | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
    lastOutputAt?: Date | null;
    contextSnapshot?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
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
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    // Default lastOutputAt to "real now" so external-lifecycle staleness
    // checks (15-min window in heartbeat.ts) treat the seeded run as
    // currently active. Tests that want to exercise the staleness path can
    // pass an older Date explicitly.
    const lastOutputAt = input?.lastOutputAt === undefined ? new Date() : input.lastOutputAt;

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeIssue === false
        ? input?.contextSnapshot ?? {}
        : { ...(input?.contextSnapshot ?? {}), issueId },
      processPid: input?.processPid ?? null,
      processGroupId: input?.processGroupId ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      createdAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
      lastOutputAt,
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  async function seedAdapterInvokeEvent(input: {
    companyId: string;
    agentId: string;
    runId: string;
  }) {
    await db.insert(heartbeatRunEvents).values({
      companyId: input.companyId,
      agentId: input.agentId,
      runId: input.runId,
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "adapter invocation",
      payload: {},
    });
  }

  async function seedStrandedIssueFixture(input: {
    status: "todo" | "in_progress";
    runStatus: "failed" | "timed_out" | "cancelled" | "succeeded";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | null;
    assignToUser?: boolean;
    activePauseHold?: boolean;
    livenessState?: "completed" | "advanced" | "plan_only" | "empty_response" | "blocked" | "failed" | "needs_followup" | null;
    runErrorCode?: string | null;
    runError?: string | null;
    resultJson?: Record<string, unknown> | null;
    runUsageJson?: Record<string, unknown> | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const rootIssueId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: input.retryReason === "assignment_recovery" ? "issue_assignment_recovery" : "issue_assigned",
      payload: { issueId },
      status: input.runStatus === "cancelled" ? "cancelled" : "failed",
      runId,
      claimedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus,
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: input.retryReason === "assignment_recovery"
          ? "issue_assignment_recovery"
          : input.retryReason ?? "issue_assigned",
        ...(input.retryReason ? { retryReason: input.retryReason } : {}),
      },
      startedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      updatedAt: new Date("2026-03-19T00:05:00.000Z"),
      errorCode: input.runStatus === "succeeded"
        ? null
        : ("runErrorCode" in input ? input.runErrorCode : "process_lost"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
      livenessState: input.livenessState ?? null,
      resultJson: input.resultJson ?? null,
      usageJson: input.runUsageJson ?? null,
    });

    await db.insert(issues).values([
      ...(input.activePauseHold
        ? [{
          id: rootIssueId,
          companyId,
          title: "Paused recovery root",
          status: "todo",
          priority: "medium",
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        }]
        : []),
      {
        id: issueId,
        companyId,
        parentId: input.activePauseHold ? rootIssueId : null,
        title: "Recover stranded assigned work",
        status: input.status,
        priority: "medium",
        assigneeAgentId: input.assignToUser ? null : agentId,
        assigneeUserId: input.assignToUser ? "user-1" : null,
        checkoutRunId: input.status === "in_progress" ? runId : null,
        executionRunId: null,
        issueNumber: input.activePauseHold ? 2 : 1,
        identifier: `${issuePrefix}-${input.activePauseHold ? 2 : 1}`,
        startedAt: input.status === "in_progress" ? now : null,
      },
    ]);

    if (input.activePauseHold) {
      await db.insert(issueTreeHolds).values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "pause recovery subtree",
        releasePolicy: { strategy: "manual" },
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId, rootIssueId };
  }

  async function seedAssignedTodoNoRunFixture(input?: {
    agentStatus?: "paused" | "idle" | "running";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
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
      status: input?.agentStatus ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned todo work that never received a heartbeat",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function expectStrandedRecoveryArtifacts(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId: string;
    previousStatus: "todo" | "in_progress";
    // "unknown" is what the recovery artifact description shows when the
    // failed source run carried no retryReason in its contextSnapshot — i.e.
    // the very first failure (BLO-1498 short-circuit case), not a retry.
    retryReason: "assignment_recovery" | "issue_continuation_needed" | "unknown";
  }) {
    const action = await waitForValue(async () =>
      db.select().from(issueRecoveryActions).where(
        and(
          eq(issueRecoveryActions.companyId, input.companyId),
          eq(issueRecoveryActions.sourceIssueId, input.issueId),
          eq(issueRecoveryActions.status, "active"),
        ),
      ).then((rows) => rows[0] ?? null),
    );
    if (!action) throw new Error("Expected source-scoped stranded recovery action to be created");

    expect(action).toMatchObject({
      companyId: input.companyId,
      sourceIssueId: input.issueId,
      recoveryIssueId: null,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: input.agentId,
      previousOwnerAgentId: input.agentId,
      returnOwnerAgentId: input.agentId,
      cause: "stranded_assigned_issue",
    });

    expect(action.evidence).toMatchObject({
      sourceIssueId: input.issueId,
      previousStatus: input.previousStatus,
      latestRunId: input.runId,
      recoveryCause: "stranded_assigned_issue",
      retryReason: input.retryReason === "unknown" ? null : input.retryReason,
    });

    const recoveryIssueRows = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, input.issueId),
        ),
      );
    expect(recoveryIssueRows).toHaveLength(0);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, input.agentId));
    const recoveryWakeup = wakeups.find((wakeup) => {
      const payload = wakeup.payload as Record<string, unknown> | null;
      return payload?.issueId === input.issueId &&
        payload?.sourceIssueId === input.issueId &&
        payload?.strandedRunId === input.runId &&
        payload?.recoveryActionId === action.id;
    });
    expect(recoveryWakeup).toMatchObject({
      companyId: input.companyId,
      reason: "source_scoped_recovery_action",
      source: "assignment",
      payload: expect.objectContaining({
        modelProfile: "cheap",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      }),
    });

    const recoveryRun = recoveryWakeup?.runId
      ? await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, recoveryWakeup.runId))
        .then((rows) => rows[0] ?? null)
      : null;
    expect(recoveryRun?.contextSnapshot).toMatchObject({
      issueId: input.issueId,
      taskId: input.issueId,
      source: "issue_recovery_action",
      recoveryActionId: action.id,
      sourceIssueId: input.issueId,
      strandedRunId: input.runId,
      modelProfile: "cheap",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    });

    return action;
  }

  async function sourceBlockerIssueIds(companyId: string, sourceIssueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, sourceIssueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function seedQueuedIssueRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
      requestedAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry transient Codex failure without blocking",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("does not reap external-lifecycle adapter runs that have no local pid", async () => {
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });

    const startupResult = await heartbeat.reapOrphanedRuns();
    expect(startupResult.reaped).toBe(0);

    const periodicResult = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 1 });
    expect(periodicResult.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBeNull();
  });

  it("does not reap opencode_k8s runs with no local pid", async () => {
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBeNull();
  });

  it("does not reap external-lifecycle runs whose kube-API Job is live AND output is fresh", async () => {
    // Healthy in-flight case: Job exists in cluster and the agent is
    // streaming events (lastOutputAt within the staleness window). Reaper
    // must keep its hands off.
    const fresh = new Date(Date.now() - 30 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: fresh,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    mockListLiveAgentJobRunIds.mockResolvedValueOnce(new Set([runId]));

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(mockDeleteAgentJobsForRun).not.toHaveBeenCalled();
  });

  it("persists external_run_id (backing Job name) onto a live external-lifecycle run", async () => {
    // BLO-8746/BLO-8827 Phase A: the run record carried no reference to its
    // backing k8s Job (external_run_id was empty for every run), so process_pid
    // — which is always NULL for external-lifecycle runs — got misread as a
    // zombie signal. The reaper now stamps the Job name onto external_run_id so
    // the run row is self-describing and run→Job is navigable without a live
    // kube query.
    const fresh = new Date(Date.now() - 30 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: fresh,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    const jobName = `ac-agent-${runId.slice(0, 8)}-abcdef`;
    mockListAgentJobRunStatuses.mockResolvedValueOnce(
      new Map([[runId, { phase: "active" as const, name: jobName }]]),
    );

    const result = await heartbeat.reapOrphanedRuns();

    expect(result.reaped).toBe(0);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.externalRunId).toBe(jobName);
  });

  it("reaps a pre-adapter external-lifecycle orphan even when updatedAt is freshly churned by review machinery (BLO-8827)", async () => {
    // Observed in prod 2026-06-03: a MulticastEngineer opencode_k8s run sat
    // `running` for 4h+ with no backing Job and no adapter.invoke event (a
    // pre-adapter orphan from a pod rollout). The silent-active-run /
    // board-recovery review loop bumped heartbeat_runs.updated_at every ~minute,
    // and the reaper used updatedAt as a freshness proxy (both the pre-adapter
    // grace via externalLifecycleRecentRefTime AND the staleThreshold gate), so
    // the dead run was shielded from reaping indefinitely — the review meant to
    // recover it kept it alive. Staleness must key on genuine activity
    // (lastOutputAt/startedAt/createdAt/finishedAt), never updatedAt.
    const { runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: null, // pre-adapter: never produced output
    });
    // No adapter.invoke event seeded -> pre-adapter. startedAt/createdAt are
    // ancient (fixture default). Simulate review-machinery churn bumping
    // updatedAt to "now" within the staleness/grace windows.
    await db.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    // No live Job for this run.
    mockListAgentJobRunStatuses.mockResolvedValueOnce(new Map());

    const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 });

    expect(result.runIds).toContain(runId);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
  });

  it("reaps external-lifecycle runs whose kube-API Job is live but output is silent past the staleness window (RCA 2026-05-06)", async () => {
    // The harness reaper used to trust kube-API Job liveness as an oracle:
    // if the Job existed, the run was assumed healthy. RCA on 2026-05-06
    // showed 4 distinct in-pod hang causes (tail-loop wrapper, MCP RPC
    // with no client timeout, Webflow MCP unresponsiveness, rate-limit
    // overage rejected) where the Job stayed Running for hours while the
    // process inside was wedged. The reaper now applies the same silence
    // floor (EXTERNAL_LIFECYCLE_STALE_MS) regardless of Job liveness, and
    // cascades the Job deletion so the dispatch lock unwedges.
    const stale = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: stale,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    mockListLiveAgentJobRunIds.mockResolvedValueOnce(new Set([runId]));

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
    expect(mockDeleteAgentJobsForRun).toHaveBeenCalledWith(runId);
  });

  it("does not cascade-delete the Job when the run is reaped because the Job was already gone", async () => {
    // Job-deleted path (helm restart, manual cleanup) with silence past
    // the staleness window. The Job is already gone, so we have nothing
    // to cascade-delete. Asserts we don't make a redundant delete call.
    const stale = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: stale,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    mockListLiveAgentJobRunIds.mockResolvedValueOnce(new Set());

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(mockDeleteAgentJobsForRun).not.toHaveBeenCalled();
  });

  it("reaps external-lifecycle runs whose kube-API Job is gone AND output is silent past the staleness window", async () => {
    // The genuine "Job got deleted while agent was hung" case. The kube
    // list returns a snapshot without this run's Job AND the run has been
    // silent for >EXTERNAL_LIFECYCLE_STALE_MS, so we have high confidence
    // the agent is genuinely lost.
    const stale = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: stale,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    mockListLiveAgentJobRunIds.mockResolvedValueOnce(new Set());

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
  });

  it("auto-cancels open stale_active_run_evaluation review when reaper finalizes the run to failed (PCL-2571)", async () => {
    // PCL-2571: the silent-run detector files a CTO review issue when an
    // active run has been silent past the suspicion threshold. There's a
    // race window where the detector flags a run that's about to be
    // process_lost-reaped: detector creates review, reaper then flips run
    // to `failed` with errorCode=process_lost. Historically the review
    // stayed `todo` on CTO's plate indefinitely — 11 such issues accreted
    // in CTO's inbox over 5 days as of 2026-05-25. The reaper now closes
    // any open stale_active_run_evaluation review for the run with an
    // explanatory comment, because the silence is fully explained by the
    // process loss and doesn't require operator review.
    const stale = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: stale,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });

    // Seed a pre-existing review issue for this run — what the detector
    // would have created in the suspicion-threshold sweep moments before
    // the reaper sweep.
    const reviewId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: reviewId,
      companyId,
      title: "Review silent active run for CodexCoder",
      description: "Paperclip detected suspicious output silence on an active heartbeat run.",
      status: "todo",
      priority: "medium",
      originKind: "stale_active_run_evaluation",
      originId: runId,
      originRunId: runId,
      originFingerprint: `stale_active_run:${companyId}:${runId}`,
      issueNumber: 999,
      identifier: `${issuePrefix}-999`,
    });
    mockListLiveAgentJobRunIds.mockResolvedValueOnce(new Set());

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");

    const [review] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewId));
    expect(review?.status).toBe("cancelled");

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, reviewId));
    expect(comments.length).toBeGreaterThanOrEqual(1);
    const body = comments.map((c) => c.body).join("\n");
    expect(body).toContain("Auto-cancelled");
    expect(body).toContain("process_lost");
  });

  it("detaches auto-cancelled stale_active_run_evaluation reviews from source issue blockers (PCL-2571)", async () => {
    const stale = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      adapterType: "claude_k8s",
      agentStatus: "idle",
      processPid: null,
      processGroupId: null,
      includeIssue: true,
      lastOutputAt: stale,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });

    const reviewId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: reviewId,
      companyId,
      title: "Review silent active run for CodexCoder",
      description: "Paperclip detected critical output silence on an active heartbeat run.",
      status: "todo",
      priority: "critical",
      originKind: "stale_active_run_evaluation",
      originId: runId,
      originRunId: runId,
      originFingerprint: `stale_active_run:${companyId}:${runId}`,
      issueNumber: 997,
      identifier: `${issuePrefix}-997`,
    });
    await db
      .update(issues)
      .set({ status: "blocked" })
      .where(eq(issues.id, issueId));
    await db.insert(issueRelations).values({
      companyId,
      issueId: reviewId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    mockListLiveAgentJobRunIds.mockResolvedValueOnce(new Set());

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);

    const [review] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewId));
    expect(review?.status).toBe("cancelled");

    const sourceIssue = await waitForValue(async () => {
      const [row] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId));
      return row?.status === "in_progress" && row.executionRunId !== runId ? row : null;
    });
    expect(sourceIssue?.status).toBe("in_progress");
    expect(sourceIssue?.executionRunId).not.toBe(runId);

    const remainingBlockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, issueId),
        eq(issueRelations.type, "blocks"),
      ));
    expect(remainingBlockers).toEqual([]);
  });

  it("leaves stale_active_run_evaluation review alone when reaper does not finalize the run", async () => {
    // Counter-test for the PCL-2571 fix: if the reaper skips (fresh output,
    // live process, etc.), the existing review issue must NOT be touched.
    const fresh = new Date(Date.now() - 30 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: fresh,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });

    const reviewId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: reviewId,
      companyId,
      title: "Review silent active run for CodexCoder",
      description: "Paperclip detected suspicious output silence on an active heartbeat run.",
      status: "todo",
      priority: "medium",
      originKind: "stale_active_run_evaluation",
      originId: runId,
      originRunId: runId,
      originFingerprint: `stale_active_run:${companyId}:${runId}`,
      issueNumber: 998,
      identifier: `${issuePrefix}-998`,
    });
    mockListLiveAgentJobRunIds.mockResolvedValueOnce(new Set());

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const [review] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewId));
    expect(review?.status).toBe("todo");
  });

  it("does NOT reap external-lifecycle runs whose Job is missing from the kube snapshot when output is still fresh (BLO-6843 false-positive guard)", async () => {
    // RCA 2026-05-23: the kube-API list snapshot can transiently omit
    // healthy Jobs (list timeout returning partial results, eventual
    // consistency, in-flight Jobs not yet visible). Previously we treated
    // any "missing from snapshot" as proof of process loss and reaped
    // immediately, producing ~6.5 false `process_lost`/hr fleet-wide
    // against agents that were still streaming output. The reaper now
    // requires the same silence floor as the live-but-silent path before
    // reaping a missing-Job run.
    const fresh = new Date(Date.now() - 30 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: fresh,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    mockListLiveAgentJobRunIds.mockResolvedValueOnce(new Set());

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).not.toBe("process_lost");
    expect(mockDeleteAgentJobsForRun).not.toHaveBeenCalled();
  });

  it("does not delete a recent terminal external-lifecycle run's live Job", async () => {
    const { runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      runStatus: "failed",
      runErrorCode: "process_lost",
      runError: "Process lost before external adapter invocation -- server may have restarted",
    });
    mockListAgentJobRunStatuses.mockResolvedValueOnce(new Map([[runId, { phase: "active" }]]));

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);
    expect(result.runIds).toEqual([]);
    expect(mockDeleteAgentJobsForRun).not.toHaveBeenCalled();
  });

  it("deletes a stale terminal external-lifecycle run's live Job", async () => {
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    const { runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      runStatus: "failed",
      runErrorCode: "process_lost",
      runError: "Process lost before external adapter invocation -- server may have restarted",
      lastOutputAt: stale,
    });
    mockListAgentJobRunStatuses.mockResolvedValueOnce(new Map([[runId, { phase: "active" }]]));

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);
    expect(mockDeleteAgentJobsForRun).toHaveBeenCalledWith(runId);
  });

  it("finalizes a completed external-lifecycle Job as succeeded and starts the next queued same-agent run", async () => {
    const recent = new Date(Date.now() - 30 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      agentStatus: "idle",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: recent,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });

    const queuedWakeupId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: queuedWakeupId,
      contextSnapshot: {},
      createdAt: new Date(Date.now() + 1000),
      updatedAt: new Date(Date.now() + 1000),
    });

    mockListAgentJobRunStatuses.mockResolvedValueOnce(
      new Map([
        [runId, { phase: "succeeded", reason: "Complete", message: "Job completed" }],
      ]),
    );

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const completedRun = await heartbeat.getRun(runId);
    expect(completedRun?.status).toBe("succeeded");
    expect(completedRun?.errorCode).toBeNull();
    expect(completedRun?.resultJson).toMatchObject({
      externalLifecycleRecovery: {
        reason: "job_complete",
        jobPhase: "succeeded",
      },
    });

    const completedWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, completedRun!.wakeupRequestId!))
      .then((rows) => rows[0] ?? null);
    expect(completedWakeup?.status).toBe("completed");

    await waitForRunToSettle(heartbeat, queuedRunId);
    const queuedRun = await heartbeat.getRun(queuedRunId);
    expect(queuedRun?.status).not.toBe("queued");
  });

  it("finalizes a failed external-lifecycle Job as job_failed without waiting for output silence", async () => {
    const recent = new Date(Date.now() - 30 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: recent,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    mockListAgentJobRunStatuses.mockResolvedValueOnce(
      new Map([
        [runId, { phase: "failed", reason: "BackoffLimitExceeded", message: "Pod failed" }],
      ]),
    );

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("job_failed");
    expect(run?.error).toContain("BackoffLimitExceeded");
    expect(run?.resultJson).toMatchObject({
      externalLifecycleRecovery: {
        reason: "job_failed",
        jobPhase: "failed",
        jobReason: "BackoffLimitExceeded",
      },
    });
    expect(mockDeleteAgentJobsForRun).not.toHaveBeenCalled();
  });

  it("marks a missing external-lifecycle Job as job_missing only after the silence floor", async () => {
    const stale = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: stale,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    mockListAgentJobRunStatuses.mockResolvedValueOnce(new Map());

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("job_missing");
    expect(run?.resultJson).toMatchObject({
      externalLifecycleRecovery: {
        reason: "job_missing",
        jobPhase: "missing",
      },
    });
    expect(mockDeleteAgentJobsForRun).not.toHaveBeenCalled();
  });

  it("reaps external-lifecycle runs whose Job has gone silent past the staleness window", async () => {
    // 16 min ago — past the 15-min EXTERNAL_LIFECYCLE_STALE_MS threshold.
    const stale = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: stale,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
  });

  it("reaps external-lifecycle runs whose in-process await is hung but kube Job is gone (RCA 2026-05-06 #2)", async () => {
    // Companion to the previous 2026-05-06 RCA. The first fix made the reaper
    // ignore "Job alive" as proof of progress; this one makes it ignore
    // "in-process await still pending" as proof of progress for external
    // lifecycle adapters. Trigger today: opencode_k8s preRun lifecycle hook
    // (ccrotate Codex switch) timed out at 30s but spawn `child.kill()` only
    // SIGKILLed the shell, not its grandchildren -- the close event waited
    // for grandchild pipes (~45-97s observed). The in-process await stayed
    // queued in `activeRunExecutions` forever; the reaper used to skip on
    // that and the run was permanently quarantined.
    const stale = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: stale,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    mockListLiveAgentJobRunIds.mockResolvedValueOnce(new Set());
    heartbeat.__test_unsafelyTrackActiveRunExecution(runId);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
  });

  it("does NOT reap non-external-lifecycle runs whose in-process await is still pending", async () => {
    // Inverse guard for the activeRunExecutions skip change. For
    // sessioned-local adapters (codex_local, claude_local, etc.),
    // `activeRunExecutions` IS the authoritative signal that THIS pod is
    // driving the run -- the reaper must not race its own executor. Only
    // external-lifecycle gets the silence/Job fall-through.
    const stale = new Date(Date.now() - 30 * 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "codex_local",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: stale,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    heartbeat.__test_unsafelyTrackActiveRunExecution(runId);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
  });

  it("does not retry recent external-lifecycle runs claimed before adapter invocation", async () => {
    const { runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);
    expect(result.runIds).toEqual([]);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBeNull();
  });

  it("retries stale external-lifecycle runs claimed before adapter invocation", async () => {
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    const { agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: stale,
      contextSnapshot: {
        reviewKind: "pr_review",
        taskKey: "pr_review:paperclipai/paperclip:122",
      },
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) =>
      (row.contextSnapshot as Record<string, unknown> | null)?.retryOfRunId === runId
    );
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("before external adapter invocation");
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      contextSnapshot: {
        reviewKind: "pr_review",
        taskKey: "pr_review:paperclipai/paperclip:123",
        modelProfile: "cheap",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.livenessState).toBe("failed");
    expect(failedRun?.livenessReason).toContain("process_lost");
    expect(failedRun?.resultJson).toMatchObject({
      stopReason: "process_lost",
      timeoutConfigured: false,
      timeoutFired: false,
    });
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("does not queue a process-loss retry for non-PR orphaned local runs", async () => {
    const { agentId, runId } = await seedRunFixture({
      processPid: 999_999_999,
      includeIssue: false,
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
        taskKey: null,
      },
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);

    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");

    const retryChildren = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.retryOfRunId, runId), eq(heartbeatRuns.agentId, agentId)));
    expect(retryChildren).toHaveLength(0);

    const retryWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "process_lost_retry")));
    expect(retryWakeups).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")("reaps orphaned descendant process groups when the parent pid is already gone", async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);

    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
      contextSnapshot: {
        reviewKind: "pr_review",
        taskKey: "pr_review:paperclipai/paperclip:124",
      },
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    expect(await waitForPidExit(orphan.descendantPid, 2_000)).toBe(true);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("descendant process group");

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.status).toBe("queued");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
  });

  it("blocks the issue when process-loss retry is exhausted and the immediate continuation recovery also fails", async () => {
    mockAdapterExecute.mockRejectedValueOnce(new Error("continuation recovery failed"));

    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const resolvedBlockerId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: resolvedBlockerId,
      companyId,
      title: "Already completed prerequisite",
      status: "done",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: resolvedBlockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    expect(runs.find((row) => row.id === runId)?.status).toBe("failed");
    const continuationRun = runs.find((row) => row.id !== runId);
    expect(continuationRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
    });
    if (!continuationRun?.id) throw new Error("Expected continuation recovery run to exist");

    const settledContinuationRun = await waitForRunToSettle(heartbeat, continuationRun.id, 10_000);
    expect(settledContinuationRun?.status).toBe("failed");

    const blockedIssue = await waitForValue(
      async () => db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const issue = rows[0] ?? null;
        return issue?.status === "blocked" ? issue : null;
      }),
      10_000,
    );
    expect(blockedIssue?.status).toBe("blocked");
    expect(blockedIssue?.executionRunId).toBeNull();
    expect(blockedIssue?.checkoutRunId).toBeNull();

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId: continuationRun.id,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations.map((relation) => relation.issueId)).toEqual([]);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments![0]?.body).toContain("retried continuation");
    expect(comments![0]?.body).toContain(`Recovery action: ${recovery.id}`);
  });

  it("blocks failed recovery work in place during immediate terminal-run cleanup", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
      runErrorCode: "process_lost",
      runError: "Authorization: Bearer sk-test-recovery-secret",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const recoveryIssue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const issue = rows[0] ?? null;
        return issue?.status === "blocked" ? issue : null;
      })
    );
    expect(recoveryIssue?.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue?.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue?.originId).toBe(sourceIssueId);
    expect(recoveryIssue?.executionRunId).toBeNull();

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments![0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments![0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    // Failure summary surfaces the errorCode (and a redacted error message
    // when present) so the recovery agent can see WHY the original assignee
    // failed without inspecting the linked run. Secrets are still scrubbed
    // — see the explicit `not.toContain` assertion above where applicable.
    expect(comments![0]?.body).toContain("Latest retry failure:");
    expect(comments![0]?.body).not.toContain("sk-test-recovery-secret");
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);
  });

  it("does not block paused-tree work when immediate continuation recovery is suppressed by the hold", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "pause immediate recovery subtree",
      releasePolicy: { strategy: "manual" },
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("schedules a bounded retry for codex transient upstream failures instead of blocking the issue immediately", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      errorMessage:
        "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
      provider: "openai",
      model: "gpt-5.4",
      resultJson: {
        errorFamily: "transient_upstream",
      },
    });

    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const runs = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return rows.length >= 2 ? rows : null;
    });
    expect(runs).toHaveLength(2);

    const failedRun = runs?.find((row) => row.id === runId);
    const retryRun = runs?.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("adapter_failed");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("transient_upstream");
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect(retryRun?.contextSnapshot).toMatchObject({
      codexTransientFallbackMode: "same_session",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("tracks the first heartbeat with the agent role instead of adapter type", async () => {
    const { agentId, runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });

    await heartbeat.cancelRun(runId);

    expect(mockTrackAgentFirstHeartbeat).toHaveBeenCalledWith(
      mockTelemetryClient,
      expect.objectContaining({
        agentRole: "engineer",
        agentId,
      }),
    );
  });

  it("records manual cancellation stop metadata", async () => {
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.resultJson).toMatchObject({
      stopReason: "cancelled",
      effectiveTimeoutSec: 0,
      timeoutConfigured: false,
      timeoutFired: false,
    });
  });

  it("cancelRun cascades Job deletion for claude_k8s (RCA 2026-05-06)", async () => {
    // The reaper-driven path got cascade-delete in PR #108; this is the
    // sibling path for explicit operator/board cancel. Without this,
    // UPDATE'ing status='cancelled' still left the Job alive and the
    // next dispatch hit "Concurrent run blocked".
    const { runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      agentStatus: "running",
      includeIssue: false,
    });

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(mockDeleteAgentJobsForRun).toHaveBeenCalledWith(runId);
  });

  it("reaper deletes stale live external-lifecycle Jobs whose heartbeat run is already terminal", async () => {
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    const { runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      runStatus: "failed",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      runErrorCode: "process_lost",
      runError: "Historical terminal run still has a live Job",
      lastOutputAt: stale,
    });
    mockListAgentJobRunStatuses.mockResolvedValueOnce(
      new Map([
        [runId, { phase: "active", reason: null, message: null }],
      ]),
    );

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);
    expect(mockDeleteAgentJobsForRun).toHaveBeenCalledWith(runId);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
  });

  it("cancelRun does not cascade Job deletion for local adapters", async () => {
    const { runId } = await seedRunFixture({
      adapterType: "codex_local",
      agentStatus: "running",
      includeIssue: false,
    });

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(mockDeleteAgentJobsForRun).not.toHaveBeenCalled();
  });

  it("dispatches assigned todo work with no prior run as a normal assignment wake", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId,
        mutation: "assigned_todo_liveness_dispatch",
      }),
    });
    expect(wakeups[0]?.payload as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.retryOfRunId).toBeNull();
    expect(runs[0]?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "issue_assigned",
      source: "issue.assigned_todo_liveness_dispatch",
    });
    expect(runs[0]?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    expect((runs[0]?.contextSnapshot as Record<string, unknown>)?.retryReason).toBeUndefined();

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    if (runs[0]?.id) {
      await waitForRunToSettle(heartbeat, runs[0].id);
    }
  });

  it("does not duplicate initial assigned todo dispatch when a queued wake already exists", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "assigned_todo_liveness_dispatch" },
      status: "queued",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  // BLO-3220 double-dispatch fix: two wakeup paths can each insert a queued
  // heartbeat_run for the same (agent, issue) on the same tick (user-clicked
  // Retry + scheduled tick + dependency fanout, etc.). Pre-fix, the dispatcher
  // claimed and dispatched both; the second lost the k8s Job creation race
  // and surfaced as `Concurrent run blocked: orphaned Job ...` in the UI.
  it("collapses duplicate queued runs for the same (agent, issue) to one dispatch", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();
    const olderRunId = randomUUID();
    const newerRunId = randomUUID();
    const olderWakeupId = randomUUID();
    const newerWakeupId = randomUUID();
    const olderTime = new Date(Date.now() - 1_000);
    const newerTime = new Date();

    await db.insert(agentWakeupRequests).values([
      {
        id: olderWakeupId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "first",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
      },
      {
        id: newerWakeupId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "second",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "first",
        status: "queued",
        wakeupRequestId: olderWakeupId,
        contextSnapshot: { issueId },
        createdAt: olderTime,
        updatedAt: olderTime,
      },
      {
        id: newerRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "second",
        status: "queued",
        wakeupRequestId: newerWakeupId,
        contextSnapshot: { issueId },
        createdAt: newerTime,
        updatedAt: newerTime,
      },
    ]);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, olderRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .orderBy(asc(heartbeatRuns.createdAt));

    const winner = runs.find((r) => r.id === olderRunId);
    const loser = runs.find((r) => r.id === newerRunId);
    // Older row wins per startNextQueuedRunForAgent's createdAt-ASC tie-break.
    // We only assert the winner was claimed past `queued` — the dedupe gate's
    // job is to ensure exactly one row leaves the queued state per (agent,
    // issue). Where the winner's mocked-adapter run ultimately lands is
    // executeRun-setup territory covered by other tests.
    //
    // Don't assert `runs.length` (BLO-6119): the file-level mock-adapter
    // response includes `summary`, which makes `isProductiveSuccessfulRun`
    // true on the winner's completion. That fires `handleSuccessfulRunHandoff`
    // and `finalizeIssueCommentPolicy` (wakeReason was issue_assigned with
    // no comment posted by the mock) as fire-and-forget corrective wakes,
    // each of which can enqueue a 3rd row before the test reads the table.
    // Per-row assertions on (winner, loser) independently of total count is
    // the proven pattern from 6a056f8f. Local repro is flaky (passes ~50%
    // of runs); CI surfaces it more consistently.
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    expect(winner?.status).not.toBe("queued");
    expect(winner?.status).not.toBe("cancelled");
    expect(loser?.status).toBe("cancelled");
    expect(loser?.errorCode).toBe("duplicate_dispatch_suppressed");
    expect(loser?.error).toContain("sibling run is already dispatched");
    expect(loser?.resultJson).toMatchObject({
      stopReason: "duplicate_dispatch_suppressed",
      timeoutSource: "duplicate_dispatch_gate",
      timeoutFired: false,
    });

    const loserWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, newerWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(loserWakeup?.status).toBe("skipped");
  });

  it("reaps orphaned k8s runs before dispatching queued work for the same issue", async () => {
    const stale = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, issueId, runId: orphanRunId } = await seedRunFixture({
      adapterType: "claude_k8s",
      agentStatus: "running",
      includeIssue: true,
      lastOutputAt: stale,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId: orphanRunId });
    mockListLiveAgentJobRunIds.mockResolvedValueOnce(new Set());

    const queuedWakeupId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: queuedWakeupId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
      },
      createdAt: new Date("2026-03-19T00:10:00.000Z"),
      updatedAt: new Date("2026-03-19T00:10:00.000Z"),
    });

    await heartbeat.resumeQueuedRuns();
    await waitForValue(async () => {
      const run = await heartbeat.getRun(queuedRunId);
      return run && run.status !== "queued" ? run : null;
    });

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const orphanRun = runs.find((run) => run.id === orphanRunId);
    const queuedRun = runs.find((run) => run.id === queuedRunId);
    expect(orphanRun).toMatchObject({
      status: "failed",
      errorCode: "process_lost",
    });
    expect(queuedRun?.status).not.toBe("queued");
    expect(queuedRun?.errorCode).not.toBe("duplicate_dispatch_suppressed");
    await heartbeat.cancelRun(queuedRunId);
  });

  it("cancels a queued stale routine duplicate when another open issue owns the execution lock", async () => {
    const { companyId, agentId, issueId: duplicateIssueId } = await seedAssignedTodoNoRunFixture();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const ownerIssueId = randomUUID();
    const ownerRunId = randomUUID();
    const duplicateRunId = randomUUID();
    const duplicateWakeupId = randomUUID();
    const routineId = randomUUID();
    const dispatchFingerprint = "routine-dispatch-fingerprint";

    await db.insert(heartbeatRuns).values({
      id: ownerRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "owner",
      status: "queued",
      contextSnapshot: { issueId: ownerIssueId, wakeReason: "issue_assigned" },
    });

    await db.insert(issues).values({
      id: ownerIssueId,
      companyId,
      title: "Owner routine execution",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: ownerRunId,
      originKind: "routine_execution",
      originId: routineId,
      originFingerprint: dispatchFingerprint,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    await db
      .update(issues)
      .set({
        title: "Stale duplicate routine execution",
        status: "todo",
        assigneeAgentId: agentId,
        originKind: "routine_execution",
        originId: routineId,
        originFingerprint: dispatchFingerprint,
        executionRunId: null,
      })
      .where(eq(issues.id, duplicateIssueId));

    await db.insert(agentWakeupRequests).values({
      id: duplicateWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "duplicate",
      reason: "issue_assigned",
      payload: { issueId: duplicateIssueId },
      status: "queued",
      runId: duplicateRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: duplicateRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "duplicate",
      status: "queued",
      wakeupRequestId: duplicateWakeupId,
      contextSnapshot: { issueId: duplicateIssueId, wakeReason: "issue_assigned" },
    });

    await heartbeat.__test_executeRunForTesting(duplicateRunId);

    const duplicateRun = await heartbeat.getRun(duplicateRunId);
    expect(duplicateRun).toMatchObject({
      status: "cancelled",
      errorCode: "routine_execution_duplicate_suppressed",
    });
    expect(duplicateRun?.resultJson).toMatchObject({
      stopReason: "routine_execution_duplicate_suppressed",
      timeoutSource: "routine_execution_duplicate_gate",
    });

    const duplicateWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, duplicateWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(duplicateWakeup?.status).toBe("skipped");

    const duplicateIssue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, duplicateIssueId))
      .then((rows) => rows[0] ?? null);
    expect(duplicateIssue?.executionRunId).toBeNull();

    const ownerIssue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, ownerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(ownerIssue?.executionRunId).toBe(ownerRunId);
  });

  it("skips budget-blocked assigned todo work with no prior run and continues the sweep", async () => {
    const blocked = await seedAssignedTodoNoRunFixture();
    const unblocked = await seedAssignedTodoNoRunFixture();
    await db.insert(budgetPolicies).values({
      companyId: blocked.companyId,
      scopeType: "agent",
      scopeId: blocked.agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId: blocked.companyId,
      agentId: blocked.agentId,
      issueId: blocked.issueId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([unblocked.issueId]);

    const blockedWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, blocked.agentId));
    expect(blockedWakeups).toHaveLength(0);
    const blockedRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, blocked.agentId));
    expect(blockedRuns).toHaveLength(0);

    const blockedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blocked.issueId))
      .then((rows) => rows[0] ?? null);
    expect(blockedIssue?.status).toBe("todo");

    const unblockedWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, unblocked.agentId));
    expect(unblockedWakeups).toHaveLength(1);
    expect(unblockedWakeups[0]).toMatchObject({
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId: unblocked.issueId,
        mutation: "assigned_todo_liveness_dispatch",
      }),
    });
    expect(unblockedWakeups[0]?.payload as Record<string, unknown>).not.toHaveProperty("modelProfile");
    const unblockedRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, unblocked.agentId));
    expect(unblockedRuns).toHaveLength(1);
    if (unblockedRuns[0]?.id) {
      await waitForRunToSettle(heartbeat, unblockedRuns[0].id);
    }
  });

  it("does not dispatch assigned todo work with no prior run when the agent is paused", async () => {
    const { agentId, issueId } = await seedAssignedTodoNoRunFixture({ agentStatus: "paused" });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("re-enqueues assigned todo work when the last issue run died and no wake remains", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it.each([
    ["failed", "adapter_failed"],
    ["failed", "process_lost"],
    ["timed_out", "adapter_timed_out"],
  ] as const)(
    "re-enqueues stranded in-progress work after a %s/%s run before escalating",
    async (runStatus, runErrorCode) => {
      const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus,
        runErrorCode,
      });

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.dispatchRequeued).toBe(0);
      expect(result.continuationRequeued).toBe(1);
      expect(result.escalated).toBe(0);
      expect(result.issueIds).toEqual([issueId]);

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(2);

      const retryRun = runs.find((row) => row.id !== runId);
      expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
        issueId,
        taskId: issueId,
        retryReason: "issue_continuation_needed",
        retryOfRunId: runId,
        source: "issue.continuation_recovery",
      });
      expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

      const recoveries = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "stranded_issue_recovery"),
            eq(issues.originId, issueId),
          ),
        );
      expect(recoveries).toHaveLength(0);

      if (retryRun?.id) {
        await waitForRunToSettle(heartbeat, retryRun.id);
      }
    },
  );

  it("still re-enqueues stranded assigned todo recovery when an old queued wake exists", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("blocks assigned todo work after the one automatic dispatch recovery was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
      runErrorCode: "process_lost",
      runError: "Authorization: Bearer sk-test-recovery-secret",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "todo",
      retryReason: "assignment_recovery",
    });
    expect(JSON.stringify(recovery.evidence)).not.toContain("sk-test-recovery-secret");
    // Positive: errorCode is surfaced (it's a stable classifier, not
    // sensitive). Redacted message text follows it so the recovery agent
    // can see what happened without leaking the embedded bearer token.
    expect(String(recovery.evidence.latestRunFailureSummary)).toContain("`process_lost`");
    expect(String(recovery.evidence.latestRunFailureSummary)).toContain("Authorization: Bearer ***REDACTED***");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried dispatch");
    // Failure summary surfaces the errorCode (and a redacted error message
    // when present) so the recovery agent can see WHY the original assignee
    // failed without inspecting the linked run. Secrets are still scrubbed
    // — see the explicit `not.toContain` assertion above where applicable.
    expect(comments[0]?.body).toContain("Latest retry failure:");
    expect(comments[0]?.body).toContain(`Recovery action: ${recovery.id}`);
  });

  it("assigns open unassigned blockers back to their creator agent", async () => {
    const companyId = randomUUID();
    const creatorAgentId = randomUUID();
    const blockedAssigneeAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "SecurityEngineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAssigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Fix blocker",
        status: "todo",
        priority: "high",
        createdByAgentId: creatorAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked work",
        status: "blocked",
        priority: "high",
        assigneeAgentId: blockedAssigneeAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
      createdByAgentId: creatorAgentId,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.orphanBlockersAssigned).toBe(1);
    expect(result.issueIds).toContain(blockerIssueId);

    const blocker = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(blocker?.assigneeAgentId).toBe(creatorAgentId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockerIssueId));
    expect(comments[0]?.body).toContain("Assigned Orphan Blocker");
    expect(comments[0]?.body).toContain(`[${issuePrefix}-2](/${issuePrefix}/issues/${issuePrefix}-2)`);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, creatorAgentId));
    expect(wakeups).toEqual([
      expect.objectContaining({
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: blockerIssueId,
          mutation: "unassigned_blocker_recovery",
        }),
      }),
    ]);

    const runId = wakeups[0]?.runId;
    if (runId) {
      await waitForRunToSettle(heartbeat, runId);
    }
  });

  it("re-enqueues continuation for stranded in-progress work with no active run", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("issue_continuation_needed");
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("does not continue seeded in-progress work that has no run linkage", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Seeded in-flight work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();
  });

  it("classifies actionable plan-only recovery and enqueues one liveness continuation", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "I will inspect the repo next and then implement the fix.",
      provider: "test",
      model: "test-model",
      resultJson: { summary: "I will inspect the repo next and then implement the fix." },
    });
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });

    await heartbeat.reconcileStrandedAssignedIssues();

    const livenessWake = await waitForValue(async () => {
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      return rows.find((row) => row.reason === "run_liveness_continuation") ?? null;
    });
    expect(livenessWake).toBeTruthy();
    expect(livenessWake?.payload).toMatchObject({
      issueId,
      livenessState: "plan_only",
      continuationAttempt: 1,
    });

    const sourceRunId = (livenessWake?.payload as Record<string, unknown> | null)?.sourceRunId;
    expect(sourceRunId).toBeTruthy();
    const sourceRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, String(sourceRunId)))
      .then((rows) => rows[0] ?? null);
    if (sourceRun?.id) {
      await waitForRunToSettle(heartbeat, sourceRun.id, 5_000);
    }
    expect(sourceRun?.id).not.toBe(runId);
    expect(sourceRun?.livenessState).toBe("plan_only");
  });

  it("treats a plan document update as progress and does not enqueue liveness continuation", async () => {
    const { agentId, companyId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Plan",
        format: "markdown",
        latestBody: "# Plan\n\n- Inspect files\n- Implement fix",
        latestRevisionId: revisionId,
        latestRevisionNumber: 1,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId,
        documentId,
        revisionNumber: 1,
        title: "Plan",
        format: "markdown",
        body: "# Plan\n\n- Inspect files\n- Implement fix",
        createdByAgentId: agentId,
        createdByRunId: ctx.runId,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "plan",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Plan:\n- Inspect files\n- Implement fix",
        provider: "test",
        model: "test-model",
        resultJson: { summary: "Plan:\n- Inspect files\n- Implement fix" },
      };
    });

    await heartbeat.reconcileStrandedAssignedIssues();

    const retryRun = await waitForValue(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      return rows.find((row) => row.id !== runId && row.livenessState === "advanced") ?? null;
    }, 5_000);
    if (retryRun?.id) {
      await waitForRunToSettle(heartbeat, retryRun.id, 5_000);
    }
    expect(retryRun?.livenessState).toBe("advanced");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.some((row) => row.reason === "run_liveness_continuation")).toBe(false);
  });
  it("blocks stranded in-progress work after the continuation retry was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried continuation");
    // Failure summary surfaces the errorCode (and a redacted error message
    // when present) so the recovery agent can see WHY the original assignee
    // failed without inspecting the linked run. Secrets are still scrubbed
    // — see the explicit `not.toContain` assertion above where applicable.
    expect(comments[0]?.body).toContain("Latest retry failure:");
    expect(comments[0]?.body).toContain(`Recovery action: ${recovery.id}`);
  });

  it("emits issue.escalation.needs_human_decision once when stranded assigned recovery blocks the issue", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });

    const firstResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(firstResult.escalated).toBe(1);

    const event = await waitForValue(async () => {
      await drainOutbox();
      return emittedPluginEvents.find(
        (item) => item.eventType === "issue.escalation.needs_human_decision" && item.entityId === issueId,
      ) ?? null;
    });

    expect(event).toMatchObject({
      eventType: "issue.escalation.needs_human_decision",
      actorType: "system",
      actorId: "system",
      entityType: "issue",
      entityId: issueId,
      companyId,
      payload: expect.objectContaining({
        issueId,
        identifier: expect.stringMatching(/^T[A-F0-9]{6}-1$/),
        title: "Recover stranded assigned work",
        assigneeAgentId: agentId,
        assigneeAgentName: "CodexCoder",
        blockedByIssueIds: [],
        originSweep: "recovery.reconcile_stranded_assigned_issue",
        transitionedAt: expect.any(String),
      }),
    });
    expect(new Date(String((event?.payload as { transitionedAt?: string } | undefined)?.transitionedAt)).toString()).not.toBe("Invalid Date");

    for (let index = 0; index < 2; index += 1) {
      const repeatResult = await heartbeat.reconcileStrandedAssignedIssues();
      expect(repeatResult.escalated).toBe(0);
    }

    await drainOutbox();
    const matchingEvents = emittedPluginEvents.filter(
      (item) => item.eventType === "issue.escalation.needs_human_decision" && item.entityId === issueId,
    );
    expect(matchingEvents).toHaveLength(1);
  });

  // BLO-1498/BLO-5691: when an in-progress run fails with a non-retryable
  // workspace precondition, the recovery sweep must escalate to `blocked` on
  // the FIRST failure. Retrying would re-hit the same precondition and produce
  // another doomed run.
  it.each(["workspace_import_conflict", "workspace_repo_mismatch"])(
    "blocks stranded in-progress work immediately on non-retryable %s (no retry burnt)",
    async (runErrorCode) => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      // Crucially: no retryReason, so didAutomaticRecoveryFail() is FALSE.
      // The non-retryable errorCode is what must trigger escalation.
      runErrorCode,
      runError: "Workspace import into /srv/paperclip/workspace hit 1 path conflict: release-eng-tmp/magma-blo-1475/orc8r/cloud/go/serde/doc.go",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    // Recovery artifact still gets created so the recovery owner has somewhere
    // to act, but no continuation wake is queued for the source agent.
    await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "unknown",
    });
    const wakeRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeRows.some((row) => row.reason === "issue_continuation_needed")).toBe(false);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(`non-retryable code \`${runErrorCode}\``);
    expect(comments[0]?.body).toContain("Retrying would re-hit the same environment precondition");
  });

  // BLO-1498: same non-retryable rule applies to assigned `todo` work that
  // failed in dispatch. We must not burn the single dispatch retry against a
  // precondition that won't change.
  it.each(["workspace_import_conflict", "workspace_repo_mismatch"])(
    "blocks assigned todo work immediately on non-retryable %s (no retry burnt)",
    async (runErrorCode) => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      runErrorCode,
      runError: "Workspace import into /srv/paperclip/workspace hit 1 path conflict",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "todo",
      retryReason: "unknown",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(`non-retryable code \`${runErrorCode}\``);
  });

  // BLO-5681: when a stranded source issue's latest terminal failure is a
  // structural zero-token pre-model startup wedge (context_overflow /
  // context_length_exceeded / startup_error_pre_model), do NOT spawn a
  // stranded_issue_recovery wrapper — a wrapper inherits the same wedged
  // session and produces another zero-token failed run. Escalate the source
  // straight to `blocked` so a human can clear the wedge. Concretely models
  // the BLO-5378 → BLO-5676 loop: a failed continuation retry that
  // overflowed before the model ran (the gate must apply ahead of
  // didAutomaticRecoveryFail so even a retried failure does not spawn the
  // wrapper).
  it("blocks stranded in-progress work immediately on a zero-token context_overflow startup failure (no recovery wrapper) (BLO-5681)", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "context_overflow",
      runError: "Context window exceeded before first model turn",
      runUsageJson: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.zeroTokenStartupFailureBlocked).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    // The whole point of BLO-5681: NO stranded_issue_recovery wrapper.
    const recoveryWrappers = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, issueId),
        ),
      );
    expect(recoveryWrappers).toHaveLength(0);

    // No continuation wake either — the wedged session must not be re-invoked.
    const wakeRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeRows.some((row) => row.reason === "issue_continuation_needed")).toBe(false);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("context_overflow");
    expect(comments[0]?.body).toContain("burned zero tokens");
    expect(comments[0]?.body).toContain("BLO-5681");
  });

  // BLO-5681: same gate fires in the assigned-todo branch. An absent usage
  // blob counts as zero work, so a startup_error_pre_model failure with no
  // usageJson at all still routes through the no-wrapper path.
  it("blocks assigned todo work immediately on a zero-token startup_error_pre_model failure (no recovery wrapper) (BLO-5681)", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      runErrorCode: "startup_error_pre_model",
      runError: "Adapter crashed before the first model turn",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.zeroTokenStartupFailureBlocked).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recoveryWrappers = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, issueId),
        ),
      );
    expect(recoveryWrappers).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("startup_error_pre_model");
    expect(comments[0]?.body).toContain("skipped automatic dispatch recovery");
  });

  // BLO-5681 counterfactual: a transient `rate_limit_exhausted` retry
  // failure must STILL create a source-scoped recovery action. The zero-token
  // gate must not over-trigger on transient failure codes that happen to
  // report zero usage on the failing attempt.
  it("still creates a recovery action for a transient rate_limit_exhausted continuation retry, even at zero tokens (BLO-5681 counterfactual)", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "rate_limit_exhausted",
      runError: "Provider rate limit exhausted",
      runUsageJson: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);
    expect(result.zeroTokenStartupFailureBlocked).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    // Source-scoped recovery action path is unchanged: the action still exists,
    // but no issue-backed wrapper is created for the source.
    await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });
  });

  it("redacts error-code-only stranded recovery failures in issue copy", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "adapter_exit_code",
      runError: null,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });
    expect(String(recovery.evidence.latestRunFailureSummary)).toContain("Latest retry failure:");
    expect(String(recovery.evidence.latestRunFailureSummary)).toContain("`adapter_exit_code`");
    expect(String(recovery.evidence.latestRunFailureSummary)).not.toContain("- Failure: none recorded");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    // Failure summary surfaces the errorCode (and a redacted error message
    // when present) so the recovery agent can see WHY the original assignee
    // failed without inspecting the linked run. Secrets are still scrubbed
    // — see the explicit `not.toContain` assertion above where applicable.
    expect(comments[0]?.body).toContain("Latest retry failure:");
    expect(comments[0]?.body).not.toContain("- Failure: none recorded");
  });

  it("renders the original assignee's MCPs and capability blurb in the recovery prompt", async () => {
    // BLO-3182 reproducer: original assignee has MCPs (figma, webflow) the
    // recovery agent doesn't. The prompt must surface these so the recovery
    // agent doesn't reflexively reassign.
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "adapter_exit_code",
      runError: null,
    });
    // Decorate the seeded agent with mcpServers + a capability blurb,
    // mirroring the live UXDesigner config that BLO-3182 was originally
    // assigned to.
    await db
      .update(agents)
      .set({
        capabilities: "Owns frontend execution + Webflow CMS edits.",
        adapterConfig: {
          mcpServers: {
            figma: { url: "http://figma-mcp.example", type: "http" },
            webflow: { url: "http://webflow-mcp.example", type: "http" },
          },
        },
      })
      .where(eq(agents.id, agentId));

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });
    expect(recovery.evidence.originalAssigneeMcpKeys).toEqual(["figma", "webflow"]);
    expect(recovery.evidence.originalAssigneeCapabilities).toContain("Owns frontend execution + Webflow CMS edits.");
    // Reminder line nudges the recovery agent to compare capabilities
    // before reassigning.
    expect(recovery.nextAction).toContain("Restore a live execution path");
  });

  it("keeps retrying transient adapter_failed continuation runs before the cap", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "adapter_failed",
      runError: "ssh: connection reset",
    });
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      retryReason: "issue_continuation_needed",
      source: "issue.continuation_recovery",
    });
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("reuses the raced stranded recovery action when duplicate active recovery creation conflicts", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => heartbeat.reconcileStrandedAssignedIssues()),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.status, "active"),
      ));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.attemptCount).toBe(8);
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);
  });

  it("blocks stranded recovery issues in place instead of creating nested recovery issues", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(recoveryIssue?.status).toBe("blocked");
    expect(recoveryIssue?.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue?.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue?.originId).toBe(sourceIssueId);

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    // Failure summary surfaces the errorCode (and a redacted error message
    // when present) so the recovery agent can see WHY the original assignee
    // failed without inspecting the linked run. Secrets are still scrubbed
    // — see the explicit `not.toContain` assertion above where applicable.
    expect(comments[0]?.body).toContain("Latest retry failure:");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);
  });

  it("does not create recovery blockers for provider quota exhaustion", async () => {
    const { companyId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "provider_quota_exhausted",
      runError: "provider quota exhausted; resets later",
    });
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.issueIds).not.toContain(issueId);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.checkoutRunId).toBe(runId);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(recoveryIssues).toHaveLength(0);

    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("keeps repeated recovery failures on the same canonical recovery issue", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });

    const firstResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(firstResult.escalated).toBe(1);
    expect(firstResult.issueIds).toEqual([issueId]);

    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        source: "stranded_issue_recovery",
      },
      startedAt: new Date("2030-03-19T00:10:00.000Z"),
      finishedAt: new Date("2030-03-19T00:15:00.000Z"),
      createdAt: new Date("2030-03-19T00:10:00.000Z"),
      updatedAt: new Date("2030-03-19T00:15:00.000Z"),
      errorCode: "adapter_failed",
      error: "adapter failed while retrying recovery issue",
    });
    await db
      .update(issues)
      .set({
        status: "in_progress",
        checkoutRunId: secondRunId,
        executionRunId: null,
      })
      .where(eq(issues.id, issueId));

    const secondResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(secondResult.dispatchRequeued).toBe(0);
    expect(secondResult.continuationRequeued).toBe(0);
    expect(secondResult.escalated).toBe(1);
    expect(secondResult.issueIds).toEqual([issueId]);

    const recoveryIssuesForSource = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, sourceIssueId)));
    expect(recoveryIssuesForSource.map((issue) => issue.id)).toEqual([issueId]);

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(2);
    expect(comments[1]?.body).toContain("Latest retry failure:");
  });

  it("does not escalate paused-tree recovery when the automatic continuation retry was cancelled by the hold", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "issue_continuation_needed",
      activePauseHold: true,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.checkoutRunId).toBeTruthy();

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
  });

  it("records productive continuation instead of recovery when the latest automatic continuation succeeded", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      livenessState: "advanced",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.productiveContinuationObserved).toBe(1);
    expect(result.successfulContinuationObserved).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(2);
  });

  it("escalates an in_progress issue to blocked after 5 consecutive non-productive succeeded runs (no-op loop)", async () => {
    // BLO-3182 reproducer (compressed): agent succeeds repeatedly with
    // livenessState=null / plan_only / empty_response — the harness posts
    // "No response requested." each time, the issue stays in_progress, the
    // sweep wakes the agent again, and the cycle burns provider quota for
    // zero forward progress. Threshold is 5; seed 5 consecutive succeeded
    // runs with livenessState=null to push the streak over the line.
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      livenessState: null,
    });
    // Seed 4 additional non-productive succeeded runs (5 total counting
    // the fixture's run). createdAt offsets so the lookback orders them
    // most-recent-first and walks them all before bailing.
    const baseTs = new Date("2026-03-19T00:05:00.000Z");
    for (let i = 0; i < 4; i++) {
      const ts = new Date(baseTs.getTime() + (i + 1) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId, taskId: issueId },
        startedAt: ts,
        finishedAt: ts,
        createdAt: ts,
        updatedAt: ts,
        livenessState: null,
      });
    }

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect(result.continuationRequeued).toBe(0);
    expect(result.productiveContinuationObserved).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("consecutive succeeded heartbeat runs producing no actionable output");
    expect(comments[0]?.body).toContain("No response requested.");
    expect(comments[0]?.body).toContain("`blocked`");
  });

  it("escalates when liveness reads `advanced` but the run summary admits no change (BLO-3182 RCA #2)", async () => {
    // 2026-05-06 RCA: UXDesigner waking on heartbeat-timer for BLO-3182
    // had livenessState=advanced ("Run produced concrete action evidence:
    // 1 activity event(s)") because the agent fetched the inbox or read
    // a comment, but the run's own resultJson.summary said "No change.
    // Exiting." The pre-RCA streak counter trusted liveness as the
    // oracle, so the streak never accumulated and the no-op loop
    // escalation never fired. Override: explicit no-op summaries count
    // as non-productive even when liveness disagrees.
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      livenessState: "advanced",
      resultJson: { summary: "No change. Exiting.", result: "No change. Exiting." },
    });
    const baseTs = new Date("2026-03-19T00:05:00.000Z");
    for (let i = 0; i < 4; i++) {
      const ts = new Date(baseTs.getTime() + (i + 1) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId, taskId: issueId },
        startedAt: ts,
        finishedAt: ts,
        createdAt: ts,
        updatedAt: ts,
        livenessState: "advanced",
        resultJson: { summary: "No change. Exiting.", result: "No change. Exiting." },
      });
    }

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
  });

  it("does NOT escalate when one productive run breaks the non-productive streak", async () => {
    // Same setup as above but the most-recent run is productive
    // (livenessState=advanced) — the no-op detector should treat the
    // streak as broken and skip without escalation, even if older runs
    // were non-productive.
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      livenessState: "advanced",
    });
    // Seed 4 older non-productive succeeded runs at earlier timestamps.
    const earlyTs = new Date("2026-03-18T00:00:00.000Z");
    for (let i = 0; i < 4; i++) {
      const ts = new Date(earlyTs.getTime() + i * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId, taskId: issueId },
        startedAt: ts,
        finishedAt: ts,
        createdAt: ts,
        updatedAt: ts,
        livenessState: null,
      });
    }

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(0);
    expect(result.productiveContinuationObserved).toBe(1);
    expect(result.successfulContinuationObserved).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

  });

  it("BLO-7521: does NOT re-escalate after a manual blocked->todo unblock, even with 5 pre-unblock non-productive runs", async () => {
    // BLO-7521 reproducer: CEO/operator manually flips an issue from
    // `blocked` to `todo` (or `in_progress`). The pre-unblock history
    // already contains >= NON_PRODUCTIVE_RUN_NOOP_THRESHOLD consecutive
    // non-productive succeeded runs from the prior wedge. Before the fix,
    // the next sweep cycle read all of those historical runs and re-blocked
    // the issue within ~45-90 seconds of the operator flip, defeating the
    // manual recovery. Fix: scope the lookback to runs created AFTER the
    // most recent `previousStatus=blocked` transition recorded in
    // activity_log.
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      livenessState: null,
    });
    // Seed 4 additional pre-unblock non-productive succeeded runs (5 total
    // counting the fixture's run). Same timestamps as the BLO-3182 test.
    const baseTs = new Date("2026-03-19T00:05:00.000Z");
    for (let i = 0; i < 4; i++) {
      const ts = new Date(baseTs.getTime() + (i + 1) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId, taskId: issueId },
        startedAt: ts,
        finishedAt: ts,
        createdAt: ts,
        updatedAt: ts,
        livenessState: null,
      });
    }
    // Operator unblock landed AFTER all 5 non-productive runs. The
    // activity_log entry has `previousStatus: blocked` from the manual
    // flip back to `todo` / `in_progress`.
    const unblockedAt = new Date(baseTs.getTime() + 10 * 60_000);
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "user",
      actorId: "operator",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { previousStatus: "blocked", status: "in_progress" },
      createdAt: unblockedAt,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // The scoped lookback finds zero runs after `unblockedAt`, so the streak
    // count is 0, well below the threshold. No escalation. The sweep falls
    // through to the normal continuation-recovery path instead.
    expect(result.escalated).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });

  it("BLO-7521: in-place recovery escalator skips when the failed run predates the manual unblock", async () => {
    // BLO-7521 reproducer arm 2: a `stranded_issue_recovery` origin issue
    // whose latest run is an unsuccessful terminal failure. Before the fix,
    // the in-place escalator (`escalateStrandedRecoveryIssueInPlace`) had
    // no gate — any recovery-origin issue with a failed latest run got
    // instant-re-blocked, even if an operator had just unblocked it and
    // the failed run predates the unblock. Fix: skip escalation when the
    // latest run's createdAt <= the most recent unblock timestamp.
    const sourceIssueId = randomUUID();
    const { companyId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    // Pin the failed run's createdAt to a fixed instant so we can place the
    // operator unblock strictly after it. The fixture relies on the schema's
    // defaultNow() for createdAt, which would otherwise race against our
    // unblockedAt comparison.
    const failedRunCreatedAt = new Date("2026-03-19T00:00:00.000Z");
    await db
      .update(heartbeatRuns)
      .set({ createdAt: failedRunCreatedAt })
      .where(eq(heartbeatRuns.id, runId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "done",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    // Operator unblock recorded AFTER the failed run createdAt above.
    const unblockedAt = new Date("2026-03-19T01:00:00.000Z");
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "user",
      actorId: "operator",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { previousStatus: "blocked", status: "in_progress" },
      createdAt: unblockedAt,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // Latest failed run (createdAt 2026-03-19T00:00Z by the fixture) predates
    // the unblock (01:00Z), so the in-place escalator should skip — not
    // re-block — giving the agent a fresh run window.
    expect(result.escalated).toBe(0);
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });

  // BLO-8050: generalize the BLO-7521 "operator-just-unblocked" gate to all
  // six escalation callsites. Without these gates, an issue with a stale
  // failing run gets re-flipped to `blocked` on the next sweep even though
  // the operator's unblock was supposed to grant a fresh run window.
  // Each row exercises one (status × escalation predicate) combination.
  it.each([
    {
      label: "todo + non-retryable terminal run",
      issueStatus: "todo" as const,
      runStatus: "failed" as const,
      runErrorCode: "workspace_import_conflict",
      retryReason: null,
      runUsageJson: null,
    },
    {
      label: "todo + zero-token startup failure run",
      issueStatus: "todo" as const,
      runStatus: "failed" as const,
      runErrorCode: "context_overflow",
      retryReason: null,
      runUsageJson: { inputTokens: 0, outputTokens: 0 },
    },
    {
      label: "todo + automatic-recovery-failed run",
      issueStatus: "todo" as const,
      runStatus: "failed" as const,
      runErrorCode: "process_lost",
      retryReason: "assignment_recovery" as const,
      runUsageJson: null,
    },
    {
      label: "in_progress + non-retryable terminal run",
      issueStatus: "in_progress" as const,
      runStatus: "failed" as const,
      runErrorCode: "workspace_import_conflict",
      retryReason: null,
      runUsageJson: null,
    },
    {
      label: "in_progress + zero-token startup failure run",
      issueStatus: "in_progress" as const,
      runStatus: "failed" as const,
      runErrorCode: "context_overflow",
      retryReason: null,
      runUsageJson: { inputTokens: 0, outputTokens: 0 },
    },
    {
      label: "in_progress + automatic-recovery-failed run",
      issueStatus: "in_progress" as const,
      runStatus: "failed" as const,
      runErrorCode: "process_lost",
      retryReason: "issue_continuation_needed" as const,
      runUsageJson: null,
    },
  ])(
    "BLO-8050: $label — skips re-escalation when failed run predates the manual unblock",
    async ({ issueStatus, runStatus, runErrorCode, retryReason, runUsageJson }) => {
      const { companyId, issueId, runId } = await seedStrandedIssueFixture({
        status: issueStatus,
        runStatus,
        runErrorCode,
        retryReason: retryReason ?? undefined,
        runUsageJson: runUsageJson ?? undefined,
      });
      // Pin failed run timestamp so the operator unblock can be placed strictly
      // after it. Without this the fixture's defaultNow() would race the
      // unblockedAt comparison and the gate wouldn't fire deterministically.
      const failedRunCreatedAt = new Date("2026-03-19T00:00:00.000Z");
      await db
        .update(heartbeatRuns)
        .set({ createdAt: failedRunCreatedAt })
        .where(eq(heartbeatRuns.id, runId));
      const unblockedAt = new Date("2026-03-19T01:00:00.000Z");
      await db.insert(activityLog).values({
        id: randomUUID(),
        companyId,
        actorType: "user",
        actorId: "operator",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { previousStatus: "blocked", status: issueStatus },
        createdAt: unblockedAt,
      });

      const result = await heartbeat.reconcileStrandedAssignedIssues();

      // Pre-fix: this branch would call escalateStrandedAssignedIssue (or
      // escalateZeroTokenStartupFailureIssue) and flip the issue back to
      // `blocked`, defeating the manual unblock. Post-fix: the gate sees
      // latestRun.createdAt <= unblockedAt and skips.
      expect(result.escalated).toBe(0);
      expect(result.zeroTokenStartupFailureBlocked).toBe(0);
      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issue?.status).toBe(issueStatus);
    },
  );

  it("does not treat a productive terminal run as healthy when in-progress work has no live path", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const sourceIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(sourceIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      executionRunId: null,
    });

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"])));
    expect(activeRuns).toHaveLength(0);

    const liveWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
    expect(liveWakeups).toHaveLength(0);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.productiveContinuationObserved).toBe(0);
    expect(result.continuationRequeued + result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    const followupRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(comments).toHaveLength(0);
    expect(recoveryIssues).toHaveLength(0);
    expect(followupRuns).toHaveLength(2);
    const retryRun = followupRuns.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
  });

  it("does not reconcile user-assigned work through the agent stranded-work recovery path", async () => {
    const { issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      assignToUser: true,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runs).toHaveLength(1);
  });

  // BLO-8677: suppression of repeated non-assignee (CTO/manager) wakes when
  // no new issue activity has occurred since the last recovery attempt.
  describe("source-scoped stranded recovery: non-assignee wake suppression (BLO-8677)", () => {
    async function seedWithCto(input?: {
      existingAction?: { lastAttemptAt: Date; attemptCount?: number };
      issueLastActivityAt?: Date;
    }) {
      const fixture = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus: "failed",
        retryReason: "issue_continuation_needed",
      });
      const { companyId, agentId, issueId } = fixture;

      const ctoAgentId = randomUUID();
      await db.insert(agents).values({
        id: ctoAgentId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      if (input?.existingAction) {
        await db.insert(issueRecoveryActions).values({
          companyId,
          sourceIssueId: issueId,
          kind: "stranded_assigned_issue",
          status: "active",
          ownerType: "agent",
          ownerAgentId: ctoAgentId,
          previousOwnerAgentId: agentId,
          returnOwnerAgentId: agentId,
          cause: "stranded_assigned_issue",
          fingerprint: `source_scoped_recovery:${companyId}:${issueId}:stranded_assigned_issue:${agentId}`,
          evidence: {},
          nextAction:
            "Restore a live execution path, fix the runtime/adapter failure, or record an intentional manual resolution.",
          attemptCount: input.existingAction.attemptCount ?? 1,
          lastAttemptAt: input.existingAction.lastAttemptAt,
        });
      }

      if (input?.issueLastActivityAt !== undefined) {
        await db.update(issues).set({ lastActivityAt: input.issueLastActivityAt }).where(eq(issues.id, issueId));
      }

      return { ...fixture, ctoAgentId };
    }

    async function getRecoveryWakeups(agentId: string) {
      return db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.reason, "source_scoped_recovery_action"),
          ),
        );
    }

    it("first attempt: always wakes the CTO owner without suppression", async () => {
      const { agentId, issueId, ctoAgentId } = await seedWithCto();

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.escalated).toBe(1);
      expect(result.issueIds).toEqual([issueId]);

      const ctoWakeups = await getRecoveryWakeups(ctoAgentId);
      expect(ctoWakeups).toHaveLength(1);
      const ctoPayload = ctoWakeups[0]?.payload as Record<string, unknown> | null;
      expect(ctoPayload).not.toMatchObject({ suppressedNonAssigneeWake: true });

      const assigneeWakeups = await getRecoveryWakeups(agentId);
      expect(assigneeWakeups).toHaveLength(0);
    });

    it("second attempt with no new issue activity: suppresses CTO wake and routes to assignee", async () => {
      const now = Date.now();
      const lastAttemptAt = new Date(now - 60_000); // 1 min ago
      const issueLastActivityAt = new Date(now - 300_000); // 5 min ago (before lastAttemptAt → no new activity)

      const { companyId, agentId, issueId, ctoAgentId } = await seedWithCto({
        existingAction: { lastAttemptAt },
        issueLastActivityAt,
      });

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.escalated).toBe(1);
      expect(result.issueIds).toEqual([issueId]);

      const ctoWakeups = await getRecoveryWakeups(ctoAgentId);
      expect(ctoWakeups).toHaveLength(0);

      const assigneeWakeups = await getRecoveryWakeups(agentId);
      expect(assigneeWakeups).toHaveLength(1);
      const assigneePayload = assigneeWakeups[0]?.payload as Record<string, unknown> | null;
      expect(assigneePayload).toMatchObject({ suppressedNonAssigneeWake: true });

      const action = await db
        .select()
        .from(issueRecoveryActions)
        .where(
          and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)),
        )
        .then((rows) => rows[0] ?? null);
      expect(action?.attemptCount).toBe(2);
    });

    it("second attempt with new issue activity since last attempt: allows CTO wake", async () => {
      const now = Date.now();
      const lastAttemptAt = new Date(now - 300_000); // 5 min ago
      const issueLastActivityAt = new Date(now - 60_000); // 1 min ago (after lastAttemptAt → new activity)

      const { agentId, issueId, ctoAgentId } = await seedWithCto({
        existingAction: { lastAttemptAt },
        issueLastActivityAt,
      });

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.escalated).toBe(1);
      expect(result.issueIds).toEqual([issueId]);

      const ctoWakeups = await getRecoveryWakeups(ctoAgentId);
      expect(ctoWakeups).toHaveLength(1);
      const ctoPayload = ctoWakeups[0]?.payload as Record<string, unknown> | null;
      expect(ctoPayload).not.toMatchObject({ suppressedNonAssigneeWake: true });

      const assigneeWakeups = await getRecoveryWakeups(agentId);
      expect(assigneeWakeups).toHaveLength(0);
    });

    it("owner-is-assignee: no suppression even at high attemptCount and no new activity", async () => {
      // When no manager/CTO exists, the owner falls back to the assignee itself.
      // ownerIsNonAssignee is false in that case, so suppression must not fire.
      const now = Date.now();
      const lastAttemptAt = new Date(now - 300_000);
      const issueLastActivityAt = new Date(now - 600_000);

      const fixture = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus: "failed",
        retryReason: "issue_continuation_needed",
      });
      const { agentId, issueId, companyId } = fixture;

      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: issueId,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: agentId,
        previousOwnerAgentId: agentId,
        returnOwnerAgentId: agentId,
        cause: "stranded_assigned_issue",
        fingerprint: `source_scoped_recovery:${companyId}:${issueId}:stranded_assigned_issue:${agentId}`,
        evidence: {},
        nextAction: "Restore a live execution path.",
        attemptCount: 3,
        lastAttemptAt,
      });
      await db.update(issues).set({ lastActivityAt: issueLastActivityAt }).where(eq(issues.id, issueId));

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.escalated).toBe(1);

      const assigneeWakeups = await getRecoveryWakeups(agentId);
      expect(assigneeWakeups).toHaveLength(1);
      const payload = assigneeWakeups[0]?.payload as Record<string, unknown> | null;
      expect(payload).not.toMatchObject({ suppressedNonAssigneeWake: true });
    });
  });
});
