import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// XIP-4907 / XIP-4690 — durable host-global concurrency gate for opencode_local.
// opencode_local agents all run on the same local host, so the per-agent run cap
// does nothing to bound cross-agent fan-out (the daily IP-collection routine
// dispatches ~6 distinct opencode_local researcher agents at once → thundering
// herd → host saturation). The gate caps the host-wide number of concurrently
// running opencode_local runs at PAPERCLIP_OPENCODE_LOCAL_MAX_CONCURRENT.

const { mockAdapterExecute, adapterControl } = vi.hoisted(() => {
  // `gate`, when set to a pending promise, blocks every adapter execution until it
  // resolves — used by the concurrency test to keep claimed runs in `running` for
  // the duration of a concurrent dispatch. Null (the default) resolves immediately.
  const adapterControl = { gate: null as Promise<void> | null };
  const mockAdapterExecute = vi.fn(async () => {
    if (adapterControl.gate) await adapterControl.gate;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Global-gate test run.",
      provider: "test",
      model: "test-model",
    };
  });
  return { mockAdapterExecute, adapterControl };
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres opencode_local global-gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

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

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function cleanupFixture(db: ReturnType<typeof createDb>) {
  // Heartbeat completion can write run/comment rows shortly after a run leaves
  // queued/running; retry the truncate once those late writes land.
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
      if (attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// Waits until no run is queued/running so late finalization settles before the
// fixture is truncated (avoids FK races during teardown).
async function waitForRunsToSettle(db: ReturnType<typeof createDb>) {
  let idlePolls = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    const active = runs.some((run) => run.status === "queued" || run.status === "running");
    if (!active) {
      idlePolls += 1;
      if (idlePolls >= 3) break;
    } else {
      idlePolls = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describeEmbeddedPostgres("heartbeat opencode_local host-global concurrency gate", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-opencode-gate-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    delete process.env.PAPERCLIP_OPENCODE_LOCAL_MAX_CONCURRENT;
    adapterControl.gate = null;
    // Drop any runs left queued by a gate test so settle observes an idle host.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "queued"));
    // Free the synthetic "running" fixtures so settle can observe an idle host
    // (these rows have no backing process and never finalize on their own).
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "running"));
    await waitForRunsToSettle(db);
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await cleanupFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, adapterType: string): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent-${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      // Generous per-agent cap so the per-agent gate never masks the host-global one.
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 20 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedRunningRun(companyId: string, agentId: string) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {},
    });
  }

  async function seedQueuedIssueRun(companyId: string, agentId: string) {
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued opencode_local work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
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
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return runId;
  }

  async function runStatus(runId: string): Promise<string | null> {
    const [row] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return row?.status ?? null;
  }

  it("holds a queued opencode_local run when the host is already at the global cap", async () => {
    process.env.PAPERCLIP_OPENCODE_LOCAL_MAX_CONCURRENT = "2";
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId, "opencode_local");
    const agentB = await seedAgent(companyId, "opencode_local");
    const agentC = await seedAgent(companyId, "opencode_local");

    // Host already saturated: two opencode_local runs running on distinct agents.
    await seedRunningRun(companyId, agentA);
    await seedRunningRun(companyId, agentB);

    const queuedRunId = await seedQueuedIssueRun(companyId, agentC);

    await heartbeat.resumeQueuedRuns();
    // Give any (incorrect) dispatch a chance to fire before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await runStatus(queuedRunId)).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("drains the held opencode_local run once a global slot frees", async () => {
    process.env.PAPERCLIP_OPENCODE_LOCAL_MAX_CONCURRENT = "2";
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId, "opencode_local");
    const agentB = await seedAgent(companyId, "opencode_local");
    const agentC = await seedAgent(companyId, "opencode_local");

    await seedRunningRun(companyId, agentA);
    await seedRunningRun(companyId, agentB);
    const queuedRunId = await seedQueuedIssueRun(companyId, agentC);

    await heartbeat.resumeQueuedRuns();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await runStatus(queuedRunId)).toBe("queued");

    // Free one global slot: mark agentA's running run finished.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentA)));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await runStatus(queuedRunId)) === "succeeded");

    expect(await runStatus(queuedRunId)).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("does not apply the global gate to non-opencode_local adapters", async () => {
    process.env.PAPERCLIP_OPENCODE_LOCAL_MAX_CONCURRENT = "2";
    const companyId = await seedCompany();
    // Two opencode_local runs already running would trip the gate for an
    // opencode_local agent, but a codex_local agent must be unaffected.
    const ocA = await seedAgent(companyId, "opencode_local");
    const ocB = await seedAgent(companyId, "opencode_local");
    await seedRunningRun(companyId, ocA);
    await seedRunningRun(companyId, ocB);

    const codexAgent = await seedAgent(companyId, "codex_local");
    const queuedRunId = await seedQueuedIssueRun(companyId, codexAgent);

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await runStatus(queuedRunId)) === "succeeded");

    expect(await runStatus(queuedRunId)).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("never exceeds the global cap under concurrent cross-agent dispatch (TOCTOU)", async () => {
    // Regression for XIP-4911: the gate's check (count running) and claim (status
    // write) are separate awaited DB ops. Before the advisory-lock serialization,
    // N agents dispatching concurrently all observed the same pre-claim count of 0,
    // all passed the gate, and all claimed — overshooting the cap by up to N×. This
    // test starts from an idle host and dispatches every agent concurrently (true
    // interleaving), which resumeQueuedRuns' sequential loop never exercises.
    process.env.PAPERCLIP_OPENCODE_LOCAL_MAX_CONCURRENT = "2";
    const companyId = await seedCompany();

    const agentIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const agentId = await seedAgent(companyId, "opencode_local");
      agentIds.push(agentId);
      await seedQueuedIssueRun(companyId, agentId);
    }

    // Block adapter execution so every claimed run stays `running` for the whole
    // dispatch — otherwise a fast-finishing run frees a slot and masks an over-claim.
    let release!: () => void;
    adapterControl.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      // Dispatch all agents concurrently — this is the interleaving the race needs.
      await Promise.all(agentIds.map((id) => heartbeat.startNextQueuedRunForAgent(id)));
      // Give any racy over-claim a chance to materialize before asserting.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const running = runs.filter((run) => run.status === "running").length;
      const queued = runs.filter((run) => run.status === "queued").length;

      // The cap is 2: exactly two runs claimed, the other three held queued.
      expect(running).toBeLessThanOrEqual(2);
      expect(running).toBe(2);
      expect(queued).toBe(3);
    } finally {
      release();
      adapterControl.gate = null;
    }

    // Let the two running runs drain so afterEach teardown sees an idle host.
    await waitForCondition(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return runs.every((run) => run.status !== "running");
    });
  });
});
