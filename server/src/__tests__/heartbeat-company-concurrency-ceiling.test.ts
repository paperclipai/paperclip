import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// GRO-60/GRO-73: companies.maxConcurrentAgentRuns is a company-wide ceiling on
// simultaneously "running" heartbeat runs across every agent, enforced in
// startNextQueuedRunForAgent alongside (never instead of) each agent's own
// heartbeat.maxConcurrentRuns cap. These tests exercise that gate through the
// public resumeQueuedRuns() entrypoint so they cover the real dispatch path
// rather than calling the internal function directly.

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Company concurrency ceiling test run.",
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
    `Skipping embedded Postgres company concurrency ceiling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("heartbeat company-wide concurrency ceiling", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-company-ceiling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(maxConcurrentAgentRuns: number | null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      maxConcurrentAgentRuns,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, maxConcurrentRuns = 5) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns },
      },
      permissions: {},
    });
    return agentId;
  }

  async function seedRunningRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "test-fixture",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {},
    });
    return runId;
  }

  async function seedQueuedRun(companyId: string, agentId: string) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "test-fixture",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "test-fixture",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return runId;
  }

  async function statusOf(runId: string) {
    const [run] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return run?.status;
  }

  it("blocks a second agent's dispatch once another agent's running run exhausts the company ceiling", async () => {
    const companyId = await seedCompany(1);
    const agentA = await seedAgent(companyId, "Agent-Alpha");
    const agentB = await seedAgent(companyId, "Agent-Beta");
    await seedRunningRun(companyId, agentA);
    const queuedRunId = await seedQueuedRun(companyId, agentB);

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await statusOf(queuedRunId)).toBe("queued");
  });

  it("dispatches normally across agents when no company-wide ceiling is set", async () => {
    const companyId = await seedCompany(null);
    const agentA = await seedAgent(companyId, "Agent-Alpha");
    const agentB = await seedAgent(companyId, "Agent-Beta");
    await seedRunningRun(companyId, agentA);
    const queuedRunId = await seedQueuedRun(companyId, agentB);

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(await statusOf(queuedRunId)).not.toBe("queued");
  });

  it("still enforces each agent's own concurrency cap when the company ceiling is generous (no regression)", async () => {
    const companyId = await seedCompany(10);
    const agentA = await seedAgent(companyId, "Agent-Alpha", 1);
    await seedRunningRun(companyId, agentA);
    const queuedRunId = await seedQueuedRun(companyId, agentA);

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await statusOf(queuedRunId)).toBe("queued");
  });

  it("cross-agent slot handoff: freeing a slot via run cancellation dispatches another agent's queued run", async () => {
    // GRO-93: when a run completes/cancels, the freed slot must be offered to other
    // agents in the same company — not only to the completing agent's own queue.
    const companyId = await seedCompany(1);
    const agentA = await seedAgent(companyId, "Agent-Alpha");
    const agentB = await seedAgent(companyId, "Agent-Beta");
    const agentARunId = await seedRunningRun(companyId, agentA);
    const agentBQueuedId = await seedQueuedRun(companyId, agentB);

    // Verify the ceiling blocks agentB before the slot is freed.
    await heartbeat.resumeQueuedRuns();
    expect(await statusOf(agentBQueuedId)).toBe("queued");

    // Cancel agentA's run — frees the company slot and should trigger cross-agent
    // handoff so agentB does not have to wait for the next resumeQueuedRuns tick.
    await heartbeat.cancelRun(agentARunId, "test: freeing slot for cross-agent handoff");

    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(await statusOf(agentBQueuedId)).not.toBe("queued");
  });

  it("stale-row starvation guard: orphaned running rows do not permanently block company dispatch", async () => {
    // GRO-93: a 'running' row whose process died without being reaped must not
    // prevent legitimate queued work from dispatching. The dispatch path reaps
    // orphaned rows when the ceiling appears full, so the count is accurate.
    const companyId = await seedCompany(1);
    const agentA = await seedAgent(companyId, "Agent-Alpha");
    const agentB = await seedAgent(companyId, "Agent-Beta");
    // agentA's running row is NOT added to runningProcesses — simulates an
    // orphaned run (died before being reaped).
    await seedRunningRun(companyId, agentA);
    const agentBQueuedId = await seedQueuedRun(companyId, agentB);

    // Without the stale-row guard, agentA's orphaned row counts against the
    // ceiling and keeps agentB stranded even though no real run is active.
    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(await statusOf(agentBQueuedId)).not.toBe("queued");
  });
});
