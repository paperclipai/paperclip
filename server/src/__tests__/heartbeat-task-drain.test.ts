import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  applyTaskDrain,
  computeTaskDrain,
  getTaskDrainStatus,
  heartbeatService,
  isTaskDrainGenerationLive,
  resolveHeartbeatSchedulingSuppression,
  startTaskDrain,
  stopTaskDrain,
} from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const GRACE_ENV_KEY = "PAPERCLIP_TASK_DRAIN_TERMINATION_GRACE_PERIOD_SECONDS";

describe("heartbeat task drain", () => {
  afterEach(() => {
    stopTaskDrain();
    vi.useRealTimers();
    delete process.env[GRACE_ENV_KEY];
  });

  it("start_task_drain_suppresses_admission", () => {
    startTaskDrain({});
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });
  });

  it("stop_task_drain_restores_admission", () => {
    startTaskDrain({});
    expect(stopTaskDrain()).toEqual({ wasActive: true });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(stopTaskDrain()).toEqual({ wasActive: false });
  });

  it("null_ttl_produces_no_expiry", () => {
    const { expiresAt } = startTaskDrain({ ttlMs: null });
    expect(expiresAt).toBeNull();
    expect(getTaskDrainStatus().expiresAt).toBeNull();
  });

  it("an_expired_ttl_ends_the_drain_and_restores_admission", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    startTaskDrain({ ttlMs: 1000 });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(getTaskDrainStatus().draining).toBe(false);
  });

  it("status_reports_quiescent_when_both_promise_sets_are_empty", () => {
    startTaskDrain({});
    const status = getTaskDrainStatus();
    expect(status.draining).toBe(true);
    expect(status.activeRuns).toBe(0);
    expect(status.pendingWakes).toBe(0);
    expect(status.quiescent).toBe(true);
  });

  describe("computeTaskDrain termination deadline", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    });

    it("compute_task_drain_without_the_option_has_no_terminate_at", () => {
      const drain = computeTaskDrain({ ttlMs: 60_000 });
      expect(drain.terminateActiveTasks).toBe(false);
      expect(drain.terminateAt).toBeNull();
    });

    it("compute_task_drain_sets_terminate_at_one_grace_period_before_expiry", () => {
      process.env[GRACE_ENV_KEY] = "30";
      const drain = computeTaskDrain({ ttlMs: 60_000, terminateActiveTasks: true });
      expect(drain.terminateActiveTasks).toBe(true);
      expect(drain.expiresAt).toEqual(new Date("2026-01-01T00:01:00.000Z"));
      expect(drain.terminateAt).toEqual(new Date("2026-01-01T00:00:30.000Z"));
    });

    it("compute_task_drain_with_the_option_and_no_ttl_has_no_terminate_at", () => {
      const drain = computeTaskDrain({ ttlMs: null, terminateActiveTasks: true });
      expect(drain.expiresAt).toBeNull();
      expect(drain.terminateAt).toBeNull();
    });

    it("compute_task_drain_with_a_ttl_below_the_grace_period_terminates_immediately", () => {
      process.env[GRACE_ENV_KEY] = "30";
      const drain = computeTaskDrain({ ttlMs: 5_000, terminateActiveTasks: true });
      // The grace period would push the deadline before the drain started;
      // the clamp holds it at startedAt instead of a time in the past.
      expect(drain.terminateAt).toEqual(drain.startedAt);
    });

    it("compute_task_drain_uses_thirty_seconds_for_an_invalid_grace_environment_value", () => {
      const oneMinute = { ttlMs: 60_000, terminateActiveTasks: true };
      const expectedTerminateAt = new Date("2026-01-01T00:00:30.000Z");

      delete process.env[GRACE_ENV_KEY];
      expect(computeTaskDrain(oneMinute).terminateAt).toEqual(expectedTerminateAt);

      process.env[GRACE_ENV_KEY] = "";
      expect(computeTaskDrain(oneMinute).terminateAt).toEqual(expectedTerminateAt);

      process.env[GRACE_ENV_KEY] = "not-a-number";
      expect(computeTaskDrain(oneMinute).terminateAt).toEqual(expectedTerminateAt);

      process.env[GRACE_ENV_KEY] = "0";
      expect(computeTaskDrain(oneMinute).terminateAt).toEqual(expectedTerminateAt);

      process.env[GRACE_ENV_KEY] = "-5";
      expect(computeTaskDrain(oneMinute).terminateAt).toEqual(expectedTerminateAt);
    });
  });

  describe("task drain generation", () => {
    it("apply_task_drain_returns_a_new_generation_for_each_drain", () => {
      const first = applyTaskDrain(computeTaskDrain({ ttlMs: 60_000 }));
      const second = applyTaskDrain(computeTaskDrain({ ttlMs: 60_000 }));
      expect(second).not.toBe(first);
      expect(isTaskDrainGenerationLive(second)).toBe(true);
    });

    it("the_generation_of_a_replaced_drain_is_not_live", () => {
      const first = applyTaskDrain(computeTaskDrain({ ttlMs: 60_000 }));
      applyTaskDrain(computeTaskDrain({ ttlMs: 60_000 }));
      expect(isTaskDrainGenerationLive(first)).toBe(false);
    });

    it("the_generation_of_a_stopped_drain_is_not_live", () => {
      const generation = applyTaskDrain(computeTaskDrain({ ttlMs: 60_000 }));
      stopTaskDrain();
      expect(isTaskDrainGenerationLive(generation)).toBe(false);
    });

    it("the_generation_of_an_expired_drain_is_not_live", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const generation = applyTaskDrain(computeTaskDrain({ ttlMs: 1_000 }));
      vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
      expect(isTaskDrainGenerationLive(generation)).toBe(false);
    });

    it("the_generation_of_a_drain_that_a_non_terminating_drain_replaced_is_not_live", () => {
      const terminating = applyTaskDrain(
        computeTaskDrain({ ttlMs: 60_000, terminateActiveTasks: true }),
      );
      applyTaskDrain(computeTaskDrain({ ttlMs: 60_000, terminateActiveTasks: false }));
      expect(isTaskDrainGenerationLive(terminating)).toBe(false);
    });

    it("the_generation_of_a_drain_that_a_new_deadline_replaced_is_not_live", () => {
      const first = applyTaskDrain(
        computeTaskDrain({ ttlMs: 60_000, terminateActiveTasks: true }),
      );
      applyTaskDrain(computeTaskDrain({ ttlMs: 120_000, terminateActiveTasks: true }));
      expect(isTaskDrainGenerationLive(first)).toBe(false);
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task-drain termination tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("terminateActiveRunsForTaskDrain", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-drain-terminate-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fixture agent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedCancellableRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
    });
    return runId;
  }

  it("terminate_active_runs_stops_each_cancellable_run_and_reports_it_for_its_company", async () => {
    const companyAId = await seedCompany();
    const companyBId = await seedCompany();
    const agentAId = await seedAgent(companyAId);
    const agentBId = await seedAgent(companyBId);
    const runAId = await seedCancellableRun(companyAId, agentAId);
    const runBId = await seedCancellableRun(companyBId, agentBId);

    const outcomes = await heartbeatService(db).terminateActiveRunsForTaskDrain(
      "Task drain termination",
    );

    expect(outcomes.get(companyAId)).toEqual({
      attemptedRunIds: [runAId],
      cancelledRunIds: [runAId],
      failedRunIds: [],
    });
    expect(outcomes.get(companyBId)).toEqual({
      attemptedRunIds: [runBId],
      cancelledRunIds: [runBId],
      failedRunIds: [],
    });
  });

  it("terminate_active_runs_reports_an_empty_result_when_no_run_is_active", async () => {
    const outcomes = await heartbeatService(db).terminateActiveRunsForTaskDrain(
      "Task drain termination",
    );
    expect(outcomes.size).toBe(0);
  });

  it("terminate_active_runs_reports_a_failed_run_and_continues_the_loop", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const okRunId = await seedCancellableRun(companyId, agentId);
    // A native run with no bound issue fails deterministically inside the
    // real cancellation path (`native_cancellation_binding_missing`), so
    // this proves the loop keeps going past one failed run without a race.
    // Give it its own agent: cancelling okRunId claims the next queued run
    // for ITS agent, so a shared agent would let that claim reach this run
    // first and fail it for an unrelated reason before termination did.
    const failingAgentId = await seedAgent(companyId);
    const failingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: failingRunId,
      companyId,
      agentId: failingAgentId,
      invocationSource: "assignment",
      status: "queued",
      runtimeMode: "native",
    });

    const outcomes = await heartbeatService(db).terminateActiveRunsForTaskDrain(
      "Task drain termination",
    );

    const outcome = outcomes.get(companyId);
    expect(outcome?.attemptedRunIds.sort()).toEqual([failingRunId, okRunId].sort());
    expect(outcome?.cancelledRunIds).toEqual([okRunId]);
    expect(outcome?.failedRunIds).toEqual([failingRunId]);
  });
});
