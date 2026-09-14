import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Backlog-sweep test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat queued-run backlog sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("heartbeat sweepQueuedRunBacklog", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-backlog-sweep-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Backlog-sweep test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();

    // Wait for in-flight heartbeat executions to settle so the deletes below
    // don't race a late row write. The sweep fires executeRun for each claimed
    // run; that work is in activeRunExecutionPromises until it finishes.
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activeRuns = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActive = activeRuns.some(
        (run) => run.status === "queued" || run.status === "running",
      );
      if (!hasActive) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await heartbeat.drainActiveRunExecutions();

    // TRUNCATE CASCADE clears every referencing row in one statement, so we
    // don't have to thread FK ordering through dozens of dependent tables.
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts?: {
    maxConcurrentRuns?: number;
    heartbeatEnabled?: boolean;
    heartbeatIntervalSec?: number;
    agentStatus?: "idle" | "active" | "running" | "paused";
    companyId?: string;
    agentName?: string;
  }) {
    const companyId = opts?.companyId ?? randomUUID();
    const agentId = randomUUID();
    if (!opts?.companyId) {
      await db.insert(companies).values({
        id: companyId,
        name: "Backlog Sweep Co",
        issuePrefix: `BS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts?.agentName ?? "Backlog Sweep Agent",
      role: "engineer",
      status: opts?.agentStatus ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: opts?.heartbeatEnabled ?? false,
          intervalSec: opts?.heartbeatIntervalSec ?? 0,
          wakeOnDemand: false,
          maxConcurrentRuns: opts?.maxConcurrentRuns ?? 3,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    createdAt: Date;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: "issue_assigned",
        responsibleUserId: "responsible-user",
      },
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    return id;
  }

  async function insertIssue(input: {
    companyId: string;
    agentId: string;
    status?: "todo" | "in_progress" | "blocked";
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Backlog Sweep Issue",
      status: input.status ?? "todo",
      priority: "medium",
      assigneeAgentId: input.agentId,
      responsibleUserId: "responsible-user",
    });
    return issueId;
  }

  // Read final statuses for the seeded runs after the sweep + drain.
  async function readFinalStatuses(runIds: string[]) {
    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArrayIds(runIds));
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  function inArrayIds(ids: string[]) {
    return inArray(heartbeatRuns.id, ids);
  }

  // At minimum: seed N queued runs on an agent with cap M < N and 0 running,
  // call the sweep, assert all M slots get filled. (CAN-3454 acceptance.)
  it("claims up to maxConcurrentRuns queued runs and leaves the rest queued", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      maxConcurrentRuns: 3,
    });
    const issueId = await insertIssue({ companyId, agentId });

    // 5 queued runs, oldest first. The cap is 3, so the sweep must claim the
    // 3 oldest and leave 2 queued.
    const baseTime = Date.now();
    const runIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      runIds.push(
        await insertQueuedRun({
          companyId,
          agentId,
          issueId,
          createdAt: new Date(baseTime - 10_000 + i * 1_000),
        }),
      );
    }

    const result = await heartbeat.sweepQueuedRunBacklog({ maxAgentsPerTick: 50 });

    // The sweep returns the cap-clamped claim count before executeRun fires
    // any cascading follow-up dispatches.
    expect(result.scanned).toBe(1);
    expect(result.claimed).toBe(3);

    // After the sweep, the 3 oldest runs left the queued state immediately.
    // The 2 newest runs stay queued (the cap is full and the sweep ran once).
    // We assert against the immediate post-sweep state without draining the
    // fire-and-forget executeRun promises, because each completion triggers
    // its own cascading dispatch and eventually claims the rest — that path
    // is the existing per-agent follow-up dispatch, not the sweep.
    const preDrainStatuses = await readFinalStatuses(runIds);
    const preDrainClaimedIds = runIds.filter(
      (id) => preDrainStatuses.get(id) !== "queued",
    );
    const preDrainQueuedIds = runIds.filter(
      (id) => preDrainStatuses.get(id) === "queued",
    );

    expect(new Set(preDrainClaimedIds)).toEqual(new Set(runIds.slice(0, 3)));
    expect(new Set(preDrainQueuedIds)).toEqual(new Set(runIds.slice(3)));
  });

  // After the first sweep fills the cap, a second sweep on the same agent
  // must not over-claim. The pre-filter on `running < maxConcurrentRuns` is
  // the contract; the test exercises that path explicitly.
  it("does not over-claim when the cap is already filled by the previous tick", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      maxConcurrentRuns: 2,
    });
    const issueId = await insertIssue({ companyId, agentId });

    const baseTime = Date.now();
    const runIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      runIds.push(
        await insertQueuedRun({
          companyId,
          agentId,
          issueId,
          createdAt: new Date(baseTime - 10_000 + i * 1_000),
        }),
      );
    }

    const first = await heartbeat.sweepQueuedRunBacklog({ maxAgentsPerTick: 50 });
    expect(first).toEqual({ scanned: 1, claimed: 2 });

    const second = await heartbeat.sweepQueuedRunBacklog({ maxAgentsPerTick: 50 });
    // The cap is now full. The pre-filter rejects the agent, so no claim happens.
    expect(second).toEqual({ scanned: 0, claimed: 0 });

    const preDrainStatuses = await readFinalStatuses(runIds);
    const claimedIds = runIds
      .filter((id) => preDrainStatuses.get(id) !== "queued")
      .sort();
    const stillQueuedIds = runIds
      .filter((id) => preDrainStatuses.get(id) === "queued")
      .sort();
    expect(claimedIds).toEqual([runIds[0], runIds[1]].sort());
    expect(stillQueuedIds).toEqual([runIds[2], runIds[3]].sort());
  });

  // An agent with no queued runs must be invisible to the sweep.
  it("returns zero when no agent has queued runs", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      maxConcurrentRuns: 5,
    });
    await insertIssue({ companyId, agentId });

    const result = await heartbeat.sweepQueuedRunBacklog({ maxAgentsPerTick: 50 });
    expect(result).toEqual({ scanned: 0, claimed: 0 });
  });

  // The oldest queued agent drains first when multiple agents are queued. The
  // sweep sorts by oldest queued run ascending.
  it("drains the oldest-queued agent first when multiple agents have queued runs", async () => {
    const { companyId, agentId: agentA } = await seedCompanyAndAgent({
      maxConcurrentRuns: 1,
      agentName: "Agent A",
    });
    // Same company, different agent — the multi-agent sweep case.
    const { agentId: agentB } = await seedCompanyAndAgent({
      maxConcurrentRuns: 1,
      companyId,
      agentName: "Agent B",
    });
    const issueA = await insertIssue({ companyId, agentId: agentA });
    const issueB = await insertIssue({ companyId, agentId: agentB });

    const baseTime = Date.now();
    // Agent A's queued run is newer than agent B's. B must drain first.
    const runA = await insertQueuedRun({
      companyId,
      agentId: agentA,
      issueId: issueA,
      createdAt: new Date(baseTime - 1_000),
    });
    const runB = await insertQueuedRun({
      companyId,
      agentId: agentB,
      issueId: issueB,
      createdAt: new Date(baseTime - 100_000),
    });

    // Cap the sweep at 1 agent per tick so only the oldest gets drained.
    const result = await heartbeat.sweepQueuedRunBacklog({ maxAgentsPerTick: 1 });
    expect(result).toEqual({ scanned: 1, claimed: 1 });

    const statuses = await readFinalStatuses([runA, runB]);
    // B is older, so it drained. A is still queued.
    expect(statuses.get(runB)).not.toBe("queued");
    expect(statuses.get(runA)).toBe("queued");
  });

  // A non-invokable agent (paused) must not be claimed, even with queued runs.
  it("skips non-invokable agents and does not claim their queued runs", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      maxConcurrentRuns: 3,
      agentStatus: "paused",
    });
    const issueId = await insertIssue({ companyId, agentId });

    const baseTime = Date.now();
    const runIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      runIds.push(
        await insertQueuedRun({
          companyId,
          agentId,
          issueId,
          createdAt: new Date(baseTime - 5_000 + i * 1_000),
        }),
      );
    }

    const result = await heartbeat.sweepQueuedRunBacklog({ maxAgentsPerTick: 50 });
    // The pre-filter rejects the agent, so the sweep returns no claim.
    expect(result.scanned).toBe(0);
    expect(result.claimed).toBe(0);

    const finalStatuses = await readFinalStatuses(runIds);
    // The runs were never promoted. Their status and timestamps are unchanged.
    for (const id of runIds) {
      const row = await db
        .select({
          status: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
          updatedAt: heartbeatRuns.updatedAt,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, id))
        .then((rows) => rows[0]);
      expect(row?.status).toBe("queued");
      expect(row?.createdAt.getTime()).toBe(row?.updatedAt.getTime());
    }
  });

  // The sweep is a no-op when scheduling suppression is active (task drain,
  // worktree suppression, etc.).
  it("returns zero when scheduling is suppressed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      maxConcurrentRuns: 3,
    });
    const issueId = await insertIssue({ companyId, agentId });
    await insertQueuedRun({
      companyId,
      agentId,
      issueId,
      createdAt: new Date(Date.now() - 5_000),
    });

    heartbeat.startTaskDrain({});
    try {
      const result = await heartbeat.sweepQueuedRunBacklog({ maxAgentsPerTick: 50 });
      expect(result).toEqual({ scanned: 0, claimed: 0 });

      const stillQueued = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "queued"),
          ),
        )
        .then((rows) => rows[0]?.count ?? 0);
      expect(stillQueued).toBe(1);
    } finally {
      heartbeat.stopTaskDrain();
    }
  });

  // The sweep tolerates maxAgentsPerTick=0 / negative values by treating them
  // as 1. A misconfigured scheduler can't strand the backlog.
  it("clamps a non-positive maxAgentsPerTick to one agent", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      maxConcurrentRuns: 1,
    });
    const issueId = await insertIssue({ companyId, agentId });
    await insertQueuedRun({
      companyId,
      agentId,
      issueId,
      createdAt: new Date(Date.now() - 5_000),
    });

    const result = await heartbeat.sweepQueuedRunBacklog({ maxAgentsPerTick: 0 });
    expect(result).toEqual({ scanned: 1, claimed: 1 });
  });
});
