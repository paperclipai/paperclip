import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

// Reported bug: a successful run left the agent at status="error" carrying the
// previous run's errorReason, so recovered agents looked permanently broken on
// the board. These tests pin the recovery invariant: errorReason is non-null
// only while the agent is actually in error.

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => null,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const RECOVERY_TEST_ADAPTER = "agent_error_recovery_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent error-status recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const STALE_ERROR_REASON =
  "Persistent ACP session 57c11f11-b7a6-40b8-96af-c5354e05f152 could not be resumed: Internal error";

describeEmbeddedPostgres("agent error status recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let nextAdapterExitCode = 0;
  // Lets a test hold the adapter mid-execution so it can observe the agent row
  // while the run is still in flight, instead of racing the terminal write.
  let gate: { wait: () => Promise<void>; release: () => void } | null = null;
  const executedRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-error-recovery-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: RECOVERY_TEST_ADAPTER,
      execute: async (input) => {
        executedRunIds.push(input.runId);
        if (gate) await gate.wait();
        return {
          exitCode: nextAdapterExitCode,
          signal: null,
          timedOut: false,
          ...(nextAdapterExitCode === 0
            ? {}
            : { errorMessage: "adapter blew up", errorCode: "adapter_failed" }),
        };
      },
      testEnvironment: async () => ({
        adapterType: RECOVERY_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 30_000);

  afterEach(async () => {
    gate?.release();
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "running"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupFixture();
    executedRunIds.length = 0;
    gate = null;
    nextAdapterExitCode = 0;
  });

  afterAll(async () => {
    unregisterServerAdapter(RECOVERY_TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  function createGate() {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { wait: () => released, release };
  }

  async function cleanupFixture() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await cleanupFixtureOnce();
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async function cleanupFixtureOnce() {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  async function waitForRunToLeaveActiveStates(runId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  async function readAgentRow(agentId: string) {
    return await db
      .select({ status: agents.status, errorReason: agents.errorReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function seedErroredAgentFixture() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(projects).values({ id: projectId, companyId, name: "Recovery Project" });

    // The exact reported starting state: status=error carrying a stale reason
    // left over from an earlier failed run.
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RecoveredAgent",
      role: "engineer",
      status: "error",
      errorReason: STALE_ERROR_REASON,
      lastHeartbeatAt: new Date("2026-09-26T16:03:40.628Z"),
      adapterType: RECOVERY_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Do the thing",
      description: "Give the recovered agent real work.",
      status: "todo",
      assigneeAgentId: agentId,
    });

    return { companyId, projectId, agentId, issueId };
  }

  it("reproduces the reported starting state", async () => {
    const fixture = await seedErroredAgentFixture();
    expect(await readAgentRow(fixture.agentId)).toEqual({
      status: "error",
      errorReason: STALE_ERROR_REASON,
    });
  });

  it("clears status=error and errorReason after a successful run", async () => {
    const fixture = await seedErroredAgentFixture();

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("succeeded");
    expect(executedRunIds).toContain(run!.id);

    await expect
      .poll(() => readAgentRow(fixture.agentId), { timeout: 5_000, interval: 50 })
      .toEqual({ status: "idle", errorReason: null });
  });

  it("drops the stale reason once the agent is working again", async () => {
    const fixture = await seedErroredAgentFixture();
    gate = createGate();

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    // Hold the adapter open so the agent row can be read mid-run.
    await expect
      .poll(() => executedRunIds, { timeout: 5_000, interval: 25 })
      .toContain(run!.id);

    // The agent is working again, so the earlier failure is no longer its live
    // state. If this run dies before the terminal transition the agent must not
    // keep advertising the old reason.
    await expect
      .poll(() => readAgentRow(fixture.agentId), { timeout: 5_000, interval: 25 })
      .toEqual({ status: "running", errorReason: null });

    gate.release();
    gate = null;

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("succeeded");
    await expect
      .poll(() => readAgentRow(fixture.agentId), { timeout: 5_000, interval: 50 })
      .toEqual({ status: "idle", errorReason: null });
  });

  it("keeps status=error and refreshes errorReason after a failed run", async () => {
    const fixture = await seedErroredAgentFixture();
    nextAdapterExitCode = 1;

    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("failed");

    await expect
      .poll(() => readAgentRow(fixture.agentId), { timeout: 5_000, interval: 50 })
      .toEqual({ status: "error", errorReason: "adapter blew up" });
  });
});