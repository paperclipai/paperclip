import { randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  FLEET_MAX_CONCURRENT_RUNS_DEFAULT,
  FLEET_MAX_CONCURRENT_RUNS_ENV_VAR,
  computeAvailableRunSlots,
  heartbeatService,
  normalizeFleetMaxConcurrentRuns,
} from "../services/heartbeat.ts";

// The adapter is replaced wholesale: this suite is about how many runs the
// scheduler is willing to start at once, not about what the harness does once
// it starts. Each execution parks on a per-run gate so a "running" row stays
// running while the assertions read the fan-out.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: { runId: string }) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Fleet run cap test run.",
    provider: "test",
    model: "test-model",
  })),
);

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres fleet-run-cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SEEDED_AGENT_COUNT = 6;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function cleanupFixture(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
          "company_skills",
          "issue_comments",
          "issue_documents",
          "document_revisions",
          "documents",
          "issue_relations",
          "issue_tree_holds",
          "issues",
          "heartbeat_run_events",
          "cost_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `));
      return;
    } catch (error) {
      const isLateWriteRace =
        error instanceof Error &&
        (error.message.includes("issue_comments_issue_id_issues_id_fk") ||
          error.message.includes("heartbeat_run_events"));
      if (!isLateWriteRace || attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe("fleet run ceiling helpers", () => {
  it("clamps the configured value to 1..50 and defaults to no ceiling", () => {
    expect(FLEET_MAX_CONCURRENT_RUNS_DEFAULT).toBeNull();
    expect(normalizeFleetMaxConcurrentRuns(undefined)).toBeNull();
    expect(normalizeFleetMaxConcurrentRuns("")).toBeNull();
    expect(normalizeFleetMaxConcurrentRuns("not-a-number")).toBeNull();
    expect(normalizeFleetMaxConcurrentRuns("3")).toBe(3);
    expect(normalizeFleetMaxConcurrentRuns(0)).toBe(1);
    expect(normalizeFleetMaxConcurrentRuns(-4)).toBe(1);
    expect(normalizeFleetMaxConcurrentRuns(500)).toBe(50);
  });

  it("takes the lower of the per-agent cap and the remaining fleet budget", () => {
    // No ceiling: only the per-agent cap binds.
    expect(
      computeAvailableRunSlots({
        agentMaxConcurrentRuns: 20,
        agentRunningRuns: 1,
        fleetMaxConcurrentRuns: null,
        fleetRunningRuns: 7,
      }),
    ).toBe(19);
    // Fleet has room, the agent does not.
    expect(
      computeAvailableRunSlots({
        agentMaxConcurrentRuns: 1,
        agentRunningRuns: 1,
        fleetMaxConcurrentRuns: 5,
        fleetRunningRuns: 1,
      }),
    ).toBe(0);
    // The agent has room, the fleet does not.
    expect(
      computeAvailableRunSlots({
        agentMaxConcurrentRuns: 20,
        agentRunningRuns: 0,
        fleetMaxConcurrentRuns: 2,
        fleetRunningRuns: 2,
      }),
    ).toBe(0);
    // Room on both sides: the fleet term is the binding one.
    expect(
      computeAvailableRunSlots({
        agentMaxConcurrentRuns: 20,
        agentRunningRuns: 0,
        fleetMaxConcurrentRuns: 2,
        fleetRunningRuns: 1,
      }),
    ).toBe(1);
    // Never negative, even if the fleet is somehow over budget.
    expect(
      computeAvailableRunSlots({
        agentMaxConcurrentRuns: 3,
        agentRunningRuns: 9,
        fleetMaxConcurrentRuns: 2,
        fleetRunningRuns: 7,
      }),
    ).toBe(0);
  });
});

describeEmbeddedPostgres("fleet-wide agent run ceiling", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let heartbeatAtCeilingOne!: ReturnType<typeof heartbeatService>;
  let heartbeatAtCeilingTwo!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const gates = new Map<string, () => void>();
  const startedRunIds: string[] = [];
  let blockExecutions = true;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-fleet-run-cap-");
    db = createDb(tempDb.connectionString);
    const runtimeEnv = { ...process.env, PAPERCLIP_IN_WORKTREE: "false" };
    heartbeat = heartbeatService(db, { runtimeEnv });
    heartbeatAtCeilingOne = heartbeatService(db, {
      runtimeEnv: { ...runtimeEnv, [FLEET_MAX_CONCURRENT_RUNS_ENV_VAR]: "1" },
    });
    heartbeatAtCeilingTwo = heartbeatService(db, {
      runtimeEnv: { ...runtimeEnv, [FLEET_MAX_CONCURRENT_RUNS_ENV_VAR]: "2" },
    });
    await ensureIssueRelationsTable(db);

    mockAdapterExecute.mockImplementation(async (context: { runId: string }) => {
      startedRunIds.push(context.runId);
      if (blockExecutions) {
        await new Promise<void>((resolve) => {
          gates.set(context.runId, resolve);
        });
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Fleet run cap test run.",
        provider: "test",
        model: "test-model",
      };
    });
  }, 120_000);

  afterEach(async () => {
    // Runs parked or never started are synthetic: cancel the rows first so the
    // drain below never waits on work that nothing will start.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));
    blockExecutions = false;
    for (const release of gates.values()) release();
    gates.clear();
    await waitForIdle();
    // Clear only after settling: a late invocation from this test must not land
    // in the next test's execution log.
    startedRunIds.length = 0;
    await cleanupFixture(db);
    await waitForCondition(async () => {
      const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return rows.length === 0;
    }, 5_000);
    blockExecutions = true;
  }, 60_000);

  // A claimed run flips to `running` immediately, but the adapter invocation
  // happens after heartbeat's own preparation, so an execution has to be waited
  // for: assert on the gate, not on the DB write. Only this test's own run ids
  // count — heartbeat may dispatch follow-up runs of its own.
  async function waitForExecutionsOf(runIds: string[], count: number, timeoutMs = 60_000) {
    return await waitForCondition(async () => executionsOf(runIds).length >= count, timeoutMs);
  }

  async function isIdle() {
    // Scoped to live companies, which is the set the queued-run sweep can see.
    const rows = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
      .where(eq(companies.status, "active"));
    return !rows.some((row) => row.status === "queued" || row.status === "running");
  }

  async function waitForIdle(timeoutMs = 30_000) {
    // Terminal status precedes completion bookkeeping; require a few
    // consecutive idle reads so those writes land before cleanup truncates.
    const deadline = Date.now() + timeoutMs;
    let idlePolls = 0;
    while (Date.now() < deadline) {
      if (await isIdle()) {
        idlePolls += 1;
        if (idlePolls >= 3) return true;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async function releaseExecution(runId: string) {
    await waitForCondition(async () => gates.has(runId), 30_000);
    gates.get(runId)?.();
    gates.delete(runId);
  }

  afterAll(async () => {
    gates.clear();
    await tempDb?.cleanup();
  });

  async function seedAgentWithQueuedRun(input: { companyId: string; index: number; createdAt: Date }) {
    const agentId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: `FleetCoder${input.index}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `Fleet issue ${input.index}`,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { agentId, issueId, runId };
  }

  async function seedCompanyWithQueuedRuns(count = SEEDED_AGENT_COUNT) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    const seeded = [];
    const base = Date.now() - count * 60_000;
    for (let index = 0; index < count; index += 1) {
      seeded.push(
        await seedAgentWithQueuedRun({
          companyId,
          index,
          // Ticket 0 is the oldest, ticket count-1 the newest.
          createdAt: new Date(base + index * 60_000),
        }),
      );
    }
    return { companyId, seeded };
  }

  // Assertions are scoped to the company this test seeded: completing a run can
  // make heartbeat's own retry/handoff paths enqueue further runs, and those are
  // bounded by the same gate but they are not this test's subject.
  async function listRuns(companyId: string) {
    return await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        createdAt: heartbeatRuns.createdAt,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
  }

  function executionsOf(runIds: string[]) {
    return startedRunIds.filter((runId) => runIds.includes(runId));
  }

  it("starts only the fleet ceiling, keeps the excess queued, and drops no ticket", async () => {
    const { companyId, seeded } = await seedCompanyWithQueuedRuns();
    const seededRunIds = seeded.map((s) => s.runId);
    const expectedRunningRunIds = seededRunIds.slice(0, 2);

    await heartbeatAtCeilingTwo.resumeQueuedRuns();
    expect(await waitForExecutionsOf(seededRunIds, 2)).toBe(true);

    const runs = await listRuns(companyId);
    const running = runs.filter((run) => run.status === "running");
    const queued = runs.filter((run) => run.status === "queued");

    // The cap: never more than the ceiling, whatever the backlog size.
    expect(running).toHaveLength(2);
    expect(running.length).toBeLessThan(SEEDED_AGENT_COUNT);
    // The oldest tickets take the slots (no agent-order starvation).
    expect(running.map((run) => run.id)).toEqual(expectedRunningRunIds);

    // Excess work is queued, not discarded: every ticket still exists and none
    // reached a terminal state.
    expect(runs.map((run) => run.id).sort()).toEqual(seededRunIds.slice().sort());
    expect(queued).toHaveLength(SEEDED_AGENT_COUNT - 2);
    expect(runs.filter((run) => !["queued", "running"].includes(run.status))).toHaveLength(0);

    // And only that many executions were actually dispatched to the adapter.
    expect(executionsOf(seededRunIds).sort()).toEqual(expectedRunningRunIds.slice().sort());
  }, 120_000);

  it("starts the whole backlog when no ceiling is configured", async () => {
    const { companyId, seeded } = await seedCompanyWithQueuedRuns();
    const seededRunIds = seeded.map((s) => s.runId);

    await heartbeat.resumeQueuedRuns();
    expect(await waitForExecutionsOf(seededRunIds, SEEDED_AGENT_COUNT)).toBe(true);

    const runs = await listRuns(companyId);
    // With no ceiling, every seeded ticket gets a slot in the first pass.
    expect(runs.filter((run) => run.status === "running")).toHaveLength(SEEDED_AGENT_COUNT);
  }, 120_000);

  it("honours PAPERCLIP_MAX_CONCURRENT_AGENT_RUNS as the ceiling", async () => {
    const { companyId, seeded } = await seedCompanyWithQueuedRuns();
    const seededRunIds = seeded.map((s) => s.runId);

    await heartbeatAtCeilingOne.resumeQueuedRuns();
    expect(await waitForExecutionsOf(seededRunIds, 1)).toBe(true);

    const runs = await listRuns(companyId);
    const running = runs.filter((run) => run.status === "running");
    expect(running).toHaveLength(1);
    expect(running[0]?.id).toBe(seeded[0]?.runId);
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(SEEDED_AGENT_COUNT - 1);
    // Only one ticket may ever reach the adapter under a ceiling of one.
    expect(executionsOf(seededRunIds)).toEqual([seeded[0]?.runId]);
  }, 120_000);

  it("hands a freed slot to the longest-waiting ticket instead of the finishing agent", async () => {
    const { companyId, seeded } = await seedCompanyWithQueuedRuns();
    const seededRunIds = seeded.map((s) => s.runId);

    await heartbeatAtCeilingTwo.resumeQueuedRuns();
    expect(await waitForExecutionsOf(seededRunIds, 2)).toBe(true);
    const firstPass = await listRuns(companyId);
    expect(firstPass.filter((run) => run.status === "running")).toHaveLength(2);

    // The oldest ticket finishes; its agent has no further queued work, so the
    // sweep must give the free slot to the next-oldest ticket, which belongs to
    // a different agent.
    const oldestRunId = seeded[0]!.runId;
    await releaseExecution(oldestRunId);
    expect(
      await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, oldestRunId))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 30_000),
    ).toBe(true);

    await heartbeatAtCeilingTwo.resumeQueuedRuns();
    expect(await waitForExecutionsOf(seededRunIds, 3)).toBe(true);

    const runs = await listRuns(companyId);
    // Completing a run can make heartbeat enqueue a follow-up run of its own, so
    // the seeded tickets are asserted as a set rather than as the whole table.
    const seededRows = runs.filter((run) => seededRunIds.includes(run.id));
    const running = seededRows.filter((run) => run.status === "running");
    expect(seededRows).toHaveLength(SEEDED_AGENT_COUNT);
    expect(running).toHaveLength(2);
    // Tickets 1 and 2 are the oldest tickets still waiting.
    expect(running.map((run) => run.id).sort()).toEqual(
      [seeded[1]!.runId, seeded[2]!.runId].sort(),
    );
    expect(seededRows.filter((run) => run.status === "cancelled" || run.status === "failed")).toHaveLength(0);
    expect(seededRows.filter((run) => run.status === "queued")).toHaveLength(
      SEEDED_AGENT_COUNT - 2 - 1,
    );
    // Every ticket still exists: one finished, two running, three waiting.
    expect(
      seededRows.filter((run) => run.status === "succeeded").map((run) => run.id),
    ).toEqual([seeded[0]!.runId]);
    // The freed slot went to the oldest waiting ticket, not to the agent that
    // just finished, and that ticket really was dispatched.
    expect(executionsOf(seededRunIds)).toContain(seeded[2]!.runId);
  }, 120_000);

  it("drains a burst larger than the ceiling to completion with no lost ticket", async () => {
    const { companyId, seeded } = await seedCompanyWithQueuedRuns();
    const seededRunIds = seeded.map((s) => s.runId);

    // This test is about the queue draining, not about the cap: let executions
    // finish immediately and sweep repeatedly, as the 30 s scheduler tick does.
    blockExecutions = false;
    const drainDeadline = Date.now() + 45_000;
    while (Date.now() < drainDeadline) {
      await heartbeat.resumeQueuedRuns();
      if (await isIdle()) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const runs = await listRuns(companyId);
    const seededRows = runs.filter((row) => seededRunIds.includes(row.id));
    // Every ticket still exists and every one of them ran to completion.
    expect(seededRows.map((row) => row.id).sort()).toEqual(seededRunIds.slice().sort());
    expect(
      seededRows.filter((row) => row.status !== "succeeded"),
      `not drained: ${JSON.stringify(seededRows.filter((row) => row.status !== "succeeded"), null, 1)}`,
    ).toEqual([]);
    // Each ticket was dispatched at least once: none was silently discarded.
    const executed = new Set(executionsOf(seededRunIds));
    expect([...executed].sort()).toEqual(seededRunIds.slice().sort());
  }, 120_000);

  it("keeps every ticket when the ceiling is one and the backlog drains", async () => {
    const { companyId, seeded } = await seedCompanyWithQueuedRuns(3);

    await heartbeatAtCeilingOne.resumeQueuedRuns();
    expect(await waitForExecutionsOf(seeded.map((s) => s.runId), 1)).toBe(true);
    const firstPass = await listRuns(companyId);
    const runningIds = firstPass.filter((run) => run.status === "running").map((run) => run.id);
    expect(runningIds).toHaveLength(1);
    expect(runningIds[0]).toBe(seeded[0]!.runId);
    // The remaining two tickets are still queued, not cancelled.
    expect(firstPass.filter((run) => run.status === "queued")).toHaveLength(2);
    expect(firstPass.filter((run) => run.status === "cancelled")).toHaveLength(0);
    expect(firstPass.map((run) => run.id).sort()).toEqual(seeded.map((s) => s.runId).sort());
  }, 120_000);
});
