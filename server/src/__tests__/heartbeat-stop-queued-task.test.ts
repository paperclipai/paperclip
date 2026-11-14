import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { returnStoppedWaitingTaskToTodo } from "../services/heartbeat/stopped-waiting-task.ts";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/index.ts";
import { HttpError } from "../errors.ts";

const gates = vi.hoisted(() => new Map<string, (() => void) | null>());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    const issueId = (context.context as Record<string, unknown> | undefined)?.issueId;
    // One-shot gate: hold only the first run of a gated task so the slot stays busy.
    if (typeof issueId === "string" && gates.get(issueId) === null) {
      await new Promise<void>((resolve) => gates.set(issueId, resolve));
    }
    return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "ok", provider: "test", model: "test" };
  }),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_STOP_QUEUED_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Stop on a task whose run is still waiting in line", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const executedIssueIds = () =>
    mockAdapterExecute.mock.calls.map(([context]) => (context.context as Record<string, unknown>)?.issueId);

  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stop-queued-task-");
    db = createDb(external ?? tempDb!.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    for (const release of gates.values()) release?.();
    gates.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockClear();
    await truncateTablesWithDeadlockRetry(db, `
      TRUNCATE TABLE "issue_comments", "issues", "heartbeat_run_events", "cost_events", "activity_log",
        "heartbeat_runs", "agent_wakeup_requests", "agent_runtime_state", "agents", "companies"
      RESTART IDENTITY CASCADE
    `, { attempts: 10, delayMs: () => 100 });
    await db.delete(authUsers).where(eq(authUsers.id, "responsible-user"));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    return { companyId, agentId };
  }

  async function assignAndWake(companyId: string, agentId: string, title: string, status: "todo" | "in_progress" = "todo") {
    const [issue] = await db.insert(issues).values({ companyId, title, status, assigneeAgentId: agentId }).returning();
    const run = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: issue.id } });
    expect(run).toBeTruthy();
    return { issue, run: run! };
  }

  it.each(["todo", "in_progress"] as const)("takes a %s task out of line in one Stop and still promotes the agent's next task", async (waitingStatus) => {
    const { companyId, agentId } = await seed();
    const busy = randomUUID();
    const [busyIssue] = await db.insert(issues).values({ id: busy, companyId, title: "Busy", status: "todo", assigneeAgentId: agentId }).returning();
    gates.set(busyIssue.id, null);
    const busyRun = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: busyIssue.id } });
    await vi.waitFor(() => expect(executedIssueIds()).toContain(busyIssue.id), { timeout: 10_000 });

    const waiting = await assignAndWake(companyId, agentId, "Waiting task", waitingStatus);
    const next = await assignAndWake(companyId, agentId, "Next task");
    expect((await heartbeat.getRun(waiting.run.id))?.status).toBe("queued");
    expect((await heartbeat.getRun(next.run.id))?.status).toBe("queued");

    const stopped = await heartbeat.cancelRun(waiting.run.id, "Cancelled by a board operator", {
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "responsible-user" },
    });
    expect(stopped?.status).toBe("cancelled");
    // The board Stop route follows the cancel with this status return.
    await returnStoppedWaitingTaskToTodo(db, stopped!, { userId: "responsible-user" });

    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.run.wakeupRequestId!));
    expect(wake.status).toBe("cancelled");
    const [waitingIssue] = await db.select().from(issues).where(eq(issues.id, waiting.issue.id));
    expect(waitingIssue.executionRunId).toBeNull();
    expect(waitingIssue.status).toBe("todo");
    const statusActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, waiting.issue.id));
    expect(statusActivity.filter((row) => row.action === "issue.updated")).toHaveLength(waitingStatus === "in_progress" ? 1 : 0);

    // Free the slot: the agent's next task promotes, the stopped one never runs again.
    gates.get(busyIssue.id)?.();
    await vi.waitFor(() => expect(executedIssueIds()).toContain(next.issue.id), { timeout: 45_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.reconcileStrandedAssignedIssues();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(executedIssueIds()).not.toContain(waiting.issue.id);
    const laterRuns = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${waiting.issue.id}`);
    expect(laterRuns).toEqual([{ id: waiting.run.id, status: "cancelled" }]);
    const [afterIssue] = await db.select().from(issues).where(eq(issues.id, waiting.issue.id));
    expect(afterIssue.status).toBe("todo");
    expect(afterIssue.executionRunId).toBeNull();
    expect(busyRun).toBeTruthy();
  }, 120_000);

  /** Hold the task row in another transaction until `release` is called. */
  async function holdTaskRow(issueId: string) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      locked();
      await released;
    });
    await lockTaken;
    return { release, holder };
  }

  async function queueBehindBusyTask() {
    const { companyId, agentId } = await seed();
    const [busyIssue] = await db.insert(issues).values({ companyId, title: "Busy", status: "todo", assigneeAgentId: agentId }).returning();
    gates.set(busyIssue.id, null);
    await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: busyIssue.id } });
    await vi.waitFor(() => expect(executedIssueIds()).toContain(busyIssue.id), { timeout: 10_000 });
    const waiting = await assignAndWake(companyId, agentId, "Waiting task");
    const queued = await heartbeat.getRun(waiting.run.id);
    expect(queued?.status).toBe("queued");
    expect(queued?.runtimeMode).toBe("legacy");
    return waiting;
  }

  // The board route attributes Stop to the user, which first supersedes the
  // task's handoffs under the same task-row lock.
  const stopCallers = [
    { caller: "control plane", reason: "Cancelled by control plane", options: undefined },
    { caller: "board", reason: "Cancelled by a board operator",
      options: { resultJson: { cancelledByActorType: "user", cancelledByUserId: "responsible-user" } } },
  ] as const;

  it.each(stopCallers)("stops a waiting legacy run for the $caller when another writer briefly holds its task row past the lock timeout", async ({ reason, options }) => {
    const waiting = await queueBehindBusyTask();
    const lock = await holdTaskRow(waiting.issue.id);
    // Longer than one 1s lock_timeout, shorter than the bounded attempts.
    const releaseTimer = setTimeout(lock.release, 1_500);
    try {
      const stopped = await heartbeat.cancelRun(waiting.run.id, reason, options);
      expect(stopped?.status).toBe("cancelled");
    } finally {
      clearTimeout(releaseTimer);
      lock.release();
      await lock.holder;
    }
    expect((await heartbeat.getRun(waiting.run.id))?.status).toBe("cancelled");
  }, 60_000);

  it.each(stopCallers)("answers the $caller a retryable conflict when the task row stays locked through every attempt", async ({ reason, options }) => {
    const waiting = await queueBehindBusyTask();
    const lock = await holdTaskRow(waiting.issue.id);
    try {
      const startedAt = Date.now();
      const error = await heartbeat.cancelRun(waiting.run.id, reason, options).then(
        () => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(409);
      expect((error as HttpError).details).toMatchObject({ code: "run_stop_busy", runId: waiting.run.id });
      // Bounded: three 1s waits plus short backoff, never an open-ended queue.
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      lock.release();
      await lock.holder;
    }
    // Nothing was committed, so the same Stop succeeds once the writer is done.
    expect((await heartbeat.getRun(waiting.run.id))?.status).toBe("queued");
    const stopped = await heartbeat.cancelRun(waiting.run.id, reason, options);
    expect(stopped?.status).toBe("cancelled");
  }, 60_000);
});
